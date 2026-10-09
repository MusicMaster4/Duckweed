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
            const data = await adapter.fetchQuota(file, i18n.t.bind(i18n));
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
    const timer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    setTimeout(tick, 1000);
    return { tick, stop() { clearInterval(timer); document.removeEventListener('visibilitychange', tick); } };
  };
})();
