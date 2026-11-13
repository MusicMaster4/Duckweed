const fs = require('node:fs');
const path = require('node:path');
function enhanceLedger(html) {
  if (!html.includes('globalThis.duckweedLedger.render(')) return html;
  // Newer native bundles expose the language detector under the old i18n alias.
  // Bind the actual initialized translation instance instead of calling .t on that function.
  const translator = html.match(/([A-Za-z_$][\w$]*)\.use\([^)]*\)\.init\(\{resources:/)?.[1];
  if (translator) html = html.replace(/(globalThis\.duckweedStartQuotaMonitor\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,)[A-Za-z_$][\w$]*(\))/, (_, before, after) => before + translator + after);
  const labelHelper = html.match(/globalThis\.duckweedLedger\.render\(\{[\s\S]*?\blabel:([A-Za-z_$][\w$]*)/)?.[1];
  if (labelHelper && !html.includes('/*duckweed-display-name*/')) {
    const signature = `function ${labelHelper}(e){`;
    if (html.includes(signature)) html = html.replace(signature, signature + '/*duckweed-display-name*/const dqDisplayName=globalThis.duckweedLedger?.customName?.(e);if(dqDisplayName)return dqDisplayName;');
  }
  html = html.replace('[e.name,e.email].some', '[e.name,e.email,globalThis.duckweedLedger?.customName?.(e)].some');
  const previousThresholds = ':r>=70?t.quotaBarFillHigh:r>=30?t.quotaBarFillMedium:t.quotaBarFillLow';
  const requestedThresholds = ':r>30?t.quotaBarFillHigh:r>10?t.quotaBarFillMedium:t.quotaBarFillLow';
  if (html.includes(previousThresholds)) html = html.replace(previousThresholds, requestedThresholds);
  const marker = '<!-- duckweed-quota-ledger:v1 -->';
  const block = /<!-- duckweed-quota-ledger:v1 -->\s*<style>[\s\S]*?<\/style>\s*<script>[\s\S]*?<\/script>/;
  if (!block.test(html)) throw new Error('The installed ledger injection is not recognized.');
  const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
  const updated = `${marker}\n<style>\n${read('management-quota-ledger.css')}\n</style>\n<script>\n${read('management-quota-ledger.js')}\n</script>`;
  html = html.replace(block, () => updated);
  html = html.replace(/<!-- duckweed-claude-quota-cache:v1 -->\s*<script>[\s\S]*?<\/script>/, () => `<!-- duckweed-claude-quota-cache:v1 -->\n<script>\n${read('management-quota-bridge.js')}\n</script>`);
  return html;
}
module.exports = { enhanceLedger };
