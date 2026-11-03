const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quotaCooldowns, usableQuota, reconcileClaudeCooldown } = require('./cooldown-recovery.cjs');
const now = Date.now();
const account = () => ({ auth_index: 'fixture', provider: 'claude', disabled: false,
  cooldowns: [{ scope: 'credential', reason: 'credential_quota', retry_at: new Date(now + 3600000).toISOString() },
    { scope: 'model', model_key: 'claude-opus-5-5', reason: 'quota', http_status: 429, retry_at: new Date(now + 3600000).toISOString() }],
  quota: { observed_at: new Date(now - 60000).toISOString() } });
const observation = () => ({ provider: 'claude', available: true, checkedAt: new Date(now).toISOString(),
  windows: [{ id: 'seven_day', remainingPercent: 100 }], usage: { five_hour: null, seven_day: { utilization: 0 } } });
function fixture(file = account(), fail = false) {
  const resets = [], calls = [];
  return { resets, calls, management: async (route, method, body) => {
    calls.push(route);
    if (route === '/auth-files') return { files: [file] };
    assert.equal(route, '/v8/management/routing/cooldown/reset');
    assert.equal(method, 'POST'); assert.deepEqual(body, { auth_index: 'fixture' });
    if (fail) throw Error('Local reset failed');
    resets.push(body); return { status: 'ok' };
  } };
}

test('upgrade reconciles an existing Claude quota gate once, without resetting another credential', async () => {
  const fresh = observation(), f = fixture();
  const recovered = await reconcileClaudeCooldown(account(), { available: false }, fresh, now, f.management);
  assert.ok(recovered.resetAt); assert.equal(f.resets.length, 1);
  const old = { ...fresh, routingRecovery: recovered };
  await reconcileClaudeCooldown(account(), old, fresh, now, f.management);
  assert.equal(f.resets.length, 1, 'identical quota cannot repeatedly bypass a real rate limit');
  const spent = observation(); spent.windows[0].remainingPercent = 90; spent.usage.seven_day.utilization = 10;
  await reconcileClaudeCooldown(account(), old, spent, now, f.management);
  assert.equal(f.resets.length, 1, 'spending quota is not evidence of recovery');
  const restored = observation();
  await reconcileClaudeCooldown(account(), { ...spent, routingRecovery: recovered }, restored, now, f.management);
  assert.equal(f.resets.length, 2, 'a subsequent quota increase allows another reconciliation');
});

test('fresh null session window can recover a previously used session after an upgrade', async () => {
  const f = fixture(), fresh = observation();
  await reconcileClaudeCooldown(account(), { ...fresh, usage: { ...fresh.usage, five_hour: { utilization: 98 } },
    routingRecovery: { checkedAt: fresh.checkedAt } }, fresh, now, f.management);
  assert.equal(f.resets.length, 1);
});

test('inconclusive, exhausted, disabled and failed quota observations cannot release gates', async () => {
  const cases = [
    { checkedAt: null }, { checkedAt: new Date(now - 61000).toISOString() },
    { windows: [{ id: 'seven_day', remainingPercent: 100, resetAt: new Date(now - 1000).toISOString() }] },
    { available: false }, { error: 'HTTP 429' }, { disabled: true }, { provider: 'codex' },
    { usage: { seven_day: { utilization: 0 } } },
    { usage: { five_hour: null, seven_day: { utilization: 100 } } },
    { usage: { five_hour: { utilization: NaN }, seven_day: { utilization: 0 } } },
    { usage: { five_hour: null, seven_day: { utilization: 0, locked_reason: 'restricted' } } },
    { usage: { five_hour: null, seven_day: { utilization: 0 }, limits: [{ is_active: true, percent: 100 }] } },
    { windows: [{ id: 'seven_day', remainingPercent: 100 }, { id: 'seven_day_opus', remainingPercent: 0 }] },
  ];
  for (const changed of cases) {
    const fresh = { ...observation(), ...changed }, f = fixture();
    assert.equal(usableQuota(fresh), false);
    await reconcileClaudeCooldown(account(), {}, fresh, now, f.management);
    assert.equal(f.calls.length, 0);
  }
});

test('mixed gates, unknown scheduler state and pauses cannot be cleared by the account-wide endpoint', async () => {
  for (const changed of [{ cooldowns: null }, { cooldowns: [] }, { disabled: true },
    { cooldowns: [{ reason: 'quota', http_status: 403, retry_at: new Date(now + 3600000).toISOString() }] },
    { cooldowns: [...account().cooldowns, { reason: 'unauthorized', retry_at: new Date(now + 3600000).toISOString() }] }]) {
    const file = { ...account(), ...changed }, f = fixture();
    assert.equal(quotaCooldowns(file), false);
    await reconcileClaudeCooldown(file, {}, observation(), now, f.management);
    assert.equal(f.calls.length, 0);
  }
});

