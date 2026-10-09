const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { httpTransportConfig, transportConfig, configure } = require('./configure-codex-transport.cjs');

test('changes only the CLIProxy transport while preserving other providers and comments', () => {
  const source = 'model_provider = "cliproxy"\r\n[model_providers.direct]\r\nsupports_websockets = true\r\n\r\n[model_providers.cliproxy] # local proxy\r\nname = "CLIProxyAPI"\r\nsupports_websockets = true # transport\r\nrequires_openai_auth = true\r\n\r\n[tui]\r\ntheme = "dark"\r\n';
  const expected = source.replace('supports_websockets = true # transport', 'supports_websockets = false # transport');
  assert.equal(httpTransportConfig(source), expected);
  assert.equal(httpTransportConfig(expected), expected);
  assert.equal(httpTransportConfig('[model_providers.direct]\nsupports_websockets = true\n'), '[model_providers.direct]\nsupports_websockets = true\n');
});

test('adds an explicit HTTP setting for a quoted provider at the end of the file', () => {
  assert.equal(httpTransportConfig('[model_providers."cliproxy"]\nname = "CLIProxyAPI"'), '[model_providers."cliproxy"]\nsupports_websockets = false\nname = "CLIProxyAPI"');
});

test('backs up the original configuration once and leaves subsequent runs unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-transport-test-'));
  try {
    const configPath = path.join(root, 'config.toml');
    const source = '[model_providers.cliproxy]\nsupports_websockets = true\n';
    fs.writeFileSync(configPath, source);
    const result = configure(configPath);
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), source);
    assert.equal(fs.readFileSync(configPath, 'utf8'), source.replace('true', 'false'));
    assert.deepEqual(configure(configPath), { changed: false });
    assert.equal(fs.readdirSync(root).length, 2);
    assert.deepEqual(configure(path.join(root, 'missing.toml')), { changed: false });
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cliproxy-transport-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restores WebSocket capability only when explicitly requested for the patched proxy', () => {
  const source = '[model_providers.cliproxy]\nsupports_websockets = false # fallback\n';
  const updated = source.replace('false', 'true');
  assert.equal(transportConfig(source, true), updated);
  assert.equal(transportConfig(updated, true), updated);
  assert.equal(httpTransportConfig(updated), source);
});

const { readTransport, writeTransport, applyTransport } = require('./codex-transport-policy.cjs');

test('proxy transport selection persists, backs up changes and preserves existing account choices without a policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-transport-policy-test-'));
  try {
    const accounts = [{ name: 'codex.json', auth_index: 'codex', provider: 'codex', websockets: true },
      { name: 'paused.json', auth_index: 'paused', provider: 'codex', disabled: true, websockets: true },
      { name: 'claude.json', provider: 'claude', websockets: true }];
    const calls = [];
    const management = async (...args) => { calls.push(args); };
    assert.equal(readTransport(root), null);
    await applyTransport(accounts, root, management);
    assert.equal(calls.length, 0);
    assert.equal(writeTransport(root, false).changed, true);
    await applyTransport(accounts, root, management);
    assert.deepEqual(calls.map(call => call[2]), [
      { name: 'codex.json', auth_index: 'codex', websockets: false },
      { name: 'paused.json', auth_index: 'paused', websockets: false }]);
    assert.equal(accounts[2].websockets, true);
    await applyTransport(accounts, root, management);
    assert.equal(calls.length, 2, 'quota refresh must not re-enable WebSocket');
    const added = { name: 'new.json', auth_index: 'new', provider: 'codex', websockets: true };
    accounts.push(added);
    await applyTransport(accounts, root, management);
    assert.equal(added.websockets, false, 'new accounts inherit the selected transport');
    assert.deepEqual(writeTransport(root, false), { changed: false });
    const changed = writeTransport(root, true);
    assert.equal(JSON.parse(fs.readFileSync(changed.backupPath)).supportsWebsockets, false);
    assert.equal(readTransport(root), true);
    await applyTransport(accounts, root, management);
    assert.ok(accounts.every(account => account.websockets === true));
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cliproxy-transport-policy-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('transport synchronization propagates management failures so a later refresh can retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-transport-policy-test-'));
  try {
    writeTransport(root, false);
    const account = { name: 'codex.json', provider: 'codex', websockets: true };
    await assert.rejects(applyTransport([account], root, async () => { throw new Error('offline'); }), /offline/);
    assert.equal(account.websockets, true);
    await applyTransport([account], root, async () => {});
    assert.equal(account.websockets, false);
    fs.writeFileSync(path.join(root, 'codex-transport.json'), '{"supportsWebsockets":"false"}');
    assert.throws(() => readTransport(root), /Invalid/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cliproxy-transport-policy-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
