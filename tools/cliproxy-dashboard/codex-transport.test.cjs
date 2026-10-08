const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { httpTransportConfig, configure } = require('./configure-codex-transport.cjs');

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
