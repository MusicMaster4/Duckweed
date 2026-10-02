function claudeCacheResult(account, now = Date.now()) {
  const checkedAt = account.checkedAt;
  const cached = !!account.error || now - Date.parse(checkedAt) > 5000;
  const metadata = { cached, checkedAt, error: account.error || null, retryAt: account.retryAt || null };
  let usage = account.usage;
  if (!usage) {
    usage = {};
    for (const window of account.windows || []) {
      if (!/^(five_hour|seven_day(?:_[a-z]+)?|iguana_necktie)$/.test(window.id) || typeof window.remainingPercent !== 'number') continue;
      usage[window.id] = { utilization: 100 - window.remainingPercent, resets_at: window.resetAt };
    }
    metadata.cached = true;
  }
  if (!checkedAt || !Object.keys(usage).length) {
    return { status_code: account.errorStatus || 503, header: {}, body: JSON.stringify({ error: {
      message: account.error ? `${account.error} ${account.retryAt ? 'Next retry: ' + account.retryAt + '.' : ''}`.trim() : 'Claude quota has not been loaded yet.',
      type: account.errorStatus === 429 ? 'rate_limit_error' : 'quota_unavailable',
    } }) };
  }
  return { status_code: 200, header: {}, body: JSON.stringify({ ...usage, _duckweed_cache: metadata }) };
}
module.exports = { claudeCacheResult };
