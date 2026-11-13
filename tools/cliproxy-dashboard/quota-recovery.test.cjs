const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { canRecoverQuota, recoverQuotaCooldown } = require('./quota-recovery.cjs');
const { codexWindows } = require('./quota.cjs');

function fixture() {
  const now = Date.now();
  const source = { auth_index: 'recovered-account', provider: 'codex', status: 'error', disabled: false,
    quota: { observed_at: new Date(now - 3600000).toISOString() },
    cooldowns: [
      { scope: 'credential', reason: 'credential_quota', remaining_seconds: 432000 },
      { scope: 'model', model_key: 'gpt-6.1-sol', reason: 'quota', http_status: 429, remaining_seconds: 432000 },
    ] };
  const usage = { rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: (now + 18000000) / 1000 },
    secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: (now + 604800000) / 1000 } } };
  const observation = { ...codexWindows(usage), error: null,
    attemptedAt: new Date(now - 1000).toISOString(), checkedAt: new Date(now).toISOString() };
  return { now, source, observation, usage };
}

test('a reset quota releases a five-day credential cooldown through the native API', async () => {
  const { source, observation } = fixture();
  const calls = [];
  const management = async (...args) => {
    calls.push(args);
    return args[0] === '/auth-files' ? { files: [source] } : { status: 'ok', models: ['gpt-6.1-sol'] };
  };
  assert.equal(await recoverQuotaCooldown(source, observation, management), true);
  assert.deepEqual(calls, [['/auth-files'], ['/v8/management/routing/cooldown/reset', 'POST', { auth_index: source.auth_index }]]);
  assert.equal(observation.status, 'active');
  assert.ok(observation.cooldownResetAt);
});

test('cached, failed, exhausted, unknown, or expired quota cannot release a cooldown', () => {
  const { source, observation, now } = fixture();
  const variants = [
    { attemptedAt: new Date(now - 61000).toISOString() },
    { attemptedAt: null }, { error: 'Quota update returned HTTP 429.' }, { available: false },
    { windows: [] },
    { windows: observation.windows.map(w => ({ ...w, remainingPercent: null })) },
    { windows: observation.windows.map(w => ({ ...w, remainingPercent: 0 })) },
    { windows: observation.windows.map(w => ({ ...w, resetAt: new Date(now - 1).toISOString() })) },
    { windows: [...observation.windows, { id: 'spark-primary', remainingPercent: 0 }] },
  ];
  for (const variant of variants) assert.equal(canRecoverQuota(source, { ...observation, ...variant }, now), false, JSON.stringify(variant));
});

test('paused credentials, model-only limits, and authentication cooldowns are preserved', () => {
  const { source, observation, now } = fixture();
  for (const variant of [
    { disabled: true }, { provider: 'claude' }, { cooldowns: [] },
    { cooldowns: [source.cooldowns[1]] },
    { cooldowns: [...source.cooldowns, { reason: 'error', http_status: 401, remaining_seconds: 60 }] },
  ]) assert.equal(canRecoverQuota({ ...source, ...variant }, observation, now), false);
});

test('a concurrent inference failure, pause, or removal prevents an obsolete reset', async () => {
  for (const change of ['newer-limit', 'paused', 'removed', 'already-recovered']) {
    const { source, observation } = fixture();
    const current = structuredClone(source);
    if (change === 'newer-limit') current.quota.observed_at = new Date().toISOString();
    if (change === 'paused') current.disabled = true;
    if (change === 'already-recovered') current.cooldowns = [];
    const calls = [];
    assert.equal(await recoverQuotaCooldown(source, observation, async route => {
      calls.push(route);
      return { files: change === 'removed' ? [] : [current] };
    }), false);
    assert.deepEqual(calls, ['/auth-files']);
  }
});

test('upstream denial and missing usage values are not interpreted as available quota', () => {
  const { usage } = fixture();
  assert.equal(codexWindows(usage).available, true);
  for (const change of [{ allowed: false }, { limit_reached: true },
    { primary_window: { ...usage.rate_limit.primary_window, used_percent: null } }]) {
    assert.equal(codexWindows({ rate_limit: { ...usage.rate_limit, ...change } }).available, false);
  }
});

test('the scheduled quota refresh reconciles fresh quota with routing, without resetting exhausted accounts', async () => {
  const { source, usage } = fixture();
  const recovered = { ...source, name: 'recovered.json', priority: 2 };
  const exhausted = { ...source, auth_index: 'exhausted-account', name: 'exhausted.json', priority: -100 };
  const files = [recovered, exhausted];
  const resets = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v0/management/auth-files') return res.end(JSON.stringify({ files }));
    if (req.url === '/v0/management/api-call') {
      const result = structuredClone(usage);
      if (body.auth_index === exhausted.auth_index) {
        result.rate_limit.secondary_window.used_percent = 100;
        result.rate_limit.allowed = false;
        result.rate_limit.limit_reached = true;
      }
      return res.end(JSON.stringify({ status_code: 200, body: JSON.stringify(result) }));
    }
    if (req.url === '/v8/management/routing/cooldown/reset') {
      resets.push(body.auth_index); recovered.cooldowns = []; recovered.status = 'active';
      return res.end(JSON.stringify({ status: 'ok', models: ['gpt-6.1-sol'] }));
    }
    res.writeHead(404); res.end('{}');
  });
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-quota-recovery-'));
  try {
    fs.mkdirSync(path.join(root, 'auth'));
    for (const file of files) fs.writeFileSync(path.join(root, 'auth', file.name), '{}');
    fs.writeFileSync(path.join(root, '.management-key'), 'local-test-key');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const run = async () => {
      const child = spawn(process.execPath, [path.join(__dirname, 'quota.cjs'), '--quiet'], {
        env: { ...process.env, CLIPROXY_HOME: root, CLIPROXY_API_URL: `http://127.0.0.1:${server.address().port}` },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
      const [code] = await once(child, 'close'); assert.equal(code, 0, errors);
      return JSON.parse(fs.readFileSync(path.join(root, 'priority-status.json'), 'utf8'));
    };
    const state = await run();
    assert.deepEqual(resets, [recovered.auth_index]);
    assert.equal(state.accounts[0].status, 'active');
    assert.ok(state.accounts[0].cooldownResetAt);
    assert.equal(state.accounts[1].available, false);
    await run();
    assert.deepEqual(resets, [recovered.auth_index], 'cached refresh must not reset routing again');
  } finally {
    await new Promise(resolve => server.close(resolve));
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('cliproxy-quota-recovery-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});