test('concurrent failures or pauses take precedence over an earlier quota probe', async () => {
  for (const changed of [ { disabled: true }, { auth_index: 'other' },
    { quota: { observed_at: new Date(now + 1).toISOString() } },
    { model_quotas: { opus: { observed_at: new Date(now + 1).toISOString() } } },
    { cooldowns: [{ ...account().cooldowns[0], retry_at: new Date(now + 7200000).toISOString() }] } ]) {
    const f = fixture({ ...account(), ...changed });
    await reconcileClaudeCooldown(account(), {}, observation(), now, f.management);
    assert.equal(f.resets.length, 0);
  }
});

test('failed local repairs preserve quota and retry on the next fresh observation', async () => {
  const fresh = observation(), failed = fixture(account(), true);
  const recovery = await reconcileClaudeCooldown(account(), {}, fresh, now, failed.management);
  assert.match(recovery.error, /Local reset failed/); assert.equal(recovery.resetAt, null);
  assert.equal(fresh.available, true); assert.equal(fresh.error, undefined);
  const f = fixture();
  const retried = await reconcileClaudeCooldown(account(), { ...fresh, routingRecovery: recovery }, fresh, now, f.management);
  assert.equal(f.resets.length, 1); assert.equal(retried.error, null);
});


test('scheduled refresh repairs fresh Claude quota, preserves exhausted accounts and never repairs cached readings', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const http = require('node:http'), { spawn } = require('node:child_process'), { once } = require('node:events');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-claude-recovery-'));
  const ready = { ...account(), name: 'ready.json', priority: 2 }, exhausted = { ...account(), auth_index: 'exhausted', name: 'exhausted.json', priority: -100 };
  const files = [ready, exhausted], resets = [];
  let probes = 0, denied = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v0/management/auth-files') return res.end(JSON.stringify({ files }));
    if (req.url === '/v0/management/api-call') {
      probes++;
      return res.end(JSON.stringify(denied ? { status_code: 429, body: '{}' } : { status_code: 200,
        body: JSON.stringify({ five_hour: null, seven_day: { utilization: body.auth_index === 'fixture' ? 0 : 100 } }) }));
    }
    if (req.url === '/v8/management/routing/cooldown/reset') {
      resets.push(body.auth_index); ready.cooldowns = []; ready.status = 'active';
      return res.end('{"status":"ok"}');
    }
    res.writeHead(404); res.end('{}');
  });
  try {
    fs.writeFileSync(path.join(root, '.management-key'), 'fixture-key');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const statePath = path.join(root, 'priority-status.json');
    const run = async () => {
      const child = spawn(process.execPath, [path.join(__dirname, 'quota.cjs'), '--quiet'], {
        env: { ...process.env, CLIPROXY_HOME: root, CLIPROXY_API_URL: `http://127.0.0.1:${server.address().port}` },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = ''; child.stderr.on('data', data => { errors += data; }); child.stdout.resume();
      const [code] = await once(child, 'close'); assert.equal(code, 0, errors);
      return JSON.parse(fs.readFileSync(statePath));
    };
    let state = await run();
    assert.deepEqual(resets, ['fixture']); assert.equal(probes, 2);
    assert.equal(state.accounts[0].status, 'active'); assert.ok(state.accounts[0].routingRecovery.resetAt);
    assert.equal(state.accounts[1].available, false);
    ready.cooldowns = account().cooldowns;
    await run(); assert.equal(probes, 2); assert.deepEqual(resets, ['fixture']);
    const expire = () => { state = JSON.parse(fs.readFileSync(statePath));
      for (const a of state.accounts) a.checkedAt = new Date(now - 3600000).toISOString();
      fs.writeFileSync(statePath, JSON.stringify(state)); };
    expire(); await run(); assert.equal(probes, 4); assert.deepEqual(resets, ['fixture'], 'unchanged fresh quota must preserve a subsequent rate limit');
    denied = true; expire(); state = await run(); assert.equal(probes, 6);
    assert.equal(state.accounts[0].available, true); assert.equal(state.accounts[0].errorStatus, 429);
    await run(); assert.equal(probes, 6); assert.deepEqual(resets, ['fixture'], 'stale positive quota cannot release a gate');
  } finally {
    await new Promise(resolve => server.close(resolve));
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('cliproxy-claude-recovery-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});
