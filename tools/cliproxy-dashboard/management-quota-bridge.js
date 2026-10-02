(() => {
  'use strict';
  globalThis.duckweedClaudeQuota = async (payload, session, fallback) => {
    let api;
    try { api = new URL(session.apiBase); } catch { return fallback(); }
    if (!['http://127.0.0.1:8317', 'http://localhost:8317'].includes(api.origin)) return fallback();
    let response;
    try {
      response = await fetch(`http://${api.hostname}:8318/local/claude-quota`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.managementKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ authIndex: payload.authIndex || payload.auth_index }), signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error('The local quota monitor is unavailable. Run cliproxy start and try again.');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to read the cached quota.');
    return result;
  };
  globalThis.duckweedQuotaNote = (cache) => {
    const format = value => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const parts = [`Cached quota from ${format(cache.checkedAt)}.`];
    if (cache.error) parts.push(/429/.test(cache.error) ? 'Refresh rate limited.' : 'Refresh unavailable.');
    if (cache.retryAt) parts.push(`Retry after ${format(cache.retryAt)}.`);
    return parts.join(' ');
  };
})();
