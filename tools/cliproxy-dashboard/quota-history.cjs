const fs = require('node:fs');
const path = require('node:path');
const RETENTION = 30 * 86400000;
function loadFile(filename) {
  let raw;
  try { raw = fs.readFileSync(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data?.samples) && data.samples.every(sample =>
      Number.isFinite(sample?.at) && Array.isArray(sample.accounts) &&
      sample.accounts.every(account => account && Array.isArray(account.windows)))) return { data, raw };
  } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  return { corrupt: true };
}
function readHistory(root) {
  const filename = path.join(root, 'quota-history.json');
  return loadFile(filename).data || loadFile(filename + '.bak').data || { samples: [] };
}
function replaceFile(filename, raw) {
  const temp = filename + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, raw, { flush: true });
  fs.renameSync(temp, filename);
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
  const filename = path.join(root, 'quota-history.json');
  const primary = loadFile(filename);
  const history = primary.data || loadFile(filename + '.bak').data || { samples: [] };
  const last = history.samples.at(-1);
  const signature = sample => JSON.stringify(sample.accounts.map(a => [a.id, a.checkedAt]));
  const changed = next.accounts.length && (!last || signature(last) !== signature(next));
  if (!changed && (primary.data || !history.samples.length && !primary.corrupt)) return;
  if (primary.corrupt) fs.copyFileSync(filename, filename + '.corrupt-' + Date.now(), fs.constants.COPYFILE_EXCL);
  if (primary.data) replaceFile(filename + '.bak', primary.raw);
  if (changed) history.samples = compactHistory([...history.samples, next], now);
  replaceFile(filename, JSON.stringify(history));
}
module.exports = { readHistory, recordHistory, snapshot, compactHistory };
