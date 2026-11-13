const fs = require('node:fs');
const path = require('node:path');
function readNames(root) {
  try {
    const result = JSON.parse(fs.readFileSync(path.join(root, 'account-names.json'), 'utf8'));
    return Object.fromEntries(Object.entries(result).filter(([id, name]) => id && typeof name === 'string' && name.length <= 80));
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function setName(root, id, name) {
  if (typeof name !== 'string' || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a name of up to 80 characters.');
  const names = readNames(root), value = name.trim();
  if (value) Object.defineProperty(names, id, { value, enumerable: true, writable: true, configurable: true });
  else delete names[id];
  const file = path.join(root, 'account-names.json'), temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(names)); fs.renameSync(temp, file);
  return names;
}
module.exports = { readNames, setName };
