const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { failureState, retryAfterMs, shouldProbe } = require('./quota.cjs');
const { claudeCacheResult } = require('./claude-cache.cjs');
const { patchHtml } = require('./patch-management.cjs');

test('Claude retry deadlines survive repeated refreshes and a zero Retry-After', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const rateLimit = Object.assign(new Error('Quota update returned HTTP 429.'), { status: 429, retryAfterMs: 0 });
  let old = { checkedAt: new Date(now - 3600000).toISOString() };
  for (const minutes of [10, 20, 40, 60, 60]) {
    old = { ...old, ...failureState(rateLimit, old, 'claude', now) };
    assert.equal(Date.parse(old.retryAt) - now, minutes * 60000);
    assert.equal(shouldProbe(old, 'claude', now + minutes * 60000 - 1), false);
    assert.equal(shouldProbe(old, 'claude', now + minutes * 60000), true);
  }
  assert.equal(retryAfterMs({ 'rEtRy-AfTeR': ['0'] }, now), 0);
  assert.equal(retryAfterMs({ 'Retry-After': ['7200'] }, now), 7200000);
  assert.equal(retryAfterMs({ 'Retry-After': 'Fri, 02 Oct 2026 12:00:00 GMT' }, now), 7200000);
  assert.equal(retryAfterMs({ 'Retry-After': 'invalid' }, now), 0);
  assert.equal(Date.parse(failureState({ ...rateLimit, message: rateLimit.message, retryAfterMs: 7200000 }, {}, 'claude', now).retryAt) - now, 7200000);
  assert.equal(shouldProbe({ checkedAt: new Date(now).toISOString() }, 'claude', now + 599999), false);
  assert.equal(shouldProbe({ checkedAt: new Date(now).toISOString() }, 'claude', now + 600000), true);
});

test('legacy cached windows keep their measured values and are labeled cached', () => {
  const result = claudeCacheResult({ checkedAt: '2026-10-02T09:00:00Z', error: 'Quota update returned HTTP 429.',
    retryAt: '2026-10-02T11:00:00Z', windows: [{ id: 'five_hour', remainingPercent: 97, resetAt: '2026-10-02T14:59:59Z' }] });
  assert.equal(result.status_code, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.five_hour.utilization, 3);
  assert.equal(body._duckweed_cache.cached, true);
  assert.equal(body._duckweed_cache.checkedAt, '2026-10-02T09:00:00Z');
  assert.equal(claudeCacheResult({ errorStatus: 429, error: 'HTTP 429', windows: [] }).status_code, 429);
});

test('both panels share one quota cache and cannot override its cooldown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-quota-cache-test-'));
  fs.writeFileSync(path.join(root, '.management-key'), 'fixture-management-key');
  fs.writeFileSync(path.join(root, '.api-key'), 'fixture-api-key');
  const statePath = path.join(root, 'priority-status.json');
  const oldAccount = { id: 'claude-fixture', name: 'claude.json', provider: 'claude', checkedAt: new Date(Date.now() - 3600000).toISOString(),
    error: 'Quota update returned HTTP 429.', errorStatus: 429, rateLimitFailures: 1, retryAt: new Date(Date.now() + 600000).toISOString(),
    windows: [{ id: 'five_hour', remainingPercent: 97, resetAt: null }], quotaSupported: true };
  fs.writeFileSync(statePath, JSON.stringify({ accounts: [oldAccount] }));
  let calls = 0, rateLimited = true;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain fixture request bodies. */ }
    let data;
    if (req.url === '/v0/management/auth-files') data = { files: [{ auth_index: 'claude-fixture', name: 'claude.json', provider: 'claude', status: 'active', disabled: false }] };
    else if (req.url === '/v0/management/api-call') {
      calls++;
      data = rateLimited ? { status_code: 429, header: { 'Retry-After': ['0'] }, body: '{"error":{"message":"Rate limited"}}' }
        : { status_code: 200, header: {}, body: JSON.stringify({ five_hour: { utilization: 4, resets_at: null }, extra_usage: { is_enabled: false } }) };
    } else if (req.url === '/v0/management/auth-files/fields') data = {};
    else { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { env: { ...process.env,
    CLIPROXY_HOME: root, CLIPROXY_API_URL: `http://127.0.0.1:${upstream.address().port}`, CLIPROXY_DASHBOARD_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const endpoint = `http://127.0.0.1:${port}/local/claude-quota`;
  const headers = { Authorization: 'Bearer fixture-management-key', 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8317' };
  const request = () => fetch(endpoint, { method: 'POST', headers, body: '{"authIndex":"claude-fixture"}' });
  try {
    for (let i = 0; i < 100 && !output.includes('CLIProxy account panel:'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(output.includes('CLIProxy account panel:'), output);
    const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' }, body: '{}' })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: headers.Origin }, body: '{}' })).status, 401);
    for (let i = 0; i < 3; i++) {
      const response = await request(); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.status_code, 200);
      assert.equal(JSON.parse(result.body)._duckweed_cache.cached, true);
    }
    assert.equal(calls, 0, 'loading and refreshing the UI must not bypass the retry deadline');
    const expired = JSON.parse(fs.readFileSync(statePath)); expired.accounts[0].retryAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(expired));
    const limited = await (await request()).json();
    assert.equal(limited.status_code, 200, 'rate limited updates preserve last good readings');
    assert.equal(calls, 1);
    const cooling = JSON.parse(fs.readFileSync(statePath));
    assert.equal(cooling.accounts[0].rateLimitFailures, 2);
    assert.ok(Date.parse(cooling.accounts[0].retryAt) - Date.now() > 19 * 60000);
    await request(); assert.equal(calls, 1);
    rateLimited = false;
    cooling.accounts[0].retryAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(cooling));
    const recovered = JSON.parse((await (await request()).json()).body);
    assert.equal(calls, 2); assert.equal(recovered.five_hour.utilization, 4);
    assert.equal(recovered._duckweed_cache.error, null);
    assert.deepEqual(recovered.extra_usage, { is_enabled: false });
    assert.equal(JSON.parse(fs.readFileSync(statePath)).accounts[0].rateLimitFailures, 0);
    await request(); assert.equal(calls, 2, 'successful readings are cached for ten minutes');
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    await new Promise(resolve => upstream.close(resolve));
    const target = fs.realpathSync(root), temporaryRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(target).toLowerCase(), temporaryRoot.toLowerCase());
    assert.ok(path.basename(target).startsWith('cliproxy-quota-cache-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('native management patch is idempotent, fails safely and has valid JavaScript', () => {
  const html = fs.readFileSync(path.join(os.homedir(), '.cli-proxy-api', 'static', 'management.html'), 'utf8');
  const patched = patchHtml(html);
  assert.equal(patchHtml(patched), patched);
  assert.throws(() => patchHtml('<html><head></head><body></body></html>'), /left unchanged/);
  const script = [...patched.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('type="module"'))?.[2];
  assert.ok(script, 'the standalone management UI module must be present');
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(patched.includes('children:globalThis.duckweedQuotaNote(e.localCache)'));
});
