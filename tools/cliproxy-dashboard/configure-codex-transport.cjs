const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// CLIProxy currently rejects Codex's response.interrupt WebSocket frame.
// Keep streaming over HTTP until the proxy supports that part of the protocol.
function httpTransportConfig(source) {
  return source.replace(/^(\[model_providers\.(?:cliproxy|"cliproxy")\][^\r\n]*\r?\n)([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
    (section, header, body) => {
      if (/^\s*supports_websockets\s*=/m.test(body)) {
        return header + body.replace(/^(\s*supports_websockets\s*=\s*)true\b/m, '$1false');
      }
      const newline = header.endsWith('\r\n') ? '\r\n' : '\n';
      return header + 'supports_websockets = false' + newline + body;
    });
}

function configure(configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')) {
  if (!fs.existsSync(configPath)) return { changed: false };
  const source = fs.readFileSync(configPath, 'utf8');
  const updated = httpTransportConfig(source);
  if (updated === source) return { changed: false };
  const backupPath = configPath + '.before-cliproxy-http-' + Date.now() + '-' + process.pid;
  fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(configPath, updated);
  return { changed: true, backupPath };
}

module.exports = { httpTransportConfig, configure };
if (require.main === module) {
  try {
    const result = configure(process.argv[2]);
    console.log(result.changed ? 'Codex CLIProxy streaming now uses HTTP. Configuration backup: ' + result.backupPath : 'Codex CLIProxy transport needs no change.');
  } catch (error) {
    console.error('Could not configure the Codex CLIProxy transport: ' + error.message);
    process.exitCode = 1;
  }
}
