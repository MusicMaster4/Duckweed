const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { codexWindows, claudeWindows, normalizedWindows, xaiWindows, timestamp, retryAfterMs, failureState, shouldProbe, rankAccounts } = require('./quota.cjs');

test('routing spends five-hour balances first, then the closest weekly reset', () => {
  const weekly = { name: 'weekly', available: true, weeklyResetAt: '2026-10-03T00:00:00Z', windows: [] };
  const fiveLater = { name: 'five-later', available: true, weeklyResetAt: '2026-10-06T00:00:00Z', windows: [{ id: 'main-primary', label: '5 hours', remainingPercent: 60 }] };
  const fiveEarlier = { ...fiveLater, name: 'five-earlier', weeklyResetAt: '2026-10-05T00:00:00Z' };
  const extra = { ...weekly, name: 'extra-model-only', weeklyResetAt: '2026-10-04T00:00:00Z', windows: [{ id: 'review-primary', label: '5 hours', remainingPercent: 100 }] };
  const exhausted = { ...fiveEarlier, name: 'exhausted', available: false, windows: [{ id: 'main-primary', label: '5 hours', remainingPercent: 0 }] };
  const paused = { ...fiveEarlier, name: 'paused', disabled: true };
  const unknown = { ...weekly, name: 'unknown', available: null };
  assert.deepEqual(rankAccounts([weekly, fiveLater, exhausted, paused, extra, unknown, fiveEarlier]).map(a => a.name),
    ['five-earlier', 'five-later', 'weekly', 'extra-model-only', 'exhausted']);
  fiveEarlier.available = false;
  fiveLater.available = false;
  assert.equal(rankAccounts([fiveEarlier, fiveLater, weekly])[0].name, 'weekly');
  const claude = { ...fiveLater, name: 'claude', available: true, windows: [{ id: 'five_hour', label: '5 hours', remainingPercent: 1 }] };
  assert.equal(rankAccounts([weekly, claude])[0].name, 'claude');
});

test('quota parsing preserves exhausted, unknown and provider-specific windows', () => {
  assert.equal(timestamp(null), null);
  assert.equal(timestamp(1791000000), '2026-10-03T04:00:00.000Z');
  const c = codexWindows({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1791000000 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1791000000 } },
    additional_rate_limits: { review: { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } } } });
  assert.deepEqual(c.windows.map(w => w.remainingPercent), [100, 0, 0]);
  assert.equal(c.available, false);
  assert.equal(c.windows[0].label, '5 hours');
  const healthy = codexWindows({ rate_limit: { primary_window: { used_percent: 1 } }, additional_rate_limits: { extra: { primary_window: { used_percent: 100 } } } });
  assert.equal(healthy.available, true, 'a separate model limit cannot exhaust the whole provider');
  assert.equal(claudeWindows({ five_hour: { utilization: 100, resets_at: null }, seven_day: { utilization: 40 } }).available, false);
  const n = normalizedWindows({ groups: [{ displayName: 'Models', buckets: [{ remainingFraction: 0, resetTime: '2026-10-03T00:00:00Z' }, { window: 'Weekly' }] }] });
  assert.deepEqual(n.windows.map(w => w.remainingPercent), [0, null]);
  assert.equal(xaiWindows([{ config: { creditUsagePercent: '25', currentPeriod: { end: '2026-10-03T00:00:00Z' } } }]).windows[0].remainingPercent, 75);
});

test('automatic refresh respects rate limits and keeps provider retry delays', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.equal(retryAfterMs({ 'Retry-After': ['1800'] }, now), 1800000);
  assert.equal(retryAfterMs({ 'retry-after': 'Sat, 03 Oct 2026 00:20:00 GMT' }, now), 1200000);
  const error = Object.assign(new Error('Quota update returned HTTP 429.'), { status: 429, retryAfterMs: 1800000 });
  const first = failureState(error, null, 'claude', now);
  assert.equal(first.retryAt, '2026-10-03T00:30:00.000Z');
  assert.equal(shouldProbe(first, 'claude', now + 120000), false);
  assert.equal(shouldProbe({ checkedAt: new Date(now).toISOString() }, 'claude', now + 61000), false);
  assert.equal(shouldProbe({ checkedAt: new Date(now).toISOString() }, 'claude', now + 600000), true);
  const repeated = failureState(Object.assign(new Error('HTTP 429'), { status: 429 }), { rateLimitFailures: 2 }, 'claude', now);
  assert.equal(repeated.retryAt, '2026-10-03T00:40:00.000Z');
});

