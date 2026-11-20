const fs = require('node:fs');
const path = require('node:path');
const RETENTION = 30 * 86400000;
function readHistory(root) {
  try { const data = JSON.parse(fs.readFileSync(path.join(root, 'quota-history.json'), 'utf8')); return Array.isArray(data.samples) ? data : { samples: [] }; }
  catch (error) { if (error.code === 'ENOENT') return { samples: [] }; throw error; }
}
function snapshot(state, now = Date.now()) {
  return { at: now, accounts: (state.accounts || []).filter(a => !a.disabled && !a.error && a.checkedAt && (a.windows || []).length).map(a => ({
    id: a.id, provider: a.provider, checkedAt: a.checkedAt,
    windows: a.windows.filter(w => typeof w.remainingPercent === 'number' && Number.isFinite(w.remainingPercent)).map(w => ({ id: w.id, label: w.label, remainingPercent: w.remainingPercent, resetAt: w.resetAt || null }))
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}
function compactHistory(samples, now) {
  const buckets = new Map();
  for (const sample of samples) {
    const age = now - sample.at;
    if (age > RETENTION) continue;
    const resolution = age <= 3 * 3600000 ? 60000 : age <= 7 * 86400000 ? 600000 : 3600000;
    buckets.set(`${resolution}:${Math.floor(sample.at / resolution)}`, sample);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}
function recordHistory(root, state, now = Date.now()) {
  const next = snapshot(state, now);
  if (!next.accounts.length) return;
  const history = readHistory(root);
  const last = history.samples.at(-1);
  if (last && JSON.stringify(last.accounts) === JSON.stringify(next.accounts)) return;
  // Unchanged cached observations cannot create a fabricated period of zero burn.
  if (last && JSON.stringify(last.accounts.map(a => [a.id, a.checkedAt])) === JSON.stringify(next.accounts.map(a => [a.id, a.checkedAt]))) return;
  history.samples = compactHistory([...history.samples, next], now);
  const filename = path.join(root, 'quota-history.json'), temp = filename + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(history)); fs.renameSync(temp, filename);
}
module.exports = { readHistory, recordHistory, snapshot, compactHistory };
