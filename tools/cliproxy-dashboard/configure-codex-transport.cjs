const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTransport, applyTransport } = require('./codex-transport-policy.cjs');

// HTTP handles image-heavy histories that exceed upstream WebSocket limits.
// WebSocket mode remains an explicit option for the compatibility build.
function transportConfig(source, supportsWebsockets = false) {
  return source.replace(/^(\[model_providers\.(?:cliproxy|"cliproxy")\][^\r\n]*\r?\n)([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
    (section, header, body) => {
      if (/^\s*supports_websockets\s*=/m.test(body)) {
        return header + body.replace(/^(\s*supports_websockets\s*=\s*)(?:true|false)\b/m, '$1' + supportsWebsockets);
      }
      const newline = header.endsWith('\r\n') ? '\r\n' : '\n';
      return header + 'supports_websockets = ' + supportsWebsockets + newline + body;
    });
}

function configure(configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), supportsWebsockets = false) {
  if (!fs.existsSync(configPath)) return { changed: false };
  const source = fs.readFileSync(configPath, 'utf8');
  const updated = transportConfig(source, supportsWebsockets);
  if (updated === source) return { changed: false };
  const backupPath = configPath + '.before-cliproxy-transport-' + Date.now() + '-' + process.pid;
  fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(configPath, updated);
  return { changed: true, backupPath };
}

module.exports = { transportConfig, httpTransportConfig: source => transportConfig(source, false), configure };
if (require.main === module) {
  (async () => {
    const useWebsocket = process.argv.includes('--websocket');
    const result = configure(process.argv.slice(2).find(arg => !arg.startsWith('--')), useWebsocket);
    if (process.argv.includes('--sync-proxy')) {
      const { root, management } = require('./quota.cjs');
      writeTransport(root, useWebsocket);
      const { files = [] } = await management('/auth-files');
      await applyTransport(files, root, management);
    }
    console.log(result.changed ? 'Codex CLIProxy streaming now uses ' + (useWebsocket ? 'WebSocket' : 'HTTP') + '. Configuration backup: ' + result.backupPath : 'Codex CLIProxy transport needs no change.');
  })().catch(error => {
    console.error('Could not configure the Codex CLIProxy transport: ' + error.message);
    process.exitCode = 1;
  });
}
