const fs = require('node:fs');
const path = require('node:path');

function readTransport(root) {
  const file = path.join(root, 'codex-transport.json');
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value.supportsWebsockets !== 'boolean') throw new Error('Invalid Codex transport preference.');
  return value.supportsWebsockets;
}

function writeTransport(root, supportsWebsockets) {
  if (typeof supportsWebsockets !== 'boolean') throw new Error('Invalid Codex transport preference.');
  if (readTransport(root) === supportsWebsockets) return { changed: false };
  const file = path.join(root, 'codex-transport.json');
  fs.mkdirSync(root, { recursive: true });
  const backupPath = fs.existsSync(file) ? file + '.before-' + Date.now() + '-' + process.pid : null;
  if (backupPath) fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ supportsWebsockets }, null, 2) + '\n');
  fs.renameSync(temporary, file);
  return { changed: true, backupPath };
}

async function applyTransport(files, root, management) {
  const desired = readTransport(root);
  if (desired === null) return;
  for (const account of files.filter(account => account.provider === 'codex')) {
    if (account.websockets === desired) continue;
    await management('/auth-files/fields', 'PATCH', { name: account.name, auth_index: account.auth_index, websockets: desired });
    account.websockets = desired;
  }
}

module.exports = { readTransport, writeTransport, applyTransport };
