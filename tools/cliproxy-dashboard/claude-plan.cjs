const fs = require('node:fs');
const path = require('node:path');
const DAY = 86400000;

// The plan badge needs four profile fields. Reset confirmations still fetch their own live profile.
function createPlanReader(root, management, retryAfterMs) {
  const filename = path.join(root, 'claude-plan-cache.json');
  const pending = new Map();
  let records;
  try { records = JSON.parse(fs.readFileSync(filename, 'utf8')) || {}; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; records = {}; }

  async function update(id, account) {
    const now = Date.now();
    const old = records[id];
    if (now < (old?.nextRead || 0) || now < Date.parse(account?.retryAt)) return old?.profile || null;
    let profile = old?.profile || null;
    let delay = 600000;
    try {
      const result = await management('/api-call', 'POST', { auth_index: id, method: 'GET',
        url: 'https://api.anthropic.com/api/oauth/profile',
        header: { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-cli/2.1.322 (external, cli)', Accept: 'application/json' } });
      if (result.status_code === 200) {
        const data = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
        profile = { account: { has_claude_max: data.account?.has_claude_max, has_claude_pro: data.account?.has_claude_pro },
          organization: { organization_type: data.organization?.organization_type, subscription_status: data.organization?.subscription_status } };
        delay = DAY;
      } else delay = Math.max(delay, retryAfterMs(result.header));
    } catch (error) { delay = Math.max(delay, error.retryAfterMs || 0); }
    records[id] = { profile, nextRead: Date.now() + delay };
    const temp = filename + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(records), { flush: true });
    fs.renameSync(temp, filename);
    return profile;
  }
  return (id, account) => {
    if (!pending.has(id)) pending.set(id, update(id, account).finally(() => pending.delete(id)));
    return pending.get(id);
  };
}
module.exports = { createPlanReader };
