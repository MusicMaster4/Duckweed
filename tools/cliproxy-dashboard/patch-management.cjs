const fs = require('node:fs');
const path = require('node:path');
const marker = '<!-- duckweed-claude-quota-cache:v1 -->';

function patchHtml(html) {
  if (html.includes(marker)) return html;
  const replacements = [
    ['qp={request:async(e,t)=>{let n=await W.post(`/requests/api-call`,e,t)',
      'qp={request:async(e,t)=>{let n=e.url===`https://api.anthropic.com/api/oauth/usage`?await globalThis.duckweedClaudeQuota(e,Fm.getState(),()=>W.post(`/requests/api-call`,e,t)):await W.post(`/requests/api-call`,e,t)'],
    ['return{windows:s,extraUsage:o.extra_usage,planType:c}},storeSelector:e=>e.claudeQuota',
      'return{windows:s,extraUsage:o.extra_usage,planType:c,localCache:o._duckweed_cache}},storeSelector:e=>e.claudeQuota'],
    ['storeSetter:`setClaudeQuota`,buildLoadingState:()=>({status:`loading`,windows:[]}),buildSuccessState:e=>({status:`success`,windows:e.windows,extraUsage:e.extraUsage,planType:e.planType})',
      'storeSetter:`setClaudeQuota`,buildLoadingState:()=>({status:`loading`,windows:[]}),buildSuccessState:e=>({status:`success`,windows:e.windows,extraUsage:e.extraUsage,planType:e.planType,localCache:e.localCache})'],
    ['o=e.windows??[],s=e.extraUsage??null,c=e.planType??null;return(0,V.jsxs)(V.Fragment,{children:[c&&',
      'o=e.windows??[],s=e.extraUsage??null,c=e.planType??null;return(0,V.jsxs)(V.Fragment,{children:[(e.localCache?.cached||e.localCache?.error)&&(0,V.jsx)(`div`,{className:t.quotaReset,role:`status`,children:globalThis.duckweedQuotaNote(e.localCache)}),c&&'],
    ['a(i(`auth_files.quota_refresh_success`,{name:t.name}),`success`)',
      'n.localCache?.cached||a(i(`auth_files.quota_refresh_success`,{name:t.name}),`success`)'],
    ['n(t(`auth_files.quota_refresh_success`,{name:r.name}),`success`)',
      'e.localCache?.cached||n(t(`auth_files.quota_refresh_success`,{name:r.name}),`success`)'],
  ];
  for (const [before] of replacements) {
    if (html.split(before).length !== 2) throw new Error('Management UI version differs from the tested quota patch. The file was left unchanged.');
  }
  for (const [before, after] of replacements) html = html.replace(before, after);
  const bridge = fs.readFileSync(path.join(__dirname, 'management-quota-bridge.js'), 'utf8');
  if (!html.includes('</head>')) throw new Error('Management UI is missing its head element.');
  return html.replace('</head>', `${marker}\n<script>\n${bridge}\n</script>\n</head>`);
}
function patchManagementPanel(root) {
  const filename = path.join(root, 'static', 'management.html');
  if (!fs.existsSync(filename)) return false;
  const original = fs.readFileSync(filename, 'utf8');
  const patched = patchHtml(original);
  if (original === patched) return false;
  const backupDir = path.join(root, 'backups', 'quota-ui-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(filename, path.join(backupDir, 'management.html'));
  const temporary = filename + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, patched);
  fs.renameSync(temporary, filename);
  return true;
}
function watchManagementPanel(root) {
  const directory = path.join(root, 'static');
  if (!fs.existsSync(directory)) return;
  const apply = () => { try { patchManagementPanel(root); } catch (error) { console.error(error.message); } };
  apply();
  let timer;
  const watcher = fs.watch(directory, (event, filename) => {
    if (filename && String(filename) !== 'management.html') return;
    clearTimeout(timer);
    timer = setTimeout(apply, 500);
    timer.unref();
  });
  watcher.on('error', error => console.error(error.message));
  watcher.unref();
  return watcher;
}
module.exports = { patchHtml, patchManagementPanel, watchManagementPanel };
if (require.main === module) console.log(patchManagementPanel(require('./quota.cjs').root) ? 'Installed the Claude quota cache patch.' : 'Claude quota cache patch is already installed.');
