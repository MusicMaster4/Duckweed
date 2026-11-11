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
  globalThis.duckweedStartQuotaMonitor = (adapters, quotaStore, authStore, filesApi, cacheKey, i18n) => {
    globalThis.duckweedAccountNames = async (id, name) => {
      const session = authStore.getState(), api = new URL(session.apiBase);
      if (!['http://127.0.0.1:8317', 'http://localhost:8317'].includes(api.origin)) throw new Error('Account names are available for the local proxy.');
      const save = id !== undefined;
      const response = await fetch(`http://${api.hostname}:8318/local/${save ? 'account-name' : 'account-names'}`, {
        method: save ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${session.managementKey}`, ...(save ? { 'Content-Type': 'application/json' } : {}) },
        ...(save ? { body: JSON.stringify({ id, name }) } : {}), signal: AbortSignal.timeout(10000), cache: 'no-store'
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save the account name.');
      globalThis.duckweedLedger?.setNames(result.names || {});
      return result.names || {};
    };
    globalThis.duckweedLoadQuotaHistory = async () => {
      const session = authStore.getState();
      const api = new URL(session.apiBase);
      if (!['http://127.0.0.1:8317', 'http://localhost:8317'].includes(api.origin)) throw new Error('Quota history is available for the local proxy.');
      const response = await fetch(`http://${api.hostname}:8318/local/quota-history`, {
        headers: { Authorization: `Bearer ${session.managementKey}` }, signal: AbortSignal.timeout(10000), cache: 'no-store'
      });
      if (!response.ok) throw new Error('Quota history is unavailable. Run cliproxy start.');
      return response.json();
    };
    let busy = false;
    const retries = new Map();
    const tick = async () => {
      const session = authStore.getState();
      if (busy || document.hidden || session.connectionStatus !== 'connected') return;
      let api;
      try { api = new URL(session.apiBase); } catch { return; }
      if (!['http://127.0.0.1:8317', 'http://localhost:8317'].includes(api.origin)) return;
      busy = true;
      const generation = quotaStore.getState().cacheGeneration;
      try {
        const { files = [] } = await filesApi.list();
        await Promise.all(files.filter(file => !file.disabled).map(async file => {
          const key = cacheKey(file);
          if (Date.now() < (retries.get(key) || 0)) return;
          const adapter = ['claude', 'codex', 'antigravity', 'xai'].map(type => adapters[type]).find(item => item.filterFn(file));
          if (!adapter || adapter.storeSelector(quotaStore.getState())[key]?.status === 'loading') return;
          const fileGeneration = quotaStore.getState().fileGenerations[file.name];
          try {
            const translate = typeof i18n?.t === 'function' ? i18n.t.bind(i18n) : key => key;
            const data = await adapter.fetchQuota(file, translate);
            const state = quotaStore.getState();
            if (state.cacheGeneration !== generation || state.fileGenerations[file.name] !== fileGeneration) return;
            state[adapter.storeSetter](previous => ({ ...previous, [key]: adapter.buildSuccessState(data) }));
            retries.delete(key);
          } catch (error) {
            // Preserve the last reading and avoid repeated rate limited requests.
            retries.set(key, Date.now() + (/429/.test(String(error)) ? 600000 : 60000));
          }
        }));
      } catch { /* The next scheduled update will retry a disconnected server. */ }
      finally { busy = false; }
    };
    globalThis.duckweedRefreshQuotas = tick;
    const unsubscribe = authStore.subscribe?.(() => { void tick(); });
    const timer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    setTimeout(tick, 1000);
    return { tick, stop() { unsubscribe?.(); clearInterval(timer); document.removeEventListener('visibilitychange', tick); } };
  };
})();
