// Reconcile confirmed Claude quota recovery with the proxy's persisted scheduler gates.
// The reset endpoint clears every gate for an account, so mixed/auth failures are excluded.
function quotaCooldowns(account, now = Date.now()) {
  if (account.disabled || !Array.isArray(account.cooldowns) || !account.cooldowns.length) return false;
  return account.cooldowns.every(c => ['quota', 'credential_quota'].includes(c.reason) &&
    (!c.http_status || c.http_status === 429) && Date.parse(c.retry_at) > now);
}
function usableQuota(observation, now = Date.now()) {
  const checkedAt = Date.parse(observation.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 60000) return false;
  if (observation.provider !== 'claude' || observation.disabled || observation.error || observation.available !== true) return false;
  const usage = observation.usage;
  // Explicit null means no active window. Missing/malformed core fields are inconclusive.
  if (!usage || !['five_hour', 'seven_day'].every(id => Object.hasOwn(usage, id) &&
    (usage[id] === null || (Number.isFinite(usage[id]?.utilization) && usage[id].utilization >= 0 &&
      usage[id].utilization < 100 && !usage[id].locked_reason)))) return false;
  if (!observation.windows?.length || observation.windows.some(w => !(w.remainingPercent > 0) || (w.resetAt && !(Date.parse(w.resetAt) > now)))) return false;
  return !(usage.limits || []).some(limit => limit.is_active &&
    (limit.percent >= 100 || limit.locked_reason));
}
function quotaImproved(old, observation) {
  if (!old?.routingRecovery) return true; // One migration check for pre-existing persisted cooldowns.
  if (old.routingRecovery.error) return true; // Retry a failed local reconciliation on the next fresh reading.
  if (old.available === false) return true;
  if (['five_hour', 'seven_day'].some(id => old.usage?.[id]?.utilization > 0 && observation.usage[id] === null)) return true;
  return observation.windows.some(w => {
    const before = old.windows?.find(previous => previous.id === w.id);
    return before && w.remainingPercent > before.remainingPercent;
  });
}
function latestObservation(account) {
  return Math.max(0, ...[account.quota, ...Object.values(account.model_quotas || {})]
    .map(quota => Date.parse(quota?.observed_at)).filter(Number.isFinite));
}
async function reconcileClaudeCooldown(account, old, observation, probeStartedAt, management) {
  const previousReset = old?.routingRecovery?.resetAt || null;
  const recovery = { checkedAt: observation.checkedAt, resetAt: previousReset, error: null };
  if (!Number.isFinite(probeStartedAt) || probeStartedAt > Date.parse(observation.checkedAt) ||
    Date.now() - probeStartedAt > 60000) return recovery;
  if (!usableQuota(observation) || !quotaCooldowns(account) || !quotaImproved(old, observation)) return recovery;
  try {
    // Recheck after the network probe: a concurrent 429 or pause must take precedence.
    const { files = [] } = await management('/auth-files');
    const current = files.find(file => file.auth_index === account.auth_index);
    if (!current || !quotaCooldowns(current) || latestObservation(current) > probeStartedAt) return recovery;
    // A changed deadline can represent a newer failure without quota observation headers.
    const gates = file => JSON.stringify(file.cooldowns.map(({scope, model_key, reason, retry_at, http_status}) =>
      [scope, model_key, reason, retry_at, http_status]).sort());
    if (gates(current) !== gates(account)) return recovery;
    const result = await management('/v8/management/routing/cooldown/reset', 'POST', { auth_index: account.auth_index });
    if (result.status !== 'ok') throw new Error('The quota cooldown could not be reset.');
    observation.status = 'active';
    recovery.resetAt = new Date().toISOString();
  } catch (error) {
    // Keep the successful provider reading and retry the local repair at the next scheduled probe.
    recovery.error = error.message;
  }
  return recovery;
}
module.exports = { quotaCooldowns, usableQuota, quotaImproved, reconcileClaudeCooldown };
