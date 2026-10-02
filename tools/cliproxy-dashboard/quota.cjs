const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.CLIPROXY_HOME || path.join(os.homedir(), '.cli-proxy-api');
const proxyBase = process.env.CLIPROXY_API_URL || 'http://127.0.0.1:8317';
const base = proxyBase + '/v0/management';
const statePath = path.join(root, 'priority-status.json');
const CLAUDE_REFRESH_MS = 10 * 60 * 1000;
const CLAUDE_RATE_LIMIT_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function retryAfterMs(headers, now = Date.now()) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'retry-after');
  const raw = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const until = Date.parse(raw);
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}
function quotaError(status, headers) {
  const error = new Error(`Quota update returned HTTP ${status}.`);
  error.status = status;
  error.retryAfterMs = retryAfterMs(headers);
  return error;
}
function failureState(error, old, provider, now = Date.now()) {
  const status = error.status ?? (Number(/HTTP (\d{3})/.exec(error.message)?.[1]) || null);
  const failures = status === 429 ? Math.min(7, (old?.rateLimitFailures || 0) + 1) : 0;
  const minimum = provider === 'claude' ? CLAUDE_RATE_LIMIT_MS : 60 * 1000;
  const backoff = status === 429 ? Math.min(MAX_BACKOFF_MS, Math.max(minimum, 5 * 60 * 1000) * 2 ** (failures - 1)) : minimum;
  return { error: error.message, errorStatus: status, rateLimitFailures: failures,
    attemptedAt: new Date(now).toISOString(), retryAt: new Date(now + Math.max(backoff, error.retryAfterMs || 0)).toISOString() };
}
function shouldProbe(old, provider, now = Date.now()) {
  if (old?.retryAt && Date.parse(old.retryAt) > now) return false;
  if (old?.error && !old.retryAt) {
    const attemptedAt = Date.parse(old.attemptedAt || old.checkedAt);
    if (Number.isFinite(attemptedAt) && now - attemptedAt < (provider === 'claude' ? CLAUDE_REFRESH_MS : 60000)) return false;
  }
  return !old?.checkedAt || now - Date.parse(old.checkedAt) >= (provider === 'claude' ? CLAUDE_REFRESH_MS : 55000);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { checkedAt: null, accounts: [] }; }
}
async function management(route, method = 'GET', body) {
  const key = fs.readFileSync(path.join(root, '.management-key'), 'utf8').trim();
  const response = await fetch(route.startsWith('/v8/') ? proxyBase + route : base + route, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) { const error = quotaError(response.status, Object.fromEntries(response.headers)); error.message = `Proxy returned HTTP ${response.status}.`; throw error; }
  return response.json();
}
function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function window(id, label, used, reset) {
  const value = typeof used === 'number' && Number.isFinite(used) ? Math.min(100, Math.max(0, 100 - used)) : null;
  return { id, label, remainingPercent: value, resetAt: timestamp(reset) };
}
function codexWindows(usage) {
  const windows = [];
  const main = usage.rate_limit || usage.rate_limits;
  const append = (limit, prefix, label) => {
    for (const [id, item] of [['primary', limit?.primary_window], ['secondary', limit?.secondary_window]]) {
      if (!item) continue;
      const seconds = item.limit_window_seconds ?? (item.window_minutes == null ? null : item.window_minutes * 60);
      const duration = seconds >= 600000 ? 'Weekly' : seconds === 18000 ? '5 hours' : seconds ? `${Math.round(seconds / 3600)} hours` : id === 'secondary' ? 'Weekly' : 'Session';
      const reset = item.reset_at ?? (typeof item.reset_after_seconds === 'number' ? Date.now() / 1000 + item.reset_after_seconds : null);
      windows.push(window(`${prefix}-${id}`, label ? `${label} · ${duration}` : duration, item.used_percent, reset));
    }
  };
  append(main, 'main', '');
  const additional = usage.additional_rate_limits || {};
  for (const [id, value] of Object.entries(additional)) append(value.rate_limit || value, id, value.limit_name || id);
  const core = windows.filter(w => w.id.startsWith('main-'));
  return { windows, available: core.length ? core.every(w => w.remainingPercent === null || w.remainingPercent > 0) : null,
    weeklyResetAt: core.find(w => w.label === 'Weekly')?.resetAt || null, plan: usage.plan_type || null, quotaSupported: true };
}
function claudeWindows(usage) {
  const definitions = [['five_hour', '5 hours'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Opus weekly'], ['seven_day_sonnet', 'Sonnet weekly'], ['seven_day_fable', 'Opus weekly']];
  const windows = definitions.filter(([id]) => usage[id] && typeof usage[id].utilization === 'number')
    .map(([id, label]) => window(id, label, usage[id].utilization, usage[id].resets_at));
  const core = windows.filter(w => ['five_hour', 'seven_day'].includes(w.id));
  return { windows, available: core.length ? core.every(w => w.remainingPercent > 0) : null,
    weeklyResetAt: windows.find(w => w.id === 'seven_day')?.resetAt || windows.find(w => w.label.includes('weekly'))?.resetAt || null,
    quotaSupported: true };
}
function normalizedWindows(usage) {
  const windows = (usage.groups || []).flatMap((group, i) => (group.buckets || []).map((bucket, j) => {
    const remaining = bucket.remainingFraction ?? bucket.remaining_fraction;
    return window(`${i}-${j}`, [group.displayName || group.display_name, bucket.window || bucket.description].filter(Boolean).join(' · ') || 'Quota',
      typeof remaining === 'number' ? 100 - remaining * 100 : null, bucket.resetTime || bucket.reset_time);
  }));
  return { windows, available: null, weeklyResetAt: null, plan: usage.subscription?.plan || usage.subscription?.tierName || null, quotaSupported: true };
}
function xaiWindows(payloads) {
  const windows = [];
  const number = value => {
    const raw = typeof value === 'object' && value !== null ? value.val : value;
    return raw === null || raw === undefined || raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  for (const [i, payload] of payloads.entries()) {
    const config = payload?.config;
    if (!config) continue;
    const period = config.currentPeriod || config.current_period;
    const weekly = number(config.creditUsagePercent ?? config.credit_usage_percent);
    if (weekly !== null && !windows.some(w => w.id === 'weekly')) {
      windows.push(window('weekly', 'Weekly', weekly, period?.end || config.billingPeriodEnd || config.billing_period_end));
    }
    const limit = number(config.monthlyLimit ?? config.monthly_limit), used = number(config.used);
    if (limit > 0 && used !== null && !windows.some(w => w.id === 'monthly')) {
      windows.push(window('monthly', 'Monthly', used / limit * 100, config.billingPeriodEnd || config.billing_period_end || period?.end));
    }
    if (!windows.length && period?.end) windows.push(window(`period-${i}`, period.type || 'Quota', null, period.end));
  }
  return { windows, available: null, weeklyResetAt: windows.find(w => w.id === 'weekly')?.resetAt || null, quotaSupported: windows.length > 0 };
}
async function upstreamCall(account, url, method = 'GET', header = {}, data) {
  const result = await management('/api-call', 'POST', { auth_index: account.auth_index, method, url,
    header: { Authorization: 'Bearer $TOKEN$', ...header }, ...(data === undefined ? {} : { data: JSON.stringify(data) }) });
  if (result.status_code !== 200) throw quotaError(result.status_code, result.header);
  return typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
}
async function probe(account) {
  if (['gemini', 'gemini-cli'].includes(account.provider)) {
    const usage = await upstreamCall(account, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', 'POST',
      { 'Content-Type': 'application/json', 'User-Agent': 'GeminiCLI/0.36.0' }, { project: account.project_id });
    const windows = (usage.buckets || []).filter(b => typeof b.remainingFraction === 'number')
      .map((b, i) => window(b.modelId || String(i), b.modelId || 'Daily', 100 - b.remainingFraction * 100, b.resetTime));
    return { windows, available: null, weeklyResetAt: null, quotaSupported: windows.length > 0 };
  }
  if (['kimi', 'kimi-ai'].includes(account.provider)) {
    const usage = await upstreamCall(account, account.provider === 'kimi-ai' ? 'https://api.kimi.ai/coding/v1/usages' : 'https://api.kimi.com/coding/v1/usages');
    const items = (usage.limits || []).map((v, i) => ({ ...v, id: `limit-${i}`, detail: v.detail || v }));
    if (usage.usage) items.push({ id: 'weekly', name: 'Weekly', detail: usage.usage });
    const windows = items.map(item => {
      const d = item.detail, limit = Number(d.limit), used = d.used == null ? (d.remaining == null ? null : limit - Number(d.remaining)) : Number(d.used);
      return window(item.id, d.name || d.title || item.name || 'Quota', limit > 0 && used !== null ? used / limit * 100 : null, d.resetAt || d.reset_at || d.resetTime || d.reset_time);
    });
    const monthly = usage.usages?.limit_month_total;
    if (monthly && Number.isFinite(Number(monthly.used_ratio))) windows.push(window('monthly', 'Monthly', Number(monthly.used_ratio) * 100, monthly.reset_time));
    return { windows, available: null, weeklyResetAt: null, quotaSupported: windows.length > 0 };
  }
  if (account.provider === 'xai') {
    const headers = { 'x-xai-token-auth': 'xai-grok-cli', 'x-grok-client-version': '0.2.91', accept: '*/*', 'User-Agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (windows; amd64)' };
    const results = await Promise.allSettled(['https://cli-chat-proxy.grok.com/v1/billing?format=credits', 'https://cli-chat-proxy.grok.com/v1/billing'].map(url => upstreamCall(account, url, 'GET', headers)));
    const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!valid.length) throw results[0].reason;
    return xaiWindows(valid);
  }
  if (account.provider === 'antigravity') {
    try {
      const usage = await upstreamCall(account, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', 'POST',
        { 'Content-Type': 'application/json', 'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=windows; arch=amd64)' },
        { project: account.project_id });
      const parsed = normalizedWindows(usage);
      if (parsed.windows.length) return parsed;
    } catch { /* Older accounts expose model quotas instead. */ }
  }
  if (['claude', 'codex', 'antigravity'].includes(account.provider)) {
    const header = { Authorization: 'Bearer $TOKEN$' };
    let method = 'GET', url, data;
    if (account.provider === 'claude') {
      url = 'https://api.anthropic.com/api/oauth/usage'; header['anthropic-beta'] = 'oauth-2025-04-20';
    } else if (account.provider === 'codex') {
      url = 'https://chatgpt.com/backend-api/wham/usage';
      if (path.basename(account.name) === account.name) {
        let metadata;
        try { metadata = JSON.parse(fs.readFileSync(path.join(root, 'auth', account.name), 'utf8')); }
        catch { throw new Error('Account metadata is invalid.'); }
        if (metadata.account_id) header['ChatGPT-Account-Id'] = metadata.account_id;
      }
    } else {
      method = 'POST'; url = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
      header['Content-Type'] = 'application/json'; header['User-Agent'] = 'antigravity/1.23.2 windows/amd64';
      data = JSON.stringify(account.project_id ? { project: account.project_id } : {});
    }
    const result = await management('/api-call', 'POST', { auth_index: account.auth_index, method, url, header, ...(data ? { data } : {}) });
    if (result.status_code !== 200) throw quotaError(result.status_code, result.header);
    const usage = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
    if (account.provider === 'claude') return { ...claudeWindows(usage), usage };
    if (account.provider === 'codex') return codexWindows(usage);
    const windows = Object.entries(usage.models || {}).filter(([, m]) => typeof m.quotaInfo?.remainingFraction === 'number')
      .map(([id, m]) => window(id, m.displayName || id, 100 - m.quotaInfo.remainingFraction * 100, m.quotaInfo.resetTime));
    return { windows, available: null, weeklyResetAt: null, quotaSupported: windows.length > 0 };
  }
  if (account.supports_quota) return normalizedWindows(await management('/quota/fetch', 'POST', { auth_index: account.auth_index, provider: account.provider }));
  return { windows: [], available: null, weeklyResetAt: null, quotaSupported: false };
}
function safeAccount(account) {
  return { id: account.auth_index, name: account.name, email: account.email || null, provider: account.provider,
    label: account.label || account.email || account.account || account.provider, plan: null,
    status: account.status, disabled: !!account.disabled, priority: account.priority ?? 0 };
}
let inFlight;
function refresh(authIndex) {
  if (inFlight) return authIndex ? inFlight.then(() => refresh(authIndex)) : inFlight;
  inFlight = update(authIndex).finally(() => { inFlight = null; });
  return inFlight;
}
async function update(authIndex) {
  // A filesystem lock keeps the scheduled job and the dashboard from polling the same accounts together.
  const lockPath = path.join(root, 'quota-refresh.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { if (Date.now() - fs.statSync(lockPath).mtimeMs > 180000) { fs.unlinkSync(lockPath); return update(authIndex); } }
    catch (statError) { if (statError.code === 'ENOENT') return update(authIndex); throw statError; }
    return readState();
  }
  try {
    const { files = [] } = await management('/auth-files');
    const previous = readState();
    const observations = [];
    for (let offset = 0; offset < files.length; offset += 3) {
      observations.push(...await Promise.all(files.slice(offset, offset + 3).map(async account => {
        const old = previous.accounts.find(a => a.id === account.auth_index);
        const item = { ...safeAccount(account), plan: old?.plan || null, windows: old?.windows || [], checkedAt: old?.checkedAt || null,
          attemptedAt: old?.attemptedAt || null, retryAt: old?.retryAt || null, errorStatus: old?.errorStatus || null,
          rateLimitFailures: old?.rateLimitFailures || 0, ...(account.provider === 'claude' && old?.usage ? { usage: old.usage } : {}),
          weeklyResetAt: old?.weeklyResetAt || null, available: old?.available ?? null, quotaSupported: old?.quotaSupported ?? false };
        if (account.disabled) return { ...item, error: null };
        if (authIndex && account.auth_index !== authIndex) return { ...item, error: old?.error || null };
        if (!shouldProbe(old, account.provider)) return { ...item, error: old?.error || null };
        try { return { ...item, ...(await probe(account)), checkedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(),
          error: null, errorStatus: null, retryAt: null, rateLimitFailures: 0 }; }
        catch (error) { return { ...item, ...failureState(error, old, account.provider) }; }
      })));
    }
    for (const provider of ['claude', 'codex']) {
      const group = observations.filter(a => a.provider === provider && !a.disabled);
      if (group.some(a => a.error)) continue;
      const ranked = group.filter(a => a.weeklyResetAt && a.available !== null)
        .sort((a, b) => Number(b.available) - Number(a.available) || Date.parse(a.weeklyResetAt) - Date.parse(b.weeklyResetAt) || a.name.localeCompare(b.name));
      for (let i = 0; i < ranked.length; i++) {
        const item = ranked[i], priority = item.available ? ranked.length - i : -100;
        const source = files.find(a => a.auth_index === item.id);
        if (source.priority !== priority || (provider === 'codex' && source.websockets !== true)) {
          await management('/auth-files/fields', 'PATCH', { name: item.name, auth_index: item.id, priority, ...(provider === 'codex' ? { websockets: true } : {}) });
        }
        item.priority = priority;
      }
    }
    const state = { checkedAt: new Date().toISOString(), accounts: observations };
    const temporary = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2)); fs.renameSync(temporary, statePath);
    return state;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
module.exports = { root, management, readState, refresh, safeAccount, codexWindows, claudeWindows, normalizedWindows, xaiWindows, timestamp,
  retryAfterMs, failureState, shouldProbe, isRefreshing: () => !!inFlight };
if (require.main === module) refresh().then(state => {
  if (!process.argv.includes('--quiet')) console.log(JSON.stringify({ checkedAt: state.checkedAt, accounts: state.accounts.map(a => ({ provider: a.provider, status: a.status, quotaSupported: a.quotaSupported, error: a.error })) }, null, 2));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
