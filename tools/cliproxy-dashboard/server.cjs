const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const quota = require('./quota.cjs');
const { claudeCacheResult } = require('./claude-cache.cjs');
try { require('./patch-management.cjs').watchManagementPanel(quota.root); }
catch (error) { console.error(error.message); }
const PORT = Number(process.env.CLIPROXY_DASHBOARD_PORT || 8318);
const origin = `http://127.0.0.1:${PORT}`;
const upstream = process.env.CLIPROXY_API_URL || 'http://127.0.0.1:8317';
const providers = [
  { id: 'claude', name: 'Claude', modes: ['oauth', 'key'], baseUrl: 'https://api.anthropic.com' },
  { id: 'codex', name: 'Codex', modes: ['oauth', 'key'], baseUrl: 'https://api.openai.com/v1' },
  { id: 'antigravity', name: 'Antigravity', modes: ['oauth'] },
  { id: 'xai', name: 'Grok', modes: ['oauth', 'key'], baseUrl: 'https://api.x.ai/v1' },
  { id: 'gemini-cli', name: 'Gemini CLI', modes: ['oauth'] },
  { id: 'gemini', name: 'Gemini API', modes: ['key'], baseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'kimi', name: 'Kimi Code', modes: ['oauth'] },
  { id: 'kimi-ai', name: 'Kimi', modes: ['oauth'] },
  { id: 'meta', name: 'Meta', modes: ['oauth'] },
  { id: 'devin', name: 'Devin', modes: ['oauth'] },
  { id: 'openrouter', name: 'OpenRouter', modes: ['key'], baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'openai-compatible', name: 'Other provider', modes: ['key'] },
];
const nativeRoutes = { claude: 'claude-api-key', codex: 'codex-api-key', xai: 'xai-api-key', gemini: 'gemini-api-key' };
let connectionQueue = Promise.resolve();
let modelsCache = { at: 0, models: [] };
let providerCache = { at: 0, providers };
async function getProviders() {
  if (Date.now() - providerCache.at < 60000) return providerCache.providers;
  const { plugins = [] } = await quota.management('/v8/management/plugins');
  const extra = plugins.filter(p => p.registered && p.effective_enabled && p.supports_oauth && p.oauth_provider && !providers.some(v => v.id === p.oauth_provider))
    .map(p => ({ id: p.oauth_provider, name: p.id === 'kiro' ? 'Kiro' : p.metadata?.name || p.id, modes: ['oauth'] }));
  providerCache = { at: Date.now(), providers: [...providers, ...extra] };
  return providerCache.providers;
}
function authenticated(req) {
  const expected = fs.readFileSync(path.join(quota.root, '.management-key'), 'utf8').trim();
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) {
  let value = '';
  for await (const chunk of req) { value += chunk; if (value.length > 100000) throw new Error('Request is too large.'); }
  return value ? JSON.parse(value) : {};
}
async function getModels() {
  if (Date.now() - modelsCache.at < 15000) return modelsCache.models;
  const key = fs.readFileSync(path.join(quota.root, '.api-key'), 'utf8').trim();
  const response = await fetch(upstream + '/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Unable to load the model list.');
  const { data = [] } = await response.json();
  modelsCache = { at: Date.now(), models: data.map(m => ({ id: m.id, provider: m.owned_by })) };
  return modelsCache.models;
}
async function connections() {
  const config = await quota.management('/config');
  const entries = (config['openai-compatibility'] || []).map((c, i) => ({ id: `compatible-${i}`, name: c.name,
    provider: /grok|xai/i.test(c.name) ? 'xai' : /openrouter/i.test(c.name) ? 'openrouter' : 'openai-compatible',
    baseUrl: c['base-url'], keyCount: (c['api-key-entries'] || []).length }));
  for (const [provider, route] of Object.entries(nativeRoutes)) {
    const keys = config[route] || [];
    if (keys.length) entries.push({ id: route, name: providers.find(p => p.id === provider).name + ' API', provider, baseUrl: keys[0]['base-url'] || providers.find(p => p.id === provider).baseUrl, keyCount: keys.length });
  }
  return entries;
}
async function status() {
  const [credentials, keys, models, catalog] = await Promise.all([quota.management('/auth-files'), connections(), getModels(), getProviders()]);
  const snapshot = quota.readState();
  const accounts = (credentials.files || []).map(a => {
    const saved = snapshot.accounts.find(q => q.id === a.auth_index);
    return { windows: [], checkedAt: null, error: null, quotaSupported: false, ...saved, ...quota.safeAccount(a), plan: saved?.plan || null };
  });
  return { checkedAt: snapshot.checkedAt, refreshing: quota.isRefreshing(), refreshIntervalSeconds: 60, accounts, connections: keys, providers: catalog, models };
}
async function connect(data) {
  const provider = providers.find(p => p.id === data.provider && p.modes.includes('key'));
  if (!provider) throw new Error('Choose a supported provider.');
  const key = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
  if (!key) throw new Error('Enter an API key.');
  const endpoint = new URL(data.baseUrl || provider.baseUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Enter a valid API base URL.');
  const baseUrl = endpoint.href.replace(/\/$/, '');
  const modelIds = [...new Set((data.models || []).map(m => String(m).trim()).filter(Boolean))];
  if (nativeRoutes[provider.id]) {
    const route = nativeRoutes[provider.id];
    const current = await quota.management('/' + route);
    const keys = current[route] || [];
    if (keys.some(k => k['api-key'] === key && (k['base-url'] || provider.baseUrl).replace(/\/$/, '') === baseUrl)) throw new Error('This API key is already connected.');
    await quota.management('/' + route, 'PUT', [...keys, { 'api-key': key, 'base-url': baseUrl,
      ...(modelIds.length ? { models: modelIds.map(name => ({ name, alias: name })) } : {}) }]);
  } else {
    const name = String(data.name || provider.name).trim();
    if (!name || name.length > 100) throw new Error('Enter a short connection name.');
    let ids = modelIds;
    if (!ids.length) {
      const response = await fetch(baseUrl + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Model discovery failed. Enter model IDs to connect this provider.');
      const result = await response.json(); ids = (result.data || []).map(m => m.id).filter(id => typeof id === 'string').slice(0, 1000);
      if (!ids.length) throw new Error('Enter at least one model ID.');
    }
    const current = await quota.management('/openai-compatibility');
    const entries = current['openai-compatibility'] || [];
    const existing = entries.find(c => c.name === name && c['base-url']?.replace(/\/$/, '') === baseUrl);
    if (existing) {
      if ((existing['api-key-entries'] || []).some(k => k['api-key'] === key)) throw new Error('This API key is already connected.');
      existing['api-key-entries'] = [...(existing['api-key-entries'] || []), { 'api-key': key }];
      const models = existing.models || []; const known = new Set(models.map(m => m.name));
      existing.models = [...models, ...ids.filter(id => !known.has(id)).map(id => ({ name: id, alias: id }))];
    } else entries.push({ name, 'base-url': baseUrl, 'api-key-entries': [{ 'api-key': key }], models: ids.map(id => ({ name: id, alias: id })) });
    await quota.management('/openai-compatibility', 'PUT', entries);
  }
  modelsCache.at = 0;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  const host = req.headers.host;
  if (![ `127.0.0.1:${PORT}`, `localhost:${PORT}` ].includes(host)) return json(res, 403, { error: 'Local access only.' });
  const url = new URL(req.url, origin);
  const nativeQuotaRequest = url.pathname === '/local/claude-quota';
  const allowedOrigins = [origin, `http://localhost:${PORT}`, ...(nativeQuotaRequest ? ['http://127.0.0.1:8317', 'http://localhost:8317'] : [])];
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return json(res, 403, { error: 'Origin is not allowed.' });
  if (nativeQuotaRequest && req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { service: 'duckweed-cliproxy-dashboard' });
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (!url.pathname.startsWith('/local/')) return json(res, 404, { error: 'Not found.' });
  if (!authenticated(req)) return json(res, 401, { error: 'Enter the management password.' });
  try {
    if (req.method === 'POST' && nativeQuotaRequest) {
      const data = await body(req);
      const authIndex = String(data.authIndex || data.auth_index || '');
      const { files = [] } = await quota.management('/auth-files');
      const source = files.find(file => file.auth_index === authIndex && file.provider === 'claude');
      if (!source || source.disabled) return json(res, 404, { error: 'Claude account is unavailable.' });
      const state = await quota.refresh(authIndex);
      const account = state.accounts.find(account => account.id === authIndex);
      if (!account) return json(res, 503, { error: 'Claude quota has not been loaded yet.' });
      return json(res, 200, claudeCacheResult(account));
    }
    if (req.method === 'GET' && url.pathname === '/local/status') return json(res, 200, await status());
    if (req.method === 'POST' && url.pathname === '/local/refresh') { await quota.refresh(); return json(res, 200, await status()); }
    if (req.method === 'POST' && url.pathname === '/local/login') {
      const data = await body(req); const provider = (await getProviders()).find(p => p.id === data.provider && p.modes.includes('oauth'));
      if (!provider) return json(res, 400, { error: 'Choose a supported login provider.' });
      const result = await quota.management('/v8/management/oauth/auth-url?provider=' + encodeURIComponent(provider.id) + '&is_webui=true');
      return json(res, 200, { url: result.url, state: result.state, provider: provider.id, ...(result.user_code ? { userCode: result.user_code } : {}) });
    }
    if (req.method === 'GET' && url.pathname === '/local/login-status') {
      const state = url.searchParams.get('state');
      if (!state || state.length > 256) return json(res, 400, { error: 'Invalid login session.' });
      const result = await quota.management('/get-auth-status?state=' + encodeURIComponent(state));
      if (result.error) result.error = /SUBSCRIPTION_REQUIRED|valid license/i.test(result.error)
        ? 'This account needs a Gemini Code Assist license. Try another account.'
        : String(result.error).slice(0, 300);
      if (result.status === 'ok') { await quota.refresh(); modelsCache.at = 0; }
      return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/local/account') {
      const data = await body(req); if (typeof data.disabled !== 'boolean') throw new Error('Choose enabled or paused.');
      const { files = [] } = await quota.management('/auth-files'); const account = files.find(a => a.auth_index === data.id);
      if (!account) return json(res, 404, { error: 'Account no longer exists.' });
      await quota.management('/auth-files/status', 'PATCH', { name: account.name, disabled: data.disabled });
      modelsCache.at = 0; return json(res, 200, await status());
    }
    if (req.method === 'POST' && url.pathname === '/local/connect') {
      const data = await body(req);
      const pending = connectionQueue.then(() => connect(data)); connectionQueue = pending.catch(() => {});
      await pending; return json(res, 200, await status());
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { return json(res, 400, { error: error.message }); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`CLIProxy account panel: ${origin}`);
  quota.refresh().catch(error => console.error(error.message));
});
setInterval(() => quota.refresh().catch(error => console.error(error.message)), 60000).unref();