test('account panel keeps multiple accounts and keys, protects secrets and enforces local access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-dashboard-test-'));
  fs.writeFileSync(path.join(root, '.management-key'), 'test-management-password');
  fs.writeFileSync(path.join(root, '.api-key'), 'test-client-key');
  let files = [
    { name: 'first.json', auth_index: 'first', provider: 'claude', email: 'first@example.test', status: 'active', disabled: false, priority: 1 },
    { name: 'second.json', auth_index: 'second', provider: 'claude', email: 'second@example.test', status: 'active', disabled: false, priority: 0 },
  ];
  const config = { 'openai-compatibility': [{ name: 'Existing', 'base-url': 'https://example.test/v1', 'api-key-entries': [{ 'api-key': 'upstream-secret-one' }], models: [{ name: 'test-model', alias: 'test-model' }] }] };
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const data = raw ? JSON.parse(raw) : null;
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/v1/models') return send({ data: [{ id: 'test-model', owned_by: 'fixture' }] });
    if (route === '/v0/management/auth-files') return send({ files });
    if (route === '/v0/management/config') return send(config);
    if (route === '/v8/management/plugins') return send({ plugins: [] });
    if (route === '/v0/management/api-call') {
      assert.equal(data.header.Authorization, 'Bearer $TOKEN$');
      return send({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: data.auth_index === 'first' ? 20 : 80, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 50, resets_at: '2030-01-02T00:00:00Z' } }) });
    }
    if (route === '/v0/management/auth-files/fields') return send({ status: 'ok' });
    if (route === '/v0/management/auth-files/status') { files.find(a => a.name === data.name).disabled = data.disabled; return send({ status: 'ok' }); }
    if (route === '/v0/management/openai-compatibility') {
      if (req.method === 'PUT') config['openai-compatibility'] = data;
      return send({ 'openai-compatibility': config['openai-compatibility'] });
    }
    if (route === '/v8/management/oauth/auth-url') return send({ url: 'https://accounts.example.test/login', state: 'fixture-state' });
    if (route === '/v0/management/get-auth-status') {
      if (!files.some(a => a.auth_index === 'third')) files.push({ name: 'third.json', auth_index: 'third', provider: 'claude', email: 'third@example.test', disabled: false, status: 'active' });
      return send({ status: 'ok' });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { env: { ...process.env, CLIPROXY_HOME: root,
    CLIPROXY_API_URL: `http://127.0.0.1:${upstream.address().port}`, CLIPROXY_DASHBOARD_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: 'Bearer test-management-password', 'Content-Type': 'application/json' };
  const call = async (route, body) => {
    const response = await fetch(base + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  try {
    await once(child.stdout, 'data');
    assert.equal((await fetch(base + '/local/status')).status, 401);
    assert.equal((await fetch(base + '/local/status', { headers: { ...headers, Origin: 'https://untrusted.example.test' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const request = http.get(base + '/local/status', { headers: { ...headers, Host: 'untrusted.example.test' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(badHost, 403);
    const first = await call('/local/refresh', {});
    assert.equal(first.accounts.length, 2);
    assert.deepEqual(first.accounts.map(a => a.windows[0].remainingPercent), [80, 20]);
    const serialized = JSON.stringify(first);
    for (const secret of ['test-management-password', 'test-client-key', 'upstream-secret-one']) assert.ok(!serialized.includes(secret));
    const paused = await call('/local/account', { id: 'second', disabled: true });
    assert.equal(paused.accounts.find(a => a.id === 'second').disabled, true);
    await call('/local/connect', { provider: 'openai-compatible', name: 'Existing', baseUrl: 'https://example.test/v1', apiKey: 'upstream-secret-two', models: ['test-model', 'new-model'] });
    assert.equal(config['openai-compatibility'].length, 1);
    assert.deepEqual(config['openai-compatibility'][0]['api-key-entries'].map(k => k['api-key']), ['upstream-secret-one', 'upstream-secret-two']);
    assert.equal(config['openai-compatibility'][0].models.length, 2);
    assert.equal((await call('/local/login', { provider: 'claude' })).state, 'fixture-state');
    assert.equal((await call('/local/login-status?state=fixture-state')).status, 'ok');
    assert.equal((await call('/local/status')).accounts.length, 3);
    const landing = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.get('location'), `http://127.0.0.1:${upstream.address().port}/management.html`);
    assert.equal((await fetch(base + '/accounts')).status, 200);
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    await new Promise(resolve => upstream.close(resolve));
    const absolute = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(absolute).toLowerCase() !== parent.toLowerCase() || !path.basename(absolute).startsWith('cliproxy-dashboard-test-')) throw new Error('Unsafe temporary cleanup target.');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
