// Only a fresh, successful quota probe can release an obsolete credential-wide cooldown.
function canRecoverQuota(source, observation, now = Date.now()) {
  if (source.provider !== 'codex' || source.disabled || observation.error || observation.available !== true) return false;
  const attemptedAt = Date.parse(observation.attemptedAt), checkedAt = Date.parse(observation.checkedAt);
  if (!Number.isFinite(attemptedAt) || !Number.isFinite(checkedAt)
    || checkedAt < attemptedAt || checkedAt > now || now - attemptedAt > 60000) return false;
  // Do not overwrite a newer limit reported by an inference request during this probe.
  if (Date.parse(source.quota?.observed_at) > attemptedAt) return false;
  const windows = observation.windows || [];
  if (!windows.some(w => w.id.startsWith('main-')) || !windows.every(w => Number.isFinite(w.remainingPercent)
    && w.remainingPercent > 0 && (!w.resetAt || Date.parse(w.resetAt) > now))) return false;
  const cooldowns = (source.cooldowns || []).filter(c => c.remaining_seconds > 0 || Date.parse(c.retry_at) > now);
  if (!cooldowns.some(c => c.scope === 'credential' && ['quota', 'credential_quota'].includes(c.reason))) return false;
  // The native reset clears all cooldowns, so preserve authentication and non-quota failures.
  return cooldowns.every(c => ['quota', 'credential_quota'].includes(c.reason)
    && (c.http_status == null || c.http_status === 429));
}

async function recoverQuotaCooldown(source, observation, management) {
  if (!canRecoverQuota(source, observation)) return false;
  const { files = [] } = await management('/auth-files');
  const current = files.find(a => a.auth_index === source.auth_index);
  if (!current || !canRecoverQuota(current, observation)) return false;
  const result = await management('/v8/management/routing/cooldown/reset', 'POST', { auth_index: current.auth_index });
  if (result.status !== 'ok') throw new Error('The quota cooldown could not be reset.');
  observation.status = 'active';
  observation.cooldownResetAt = new Date().toISOString();
  return true;
}

module.exports = { canRecoverQuota, recoverQuotaCooldown };
