const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
function helpers() {
  const context = { module: { exports: {} }, localStorage: { getItem: () => null }, Set, Map, Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'management-quota-ledger.js'), 'utf8'), context);
  return context.module.exports;
}
const h = helpers();
test('pool excludes disabled credentials and uses overall Claude weekly limit before model sublimits', () => {
  const entries = ['one', 'two'].map((name, i) => ({ type: 'claude', file: { name, auth_index: name, disabled: i === 1 } }));
  const props = { t: key => key, quotaFor: () => ({ status: 'success', windows: [
    { id: 'seven-day-fable', label: '7-day Fable', usedPercent: 99, periodHours: 168 },
    { id: 'seven-day', label: '7-day', usedPercent: 40, periodHours: 168 }
  ] }) };
  const group = h.buildGroup('claude', entries, props, Date.now());
  assert.equal(group.primary.id, 'seven-day');
  assert.equal(group.primary.sum, 60);
  assert.equal(group.primary.capacity, 100);
});
test('burn rejects duplicate cached readings, reset jumps, missing data and short observation intervals', () => {
  const now = Date.now(), reset = now + 86400000;
  const point = (at, value, checkedAt = at, nextReset = reset) => ({ at, value, values: [{ remaining: value, checkedAt, reset: nextReset }] });
  assert.equal(h.burnRate([point(now-600000, 50), point(now, 40)], now), 60);
  assert.equal(h.burnRate([point(now-600000, 50), point(now, 50, now-600000)], now), null);
  assert.equal(h.burnRate([point(now-10000, 50), point(now, 40)], now), null);
  assert.equal(h.burnRate([point(now-600000, 10), point(now, 100, now, reset+1000)], now), null);
  assert.equal(h.burnRate([point(now-600000, 50), point(now, 50)], now), 0);
});
test('projection drains balances, adds known reset gains and never exceeds weighted capacity', () => {
  const now = Date.now();
  const members = [{ remaining: 20, weight: 1, reset: now+3600000, period: 168 }, { remaining: 50, weight: 2.5, reset: now+7200000, period: 168 }];
  const projected = h.projectPool(members, 10, now, now+10800000);
  assert.equal(projected.resets.length, 2);
  assert.equal(projected.resets[0].gain, 90);
  assert.equal(projected.points.at(-1).value, 330);
  assert.equal(projected.poolEmpty, null);
  assert.ok(projected.points.every(p => p.value >= 0 && p.value <= 350));
  const depleted = h.projectPool([{ remaining: 10, weight: 1, reset: now+7200000, period: 168 }], 20, now, now+10800000);
  assert.equal(depleted.poolEmpty, now+1800000);
  assert.ok(depleted.points.some(p => p.value === 0));
});
test('history keeps no names, credentials or raw provider payloads and does not invent cached samples', () => {
  const { recordHistory, readHistory } = require('./quota-history.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-history-'));
  try {
    const now = Date.now();
    const state = { accounts: [{ id: 'opaque-index', provider: 'claude', name: 'sensitive@example.test', apiKey: 'secret-key', checkedAt: new Date(now).toISOString(), windows: [{ id: 'seven_day', label: 'Weekly', remainingPercent: 50, resetAt: new Date(now+86400000).toISOString() }] }] };
    recordHistory(root, state, now);
    recordHistory(root, state, now+60000);
    assert.equal(readHistory(root).samples.length, 1);
    const raw = fs.readFileSync(path.join(root, 'quota-history.json'), 'utf8');
    assert.ok(!raw.includes('sensitive@example.test') && !raw.includes('secret-key'));
    state.accounts[0].checkedAt = new Date(now+600000).toISOString();
    recordHistory(root, state, now+600000);
    assert.equal(readHistory(root).samples.length, 2);
  } finally {
    const absolute = fs.realpathSync(root);
    assert.equal(path.dirname(absolute).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('ledger-history-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
test('native patch replaces only known injected assets, is idempotent and preserves React hooks', () => {
  const { enhanceLedger } = require('./patch-ledger.cjs');
  const original = '<html><head><script>function Am(e){return e.name}fo.use(ts).init({resources:{}});globalThis.duckweedStartQuotaMonitor(jA,Nm,Lm,Py,km,ml);[e.name,e.email].some(fn);</script><!-- duckweed-quota-ledger:v1 --><style>old</style><script>old</script></head><body><script>globalThis.duckweedLedger.render({label:Am})</script></body></html>';
  const patched = enhanceLedger(original);
  assert.ok(patched.includes('globalThis.duckweedLedger.render({label:Am})'));
  assert.ok(patched.includes('function Forecast('));
  assert.ok(patched.includes('duckweedStartQuotaMonitor(jA,Nm,Lm,Py,km,fo)'));
  assert.ok(patched.includes('/*duckweed-display-name*/'));
  assert.ok(patched.includes('[e.name,e.email,globalThis.duckweedLedger?.customName?.(e)].some'));
  assert.equal(enhanceLedger(patched), patched);
  assert.equal(enhanceLedger('<html></html>'), '<html></html>');
  assert.throws(() => enhanceLedger('globalThis.duckweedLedger.render('), /not recognized/);
});

test('every quota uses exact requested color boundaries', () => {
  assert.equal(h.tone(100), 'high'); assert.equal(h.tone(30.1), 'high');
  assert.equal(h.tone(30), 'mid'); assert.equal(h.tone(10.1), 'mid');
  assert.equal(h.tone(10), 'low'); assert.equal(h.tone(0), 'low');
  assert.equal(h.tone(null), 'none');
});
test('native React ledger and forecasts render with accessible quotas and privacy mode has no identity leaks', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const privateMode of [false, true]) {
    const context = { module: { exports: {} }, localStorage: { getItem: key => key === 'duckweed.quotaPrivacy' ? String(privateMode) : null }, document: { documentElement: { toggleAttribute() {} } }, Set, Map, Date };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'management-quota-ledger.js'), 'utf8'), context);
    const entry = { type: 'claude', file: { auth_index: 'test-id', name: 'credential-private@example.test.json', email: 'private@example.test' } };
    const now = Date.now();
    const props = { React, entries: [entry], types: ['claude'], tab: 'all', t: key => key, canRefresh: true,
      quotaFor: () => ({ status: 'success', windows: [{ id: 'seven-day', label: 'Weekly', usedPercent: 70, resetAtMs: now+86400000, periodHours: 168 }] }),
      useNow: () => now, useClaudeReset: () => ({ count: 0 }), cacheKey: file => file.name, label: file => file.name,
      icon: () => null, iconNeedsBg: () => false, providerName: () => 'Claude', adapters: { claude: { i18nPrefix: 'claude' } },
      RefreshIcon: () => null
    };
    const html = renderToStaticMarkup(context.duckweedLedger.render(props));
    assert.ok(html.includes('30% left') && html.includes('data-tone="mid"'));
    assert.ok(html.includes('Forecast range') && html.includes('Claude pool balance'));
    assert.ok(html.includes('Waiting for first reading'));
    if (privateMode) { assert.ok(!html.includes('private@example.test')); assert.ok(html.includes('Account 1')); }
    else assert.ok(html.includes('private@example.test'));
  }
});

test('history retention keeps recent resolution and bounds older data without fabricating points', () => {
  const { compactHistory } = require('./quota-history.cjs');
  const now = Date.now();
  const samples = Array.from({ length: 31 * 24 * 60 }, (_, i) => ({ at: now - i * 60000, accounts: [] })).reverse();
  const compacted = compactHistory(samples, now);
  assert.ok(compacted.length < 1900);
  assert.ok(compacted.every(sample => now - sample.at <= 30 * 86400000 && samples.includes(sample)));
  assert.equal(compacted.at(-1).at, now);
});

test('custom account names persist safely and survive quota updates without changing account identifiers', () => {
  const { readNames, setName } = require('./account-names.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-names-'));
  try {
    setName(root, 'opaque-id', 'My work account');
    assert.equal(readNames(root)['opaque-id'], 'My work account');
    assert.throws(() => setName(root, 'opaque-id', 'bad\nname'), /80 characters/);
    assert.throws(() => setName(root, 'opaque-id', 'x'.repeat(81)), /80 characters/);
    assert.equal(readNames(root)['opaque-id'], 'My work account');
    setName(root, 'opaque-id', '');
    assert.equal(readNames(root)['opaque-id'], undefined);
  } finally {
    const absolute = fs.realpathSync(root);
    assert.equal(path.dirname(absolute).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('ledger-names-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});

test('burn combines independently refreshed accounts and ignores their duplicate cached copies', () => {
  const now = Date.now(), start = now - 600000, reset = now + 86400000;
  const value = (id, checkedAt, remaining, weight = 1) => ({ id, checkedAt, remaining, weight, reset });
  const series = [
    { at: start, values: [value('a', start, 50), value('b', start, 60)] },
    { at: start+300000, values: [value('a', start+300000, 45), value('b', start, 60)] },
    { at: start+360000, values: [value('a', start+300000, 45), value('b', start+360000, 50)] }
  ];
  assert.equal(h.burnRate(series, now), 160);
  series.splice(1, 0, { at: start+100000, values: [null, value('b', start, 60)] });
  assert.equal(h.burnRate(series, now), 160);
});
test('a replenishment waits for a new comparable reading and explains that wait', () => {
  const now = Date.now(), reset = now+86400000;
  const point = (at, remaining) => ({ at, values: [{ id: 'a', checkedAt: at, remaining, reset, weight: 1 }] });
  const series = [point(now-1200000, 0), point(now-600000, 100)];
  assert.equal(h.burnAnalysis(series, now).reason, 'Waiting after reset');
  assert.equal(h.burnRate(series, now), null);
  series.push(point(now, 95));
  assert.equal(h.burnRate(series, now), 30);
  assert.equal(h.burnAnalysis([point(now-3600000, 95)], now).reason, 'Quota update delayed');
  assert.equal(h.burnAnalysis([], now, ['a']).reason, 'Waiting for first reading');
});
