(() => {
  'use strict';
  // Grouped quota view for the management panel. The bundle passes its own React,
  // helpers and quota state in, so this file never reaches into minified internals.
  const VIEW_KEY = 'duckweed.quotaView';
  const PRIVATE_KEY = 'duckweed.quotaPrivacy';
  const WEIGHTS_KEY = 'duckweed.poolWeights';
  let initialized = false;
  let weightRevision = 0;
  let accountNames = {}, namesRevision = 0;
  const fileId = file => String(file.auth_index || file.authIndex || file.name || '');
  const customName = file => typeof accountNames[fileId(file)] === 'string' ? accountNames[fileId(file)] : '';
  const setNames = next => { accountNames = next; namesRevision += 1; listeners.forEach(listener => listener()); };
  let privateMode = (() => { try { return localStorage.getItem(PRIVATE_KEY) === 'true'; } catch { return false; } })();
  let weights = (() => { try { return JSON.parse(localStorage.getItem(WEIGHTS_KEY)) || {}; } catch { return {}; } })();
  const weightOf = file => Math.max(.1, Math.min(100, Number(weights[file.auth_index || file.authIndex || file.name]) || 1));
  const privacySnapshot = () => privateMode;
  const setPrivate = next => {
    privateMode = next;
    document.documentElement.toggleAttribute('data-dqx-private', next);
    try { localStorage.setItem(PRIVATE_KEY, String(next)); } catch {}
    if (next) setView('ledger');
    listeners.forEach(listener => listener());
  };
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-dqx-private', privateMode);
  const listeners = new Set();
  let view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'ledger'; } catch { return 'ledger'; } })();
  const setView = next => {
    view = next;
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* Private mode keeps the choice for this page only. */ }
    listeners.forEach(listener => listener());
  };
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const getView = () => view;

  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const clamp = value => Math.max(0, Math.min(100, value));
  const fromUsed = used => num(used) === null ? null : clamp(100 - used);
  const parseTime = value => {
    if (num(value) !== null) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  const shortLabel = label => {
    const text = String(label ?? '');
    return text.replace(/\b(limits?|remaining|usage)\b/gi, '').replace(/\s{2,}/g, ' ').trim() || text;
  };
  const tone = percent => percent === null ? 'none' : percent > 30 ? 'high' : percent > 10 ? 'mid' : 'low';
  // The 5-hour window drains fast, so it uses tighter thresholds: above 30% green, 11-30% yellow, 10% or less red.
  const sessionTone = percent => percent === null ? 'none' : percent > 30 ? 'high' : percent > 10 ? 'mid' : 'low';
  const isSession = meter => meter.period === 5 || /^(five-hour|5h|five_hour)$/.test(String(meter.id));
  const fmtPercent = value => value === null ? '--' : `${Math.round(value)}%`;
  const keyOf = label => String(label ?? '').trim().toLowerCase();

  function codexPlan(planType, t) {
    const plan = typeof planType === 'string' ? planType.trim().toLowerCase() : '';
    if (!plan) return null;
    if (plan === 'self_serve_business_prolite') return t('codex_quota.plan_business_premium');
    if (plan === 'pro') return t('codex_quota.plan_pro');
    if (['prolite', 'pro-lite', 'pro_lite'].includes(plan)) return t('codex_quota.plan_prolite');
    if (['plus', 'team', 'free'].includes(plan)) return t(`codex_quota.plan_${plan}`);
    return planType;
  }

  function antigravityPlan(subscription, t) {
    if (!subscription) return null;
    const plan = subscription.plan;
    if (['free', 'pro', 'ultra'].includes(plan)) return t(`antigravity_subscription.plan_${plan}`);
    if (plan === 'ultra-lite') return t('antigravity_subscription.plan_ultra_lite');
    return subscription.tierName || subscription.tierId || null;
  }

  // Reduce each provider's quota payload to the same shape: a plan, a few chips and meters.
  function normalize(type, quota, t) {
    const result = { plan: null, planTitle: '', chips: [], meters: [], note: '' };
    if (!quota || quota.status !== 'success') return result;
    if (type === 'claude') {
      result.plan = quota.planType ? t(`claude_quota.${quota.planType}`) : null;
      const extra = quota.extraUsage;
      if (extra?.is_enabled) result.chips.push({ text: `$${(extra.used_credits / 100).toFixed(2)} / $${(extra.monthly_limit / 100).toFixed(2)}`, title: t('claude_quota.extra_usage_label') });
      if (quota.localCache?.cached || quota.localCache?.error) result.chips.push({ text: 'cached', title: globalThis.duckweedQuotaNote?.(quota.localCache) ?? '' });
      result.meters = (quota.windows ?? []).map(w => ({ id: w.id, label: shortLabel(w.labelKey ? t(w.labelKey) : w.label), remaining: fromUsed(w.usedPercent), resetAtMs: num(w.resetAtMs), period: num(w.periodHours) }));
    } else if (type === 'codex') {
      result.plan = codexPlan(quota.planType, t);
      if (quota.subscriptionActiveUntil) result.planTitle = `${t('codex_quota.expires_label')}: ${new Date(parseTime(quota.subscriptionActiveUntil) ?? quota.subscriptionActiveUntil).toLocaleString('en-US')}`;
      if (quota.creditsUnlimited) result.chips.push({ text: '∞ credits', title: t('codex_quota.credit_balance_label') });
      else if (Number(quota.creditBalance) > 0) result.chips.push({ text: `${quota.creditBalance} credits`, title: t('codex_quota.credit_balance_label') });
      result.meters = (quota.windows ?? []).map(w => ({ id: w.id, label: shortLabel(w.labelKey ? t(w.labelKey, w.labelParams) : w.label), remaining: fromUsed(w.usedPercent), resetAtMs: num(w.resetAtMs), period: num(w.periodHours) }));
    } else if (type === 'antigravity') {
      result.plan = antigravityPlan(quota.subscription, t);
      for (const group of quota.groups ?? []) {
        const groupName = String(group.label ?? '').replace(/\s*models?$/i, '').replace(/\s+and\s+/i, ' / ').trim();
        const buckets = group.buckets ?? [];
        for (const bucket of buckets) {
          const bucketName = shortLabel(bucket.label);
          const label = buckets.length > 1 || !groupName ? [groupName, bucketName].filter(Boolean).join(' · ') : groupName;
          const fraction = num(bucket.remainingFraction);
          result.meters.push({ id: `${keyOf(group.label)}|${keyOf(bucket.label)}`, label, title: bucket.description || group.description || '', remaining: fraction === null ? null : clamp(Math.round(fraction * 100)), resetAtMs: num(bucket.resetAtMs) ?? parseTime(bucket.resetTime), period: num(bucket.periodHours) });
        }
      }
    } else if (type === 'xai') {
      const billing = quota.billing;
      if (!billing) return result;
      result.plan = billing.planLabel ?? null;
      if (billing.mode === 'paid-health') { result.note = t('xai_quota.paid_health'); return result; }
      const weekly = billing.periodType === 'weekly';
      const reset = weekly ? num(billing.resetAtMs) : null;
      if (weekly && num(billing.usagePercent) !== null) result.meters.push({ id: 'weekly', label: 'Weekly', remaining: fromUsed(billing.usagePercent), resetAtMs: reset, period: 168 });
      for (const product of billing.productUsage ?? []) {
        const name = String(product.product ?? '');
        result.meters.push({ id: `product:${keyOf(name)}`, label: name.replace(/^grok\s*/i, '') || name, title: name, remaining: fromUsed(product.usagePercent), resetAtMs: reset, period: weekly ? 168 : null });
      }
      if (Number(billing.onDemandCapCents) > 0) result.meters.push({ id: 'on-demand', label: 'Pay as you go', remaining: fromUsed(billing.onDemandUsedPercent), resetAtMs: null, period: null });
      if (Number(billing.monthlyLimitCents) > 0) result.meters.push({ id: 'monthly', label: 'Monthly', remaining: fromUsed(billing.usedPercent), resetAtMs: parseTime(billing.billingPeriodEnd), period: 720 });
      if (Number(billing.prepaidBalanceCents) > 0) result.chips.push({ text: `$${(billing.prepaidBalanceCents / 100).toFixed(2)}`, title: t('xai_quota.prepaid') });
    } else if (type === 'kimi') {
      result.meters = (quota.rows ?? []).map(row => ({ id: row.id, label: shortLabel(row.labelKey ? t(row.labelKey, row.labelParams ?? {}) : row.label), remaining: row.limit > 0 ? clamp(Math.round((row.limit - row.used) / row.limit * 100)) : row.used > 0 ? 0 : null, resetAtMs: num(row.resetAtMs), period: num(row.periodHours) }));
    } else if (type === 'devin') {
      result.plan = quota.plan ?? null;
      result.meters = (quota.windows ?? []).map(w => ({ id: w.id, label: shortLabel(t(`devin_quota.${w.id}`)), remaining: num(w.remainingPercent), resetAtMs: num(w.resetAtMs), period: num(w.periodHours) }));
    } else if (type === 'meta') {
      const data = quota.data;
      if (!data) return result;
      result.plan = data.planName ?? null;
      result.meters = (data.windows ?? []).map(w => ({ id: w.id, label: shortLabel(w.id === 'window' && w.durationMinutes ? t('meta_quota.window_duration', { minutes: w.durationMinutes }) : t(`meta_quota.${w.id}`)), remaining: fromUsed(w.usedPercent), resetAtMs: num(w.resetAt) === null ? null : w.resetAt * 1000, period: w.id === 'weekly' ? 168 : num(w.durationMinutes) === null ? null : w.durationMinutes / 60 }));
    }
    return result;
  }

  function accountName(file, siblings) {
    const base = file.email || file.label || file.account || String(file.name ?? '').replace(/\.json$/i, '');
    if (privateMode) return `Account ${siblings.indexOf(file) + 1}`;
    if (customName(file)) return customName(file);
    return siblings.filter(other => (other.email || other.label || other.account) === base).length > 1 ? String(file.name).replace(/\.json$/i, '') : base;
  }

  // Columns are aggregated per meter id so several accounts of one provider add up (2 accounts = 200%).
  function buildGroup(type, entries, props, now) {
    const t = props.t;
    const rows = entries.map(entry => {
      const quota = props.quotaFor(entry);
      return { entry, quota, status: entry.file.disabled ? 'disabled' : quota?.status ?? 'idle', data: normalize(type, quota, t) };
    });
    const columns = new Map();
    rows.forEach(row => row.data.meters.forEach(meter => {
      let column = columns.get(meter.id);
      if (!column) columns.set(meter.id, column = { id: meter.id, label: meter.label, title: meter.title, period: meter.period, session: isSession(meter), sum: 0, count: 0, reset: null });
      if (meter.remaining === null) return;
      if (row.entry.file.disabled) return;
      column.sum += meter.remaining * weightOf(row.entry.file);
      column.count += 1;
      column.capacity = (column.capacity || 0) + 100 * weightOf(row.entry.file);
      if (meter.resetAtMs !== null && meter.resetAtMs > now && (column.reset === null || meter.resetAtMs < column.reset)) column.reset = meter.resetAtMs;
    }));
    const measured = [...columns.values()].filter(column => column.count > 0 && !column.session);
    const weekly = measured.filter(column => column.period !== null && column.period >= 144 && column.period <= 192);
    const pool = weekly.length > 0 ? weekly : measured;
    let primary = pool.reduce((best, column) => best === null || column.sum / column.count < best.sum / best.count ? column : best, null);
    const ordered = [...columns.values()].filter(column => !column.session);
    if (type === 'claude') {
      const all = measured.find(c => /^(seven_day|seven-day|weekly)$/.test(c.id) || (/7.day|weekly/i.test(c.label) && !/fable|sonnet|opus|haiku/i.test(c.label)));
      if (all) primary = all;
    }
    if (primary) ordered.sort((a, b) => (b === primary) - (a === primary));
    const session = [...columns.values()].find(column => column.session) ?? null;
    return { type, rows, columns: ordered, primary, session };
  }

  const absoluteTime = ms => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  function poolMembers(group) {
    if (!group.primary) return [];
    return group.rows.filter(row => !row.entry.file.disabled && row.status === 'success').flatMap(row => {
      const meter = row.data.meters.find(m => m.id === group.primary.id);
      if (!meter || meter.remaining === null) return [];
      return [{ id: row.entry.file.auth_index || row.entry.file.authIndex, weight: weightOf(row.entry.file), remaining: meter.remaining, reset: meter.resetAtMs, period: meter.period, row }];
    });
  }
  function nextReset(group, now) {
    const future = poolMembers(group).filter(m => m.reset > now).sort((a, b) => a.reset - b.reset);
    if (!future.length) return null;
    const at = future[0].reset;
    return { at, gain: future.filter(m => m.reset === at).reduce((sum, m) => sum + (100 - m.remaining) * m.weight, 0) };
  }
  function historyWindow(account, column) {
    const windows = account.windows || [];
    const canonical = id => String(id).replace(/[-_]/g, '').toLowerCase();
    return windows.find(w => canonical(w.id) === canonical(column.id)) ||
      windows.find(w => (column.period >= 144 && column.period <= 192 || /weekly|seven.day|7.day/i.test(column.id)) && /weekly|7.day|seven.day/i.test(w.label + ' ' + w.id) && !/fable|sonnet|opus|haiku|review/i.test(w.label + ' ' + w.id));
  }
  function historySeries(group, samples, partial = false) {
    const members = poolMembers(group);
    if (!members.length) return [];
    let previous = '';
    return samples.flatMap(sample => {
      const values = members.map(member => {
        const account = sample.accounts.find(a => a.id === member.id && a.provider === group.type);
        const window = account && historyWindow(account, group.primary);
        return window && num(window.remainingPercent) !== null ? { id: member.id, remaining: window.remainingPercent, reset: parseTime(window.resetAt), checkedAt: parseTime(account.checkedAt), weight: member.weight } : null;
      });
      if (!partial && values.some(v => !v)) return [];
      if (values.every(v => !v)) return [];
      const signature = JSON.stringify(values);
      if (signature === previous) return [];
      previous = signature;
      return [{ at: sample.at, value: values.some(v => !v) ? null : values.reduce((sum, v) => sum + v.remaining * v.weight, 0), values }];
    }).sort((a, b) => a.at - b.at);
  }
  function burnAnalysis(series, now, expectedIds) {
    const accounts = new Map((expectedIds || []).map(id => [id, { id, last: null, loss: 0, elapsed: 0, resetPending: false }]));
    for (const point of series) {
      if (point.at > now) continue;
      (point.values || []).forEach((value, index) => {
        if (!value || !Number.isFinite(value.checkedAt) || value.checkedAt > now) return;
        const id = value.id ?? index;
        let account = accounts.get(id);
        if (!account) accounts.set(id, account = { id, last: null, loss: 0, elapsed: 0, resetPending: false });
        const previous = account.last;
        // A cached copy of one account must not block another account's fresh reading.
        if (previous && value.checkedAt <= previous.checkedAt) return;
        account.last = value;
        if (!previous || previous.checkedAt < now - 3 * 3600000) return;
        const duration = value.checkedAt - previous.checkedAt;
        const reset = Math.abs((previous.reset || 0) - (value.reset || 0)) > 60000 || value.remaining > previous.remaining;
        if (reset) { account.resetPending = true; return; }
        if (duration <= 0 || duration > 1800000) return;
        account.elapsed += duration;
        account.loss += Math.max(0, previous.remaining - value.remaining) * (Number.isFinite(value.weight) ? value.weight : 1);
        account.resetPending = false;
      });
    }
    const values = [...accounts.values()];
    const missing = !values.length || values.some(account => !account.last);
    const stale = values.some(account => account.last && now - account.last.checkedAt > 20 * 60000);
    const ready = !missing && !stale && values.every(account => account.elapsed >= 300000);
    const reason = missing ? 'Waiting for first reading' : stale ? 'Quota update delayed' :
      values.some(account => account.elapsed < 300000 && account.resetPending) ? 'Waiting after reset' : 'Waiting for next reading';
    return { rate: ready ? values.reduce((sum, account) => sum + account.loss / (account.elapsed / 3600000), 0) : null,
      reason, accounts: values };
  }
  function burnRate(series, now) { return burnAnalysis(series, now).rate; }
  function projectPool(members, rate, now, until) {
    const accounts = members.map(m => ({ ...m, balance: m.remaining * m.weight }));
    const total = () => accounts.reduce((s, m) => s + m.balance, 0);
    const points = [{ at: now, value: total() }], events = [];
    for (const member of accounts) {
      if (member.reset > now && member.period > 0) {
        for (let at = member.reset; at <= until; at += member.period * 3600000) events.push({ at, member });
      } else if (member.reset > now && member.reset <= until) events.push({ at: member.reset, member });
    }
    events.sort((a, b) => a.at - b.at);
    let cursor = now, poolEmpty = total() <= 0 ? now : null, firstEmpty = accounts.some(m => m.balance === 0) ? now : null;
    const draw = at => {
      let spent = (rate || 0) * (at - cursor) / 3600000;
      const before = total();
      if (rate > 0 && before > 0 && spent >= before) {
        const depleted = cursor + before / rate * 3600000;
        points.push({ at: depleted, value: 0 });
        poolEmpty ??= depleted;
      }
      // Route consumption to the account with the nearest reset first.
      let allocated = 0;
      for (const member of accounts.slice().sort((a, b) => (a.reset || Infinity) - (b.reset || Infinity))) {
        const used = Math.min(member.balance, spent);
        if (rate > 0 && member.balance > 0 && used >= member.balance) firstEmpty ??= cursor + (allocated + used) / rate * 3600000;
        allocated += used; member.balance -= used; spent -= used;
      }
      points.push({ at, value: total() }); cursor = at;
    };
    const resets = [];
    for (let i = 0; i < events.length;) {
      const at = events[i].at;
      draw(at);
      const before = total();
      while (i < events.length && events[i].at === at) { const member = events[i++].member; member.balance = 100 * member.weight; }
      resets.push({ at, gain: total() - before });
      points.push({ at, value: total() });
    }
    draw(until);
    return { points, resets, poolEmpty, firstEmpty };
  }

  function createView(React) {
    const h = React.createElement;
    const { useSyncExternalStore, useState, useEffect } = React;

    const svg = (paths, size = 14) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, paths.map((d, i) => h('path', { d, key: i })));
    const RowsIcon = () => svg(['M3 6h18', 'M3 12h18', 'M3 18h18']);
    const GridIcon = () => svg(['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z']);
    const ResetIcon = () => svg(['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5']);

    function ProviderIcon({ type, props, size = 18 }) {
      const src = props.icon(type, props.theme);
      const name = props.providerName(props.t, type);
      const style = props.iconNeedsBg(type) ? { background: props.iconBg(props.theme) } : undefined;
      return h('span', { className: 'dqx-icon', style, title: name, 'data-size': size },
        src ? h('img', { src, alt: '', width: size, height: size }) : h('span', { className: 'dqx-icon-fallback' }, name.slice(0, 1).toUpperCase()));
    }

    const Bar = ({ percent, session = false }) => h('span', { className: session ? 'dqx-bar dqx-bar-session' : 'dqx-bar', 'data-tone': tone(percent) },
      h('span', { className: 'dqx-fill', 'data-tone': (session ? sessionTone : tone)(percent), style: { width: `${percent ?? 0}%` } }));

    function resetText(props, ms, now) {
      if (ms === null) return '';
      if (ms <= now) return 'Awaiting refresh';
      const minutes = Math.max(1, Math.ceil((ms - now) / 60000));
      const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
      return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
    }

    function Cell({ meter, props, now }) {
      if (!meter) return h('div', { className: 'dqx-cell dqx-cell-empty' }, 'Unavailable');
      const soon = meter.resetAtMs !== null && meter.resetAtMs > now && meter.resetAtMs - now < 3600000;
      return h('div', { className: 'dqx-cell', title: meter.title || undefined },
        h('div', { className: 'dqx-cell-head' }, h('span', { className: 'dqx-cell-label' }, meter.label), h('b', { 'data-tone': tone(meter.remaining) }, `${fmtPercent(meter.remaining)}${meter.remaining === null ? '' : ' left'}`)),
        h(Bar, { percent: meter.remaining }),
        h('div', { className: soon ? 'dqx-cell-foot dqx-soon' : 'dqx-cell-foot' }, resetText(props, meter.resetAtMs, now) || ' '));
    }

    function Row({ row, group, props, now, siblings }) {
      const { entry, quota, status, data } = row;
      const { t } = props;
      const adapter = props.adapters[entry.type];
      const loading = status === 'loading';
      const resetting = props.resettingKey === props.cacheKey(entry.file);
      const canRefresh = props.canRefresh && !entry.file.disabled;
      const refresh = () => props.onRefresh(entry);
      // The bundle's Claude reset hook must run for every row to keep hook order stable.
      const claudeReset = props.useClaudeReset(entry.file, entry.type === 'claude' && status !== 'idle', !canRefresh || loading || resetting, quota, refresh);
      const canCodexReset = status === 'success' && !!adapter.resetQuota && !!adapter.canResetQuota?.(quota);
      const codexCredits = quota?.rateLimitResetCreditsAvailableCount ?? null;
      const span = { gridColumn: `2 / span ${Math.max(group.columns.length, 1)}` };
      let body;
      if (status === 'success') {
        body = data.meters.length === 0
          ? h('div', { className: 'dqx-row-msg', style: span }, data.note || t(`${adapter.i18nPrefix}.empty_data`, { defaultValue: 'No quota data' }))
          : group.columns.map(column => h(Cell, { key: column.id, meter: data.meters.find(meter => meter.id === column.id), props, now }));
      } else if (status === 'loading') {
        body = (group.columns.length ? group.columns : [{ id: 'loading' }]).map(column => h('div', { key: column.id, className: 'dqx-cell dqx-skeleton' }, h('span', null), h(Bar, { percent: null }), h('span', null)));
      } else if (status === 'error') {
        const message = privateMode ? 'Quota update unavailable' : quota?.error || t('common.unknown_error');
        body = h('div', { className: 'dqx-row-msg dqx-error', style: span, title: message }, message);
      } else if (status === 'disabled') {
        body = h('div', { className: 'dqx-row-msg', style: span }, t('auth_files.status_disabled', { defaultValue: 'Disabled' }));
      } else {
        body = h('div', { className: 'dqx-row-msg', style: span }, h('button', { type: 'button', className: 'dqx-link', onClick: refresh, disabled: !canRefresh }, t(`${adapter.i18nPrefix}.idle`)));
      }
      const session = status === 'success' && group.session ? data.meters.find(meter => meter.id === group.session.id) ?? null : null;
      const sessionReset = session ? resetText(props, session.resetAtMs, now) : '';
      const showClaudeReset = entry.type === 'claude' && status === 'success' && (claudeReset.count > 0 || claudeReset.buttonLabel === 'retry');
      return h('div', { className: 'dqx-row', 'data-status': status },
        h('div', { className: 'dqx-acct' },
          h('div', { className: 'dqx-acct-name', title: privateMode ? undefined : props.label(entry.file) }, accountName(entry.file, siblings)),
          !privateMode && customName(entry.file) && entry.file.email && h('div', { className: 'dqx-account-email' }, entry.file.email),
          h('div', { className: 'dqx-acct-sub' },
            data.plan && h('span', { className: 'dqx-plan', title: data.planTitle || undefined }, data.plan),
            data.chips.map(chip => h('span', { key: chip.text, className: 'dqx-chip', title: chip.title || undefined }, chip.text)),
            claudeReset.message && h('span', { className: 'dqx-chip dqx-error', title: t(`claude_reset.${claudeReset.message}`) }, '!'))),
        body,
        h('div', { className: 'dqx-actions' },
          h('button', { type: 'button', className: 'dqx-btn', 'aria-label': `Rename ${accountName(entry.file, siblings)}`, title: 'Rename account', 'data-action': 'rename', onClick: () => props.onRenameAccount?.(entry.file) }, svg(['M16 3l5 5-12 12H4v-5z','M14 5l5 5'])),
          showClaudeReset && h('button', { type: 'button', className: 'dqx-btn', 'data-action': 'reset', disabled: claudeReset.blocked, onClick: claudeReset.confirm, 'aria-label': 'Reset Claude limits', title: `${t(`claude_reset.${claudeReset.buttonLabel}`)} · ${t('claude_reset.remaining')} ${claudeReset.count ?? '--'}`, 'data-busy': claudeReset.busy },
            h(ResetIcon), claudeReset.count > 0 && h('span', { className: 'dqx-btn-count' }, claudeReset.count)),
          canCodexReset && h('button', { type: 'button', className: 'dqx-btn', 'data-action': 'reset', disabled: !canRefresh || loading || resetting, onClick: () => props.onReset(entry), 'aria-label': 'Reset Codex quota', title: t('codex_quota.reset_button'), 'data-busy': resetting },
            h(ResetIcon), codexCredits > 0 && h('span', { className: 'dqx-btn-count' }, codexCredits)),
          h('button', { type: 'button', className: 'dqx-btn', 'data-action': 'refresh', disabled: !canRefresh || loading || resetting || claudeReset.busy, onClick: refresh, title: t('auth_files.quota_refresh_hint'), 'aria-label': 'Refresh quota only for this credential', 'data-busy': loading },
            h(props.RefreshIcon, { size: 14 }))),
        session && h('div', { className: 'dqx-session', 'data-tone': sessionTone(session.remaining), title: session.label },
          h('span', { className: 'dqx-session-label' }, '5h'),
          h(Bar, { percent: session.remaining, session: true }),
          h('b', { 'data-tone': tone(session.remaining) }, fmtPercent(session.remaining)),
          h('span', { className: 'dqx-session-reset' }, sessionReset)));
    }

    function Section({ group, props, now }) {
      const files = group.rows.map(row => row.entry.file);
      const [collapsed, collapse] = useState(false);
      const [configuring, configure] = useState(false);
      const [revision, revise] = useState(0);
      const pending = nextReset(group, now);
      return h('section', { className: 'dqx-section', 'data-provider': group.type, style: { '--dqx-cols': Math.max(group.columns.length, 1) } },
        h('header', { className: 'dqx-section-head' },
          h(ProviderIcon, { type: group.type, props, size: 17 }),
          h('strong', null, props.providerName(props.t, group.type)),
          h('span', { className: 'dqx-count' }, group.rows.length),
          group.primary && h('span', { className: 'dqx-inline-pool', title: 'Pool points are normalized account percentages, multiplied by your configured pool weights.' },
            h('b', { 'data-tone': tone(group.primary.sum / group.primary.capacity * 100) }, fmtPercent(group.primary.sum)), ` of ${group.primary.capacity}% pool`),
          pending && h('span', { className: 'dqx-next' }, `Next reset +${Math.round(pending.gain)}% \u00b7 ${absoluteTime(pending.at)}`),
          h('span', { className: 'dqx-section-spacer' }),
          h('button', { type: 'button', className: 'dqx-link', 'aria-expanded': configuring, onClick: () => configure(!configuring) }, 'Pool weights'),
          h('button', { type: 'button', className: 'dqx-link', 'aria-expanded': !collapsed, onClick: () => collapse(!collapsed) }, collapsed ? 'Expand' : 'Collapse')),
        configuring && h('div', { className: 'dqx-weight-editor' },
          h('p', null, 'Normalize different plans for comparison. Weights only change the pool display.'),
          files.map(file => h('label', { key: props.cacheKey(file) },
            accountName(file, files),
            h('input', { type: 'number', min: '.1', max: '100', step: '.1', 'aria-label': `Pool weight for ${accountName(file, files)}`, value: weightOf(file), onChange: event => {
              const value = Number(event.target.value); if (!(value >= .1 && value <= 100)) return;
              weights[file.auth_index || file.authIndex || file.name] = value;
              try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights)); } catch {}
              weightRevision += 1; revise(revision + 1); listeners.forEach(listener => listener());
            } })))),
        !collapsed && h(React.Fragment, null,
          h('div', { className: 'dqx-columns', 'aria-hidden': true }, h('span', null, 'Credential'), group.columns.map(column => h('span', { key: column.id }, column.label)), h('span', null, 'Actions')),
          h('div', { className: 'dqx-rows' }, group.rows.map(row => h(Row, { key: props.cacheKey(row.entry.file), row, group, props, now, siblings: files })))));
    }

    function Forecast({ group, props, now, samples, horizon }) {
      const [hover, setHover] = useState(null);
      const members = poolMembers(group);
      const series = historySeries(group, samples);
      const observations = historySeries(group, samples, true);
      const analysis = burnAnalysis(observations, now, members.map(member => member.id));
      const fresh = members.length > 0 && analysis.accounts.length === members.length && analysis.accounts.every(account => account.last && now - account.last.checkedAt <= 20 * 60000);
      const measuredRate = fresh ? analysis.rate : null;
      const complete = members.length > 0 && members.length === group.rows.filter(row => !row.entry.file.disabled).length;
      const rate = complete ? measuredRate : null;
      const until = now + horizon * 86400000;
      const projection = projectPool(members, rate, now, until);
      const pending = projection.resets[0] || nextReset(group, now);
      const capacity = members.reduce((sum, m) => sum + 100 * m.weight, 0);
      const balance = members.reduce((sum, m) => sum + m.remaining * m.weight, 0);
      const start = now - Math.min(horizon, 7) * 86400000;
      const recorded = series.filter(point => point.at >= start && point.at <= now);
      const width = 1100, height = 270, left = 54, right = 20, top = 28, bottom = 35;
      const x = at => left + (at - start) / (until - start) * (width - left - right);
      const y = value => height - bottom - (capacity ? value / capacity : 0) * (height - bottom - top);
      const path = points => points.map((p, index) => `${index ? 'L' : 'M'}${x(p.at).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
      const color = group.type === 'claude' ? '#d88c79' : group.type === 'codex' ? '#8ab4f8' : '#91b9a3';
      const visibleProjection = complete && fresh && pending ? projection.points : [];
      const historyPath = path(recorded), futurePath = path(visibleProjection);
      const allPoints = [...recorded, ...visibleProjection.map(p => ({ ...p, projected: true }))];
      const tickCount = Math.min(horizon * 2 + 1, 15);
      const ticks = Array.from({ length: tickCount }, (_, i) => start + (until - start) * i / (tickCount - 1));
      const metric = (label, value) => h('div', { className: 'dqx-metric' }, h('span', null, label), h('strong', null, value));
      const waiting = !complete ? 'Waiting for account quotas' : analysis.accounts.some(account => !account.last) ? 'Waiting for first reading' : !fresh ? 'Quota update delayed' : analysis.reason;
      const cadence = group.type === 'claude' ? 600000 : 60000;
      const deadlines = analysis.accounts.filter(account => account.elapsed < 300000 && account.last).map(account => {
        const member = members.find(member => member.id === account.id);
        const retry = parseTime(member?.row.quota?.localCache?.retryAt) || 0;
        return Math.max(account.last.checkedAt + cadence, retry);
      });
      const nextReading = deadlines.length ? Math.max(...deadlines) : null;
      const historyNote = series.length ? `History since ${absoluteTime(series[0].at)}.` : 'History starts with the first saved reading.';
      const waitingNote = `${historyNote} ${group.type === 'claude' ? 'Claude quota updates about every 10 minutes. ' : ''}${nextReading > now ? `Next expected reading ${absoluteTime(nextReading)}.` : 'Waiting for a fresh comparable reading.'}${waiting === 'Waiting after reset' ? ' A replenishment cannot be counted as consumption.' : ''}`;
      const emptyText = rate === null ? waiting : projection.poolEmpty ? absoluteTime(projection.poolEmpty) : `Not by ${new Date(until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      return h('article', { className: 'dqx-forecast', style: { '--dqx-accent': color } },
        h('div', { className: 'dqx-forecast-title' }, h(ProviderIcon, { type: group.type, props }), h('strong', null, props.providerName(props.t, group.type)), h('span', null, `${members.length} ${members.length === 1 ? 'account' : 'accounts'}`)),
        h('div', { className: 'dqx-forecast-stats' },
          h('div', { className: 'dqx-pool-value', title: 'Account percentages normalized with your pool weights.' }, h('b', { 'data-tone': capacity ? tone(balance / capacity * 100) : 'none' }, group.primary ? `${Math.round(balance)}%` : 'Unavailable'), group.primary && h('span', null, `of ${capacity}%`)),
          metric('Pool empty', emptyText),
          metric('First empty', rate === null ? waiting : projection.firstEmpty ? (projection.firstEmpty <= now ? 'Already empty' : absoluteTime(projection.firstEmpty)) : 'None before reset'),
          metric('Next reset', pending ? `+${Math.round(pending.gain)}% ${absoluteTime(pending.at)}` : 'Unavailable'),
          metric('Burn, last 3h', rate === null ? waiting : `${rate.toFixed(1)}%/h`)),
        h('div', { className: 'dqx-chart-wrap' },
          h('svg', { viewBox: `0 0 ${width} ${height}`, className: 'dqx-chart', role: 'img', 'aria-label': `${props.providerName(props.t, group.type)} pool balance, recorded history and projected resets`, onPointerLeave: () => setHover(null), onPointerMove: event => {
            const rect = event.currentTarget.getBoundingClientRect();
            const target = start + ((event.clientX - rect.left) / rect.width * width - left) / (width - left - right) * (until - start);
            const nearest = allPoints.reduce((best, p) => !best || Math.abs(p.at - target) < Math.abs(best.at - target) ? p : best, null);
            setHover(nearest);
          } },
            [0, .5, 1].map(ratio => h('g', { key: ratio },
              h('line', { x1: left, x2: width - right, y1: y(capacity * ratio), y2: y(capacity * ratio), className: 'dqx-gridline' }),
              h('text', { x: left - 12, y: y(capacity * ratio) + 4, textAnchor: 'end' }, `${Math.round(capacity * ratio)}%`))),
            ticks.map(at => h('g', { key: at }, h('line', { x1: x(at), x2: x(at), y1: top, y2: height - bottom, className: 'dqx-gridline vertical' }), h('text', { x: x(at), y: height - 12, textAnchor: 'middle' }, new Date(at).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })))),
            h('line', { x1: x(now), x2: x(now), y1: top - 7, y2: height - bottom, className: 'dqx-now' }),
            h('text', { x: x(now), y: top - 13, textAnchor: 'middle' }, 'Now'),
            historyPath && h('path', { d: historyPath + `L${x(recorded.at(-1).at)},${y(0)}L${x(recorded[0].at)},${y(0)}Z`, className: 'dqx-area' }),
            historyPath && h('path', { d: historyPath, className: 'dqx-line' }),
            futurePath && h('path', { d: futurePath, className: 'dqx-line projected' }),
            group.primary && h('circle', { cx: x(now), cy: y(balance), r: 4, className: 'dqx-point' }),
            projection.resets.filter(p => p.at <= until).slice(0, 8).map(p => h('text', { key: p.at, x: x(p.at) + 5, y: Math.max(top + 10, y(projection.points.findLast(v => v.at === p.at)?.value || 0) - 10), className: 'dqx-reset-label' }, `+${Math.round(p.gain)}%`)),
            hover && h('g', null, h('line', { x1: x(hover.at), x2: x(hover.at), y1: top, y2: height - bottom, className: 'dqx-hoverline' }), h('circle', { cx: x(hover.at), cy: y(hover.value), r: 4, className: 'dqx-point' }))),
          hover && h('div', { className: 'dqx-chart-tooltip', role: 'status' }, `${absoluteTime(hover.at)} \u00b7 ${Math.round(hover.value)}% left \u00b7 ${hover.projected ? 'projected' : 'recorded'}`)),
        h('div', { className: 'dqx-chart-legend' }, h('span', null, 'Pool'), h('span', { className: 'recorded-key' }, 'Recorded'), h('span', { className: 'projected-key' }, 'Projected'),
          h('small', null, rate === null ? waitingNote : `${historyNote} Estimate assumes recent burn continues and accounts reset on schedule.`)));
    }

    function Forecasts({ groups, props, now }) {
      const [samples, setSamples] = useState([]);
      const [error, setError] = useState('');
      const [horizon, setHorizon] = useState(7);
      const [visible, setVisible] = useState(() => { try { return localStorage.getItem('duckweed.showForecasts') !== 'false'; } catch { return true; } });
      useEffect(() => {
        let active = true;
        const load = async () => {
          if (document.hidden) return;
          try {
            if (!globalThis.duckweedLoadQuotaHistory) throw new Error('Quota history monitor is starting.');
            const result = await globalThis.duckweedLoadQuotaHistory();
            if (active) { setSamples(result.samples || []); setError(''); }
          } catch (err) { if (active) setError(err.message); }
        };
        load(); const timer = setInterval(load, 60000);
        document.addEventListener('visibilitychange', load);
        return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', load); };
      }, []);
      const eligible = groups.filter(group => group.primary && ['claude', 'codex', 'antigravity', 'xai'].includes(group.type));
      return h('section', { className: 'dqx-forecasts' },
        h('div', { className: 'dqx-forecast-toolbar' },
          h('button', { type: 'button', className: 'dqx-link', 'aria-expanded': visible, onClick: () => { setVisible(!visible); try { localStorage.setItem('duckweed.showForecasts', String(!visible)); } catch {} } }, visible ? 'Hide forecasts' : 'Show forecasts'),
          visible && h('div', { className: 'dqx-range', role: 'group', 'aria-label': 'Forecast range' }, [3,7,14].map(days => h('button', { key: days, type: 'button', 'aria-pressed': horizon === days, onClick: () => setHorizon(days) }, `${days} days`)))),
        visible && error && h('p', { className: 'dqx-history-error', role: 'status' }, error),
        visible && eligible.map(group => h(Forecast, { key: group.type, group, props, now, samples, horizon })));
    }

    function RenameDialog({ file, onClose }) {
      const [value, setValue] = useState(privateMode ? '' : customName(file));
      const [busy, setBusy] = useState(false), [error, setError] = useState('');
      const ref = React.useRef(null);
      useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
      const save = async event => {
        event.preventDefault(); setBusy(true); setError('');
        try {
          if (!globalThis.duckweedAccountNames) throw new Error('Account names are unavailable. Reload the panel.');
          await globalThis.duckweedAccountNames(fileId(file), value);
          onClose();
        } catch (err) { setError(err.message); setBusy(false); }
      };
      return h('dialog', { ref, className: 'dqx-rename', 'aria-labelledby': 'dqx-rename-title', onCancel: event => { event.preventDefault(); if (!busy) onClose(); } },
        h('form', { onSubmit: save },
          h('h2', { id: 'dqx-rename-title' }, 'Rename account'),
          h('label', { htmlFor: 'dqx-rename-input' }, 'Display name'),
          h('input', { id: 'dqx-rename-input', value, maxLength: 80, autoFocus: true, autoComplete: 'off', placeholder: 'Account name', disabled: busy, onChange: event => setValue(event.target.value) }),
          h('p', null, 'Leave blank to use the original name.'),
          error && h('p', { className: 'dqx-error', role: 'alert' }, error),
          h('div', { className: 'dqx-rename-actions' },
            h('button', { type: 'button', onClick: onClose, disabled: busy }, 'Cancel'),
            h('button', { type: 'submit', disabled: busy }, busy ? 'Saving...' : 'Save name'))));
    }

    function Ledger(props) {
      const current = useSyncExternalStore(subscribe, getView, getView);
      useSyncExternalStore(subscribe, privacySnapshot, privacySnapshot);
      useSyncExternalStore(subscribe, () => weightRevision, () => weightRevision);
      useSyncExternalStore(subscribe, () => namesRevision, () => namesRevision);
      const [renaming, setRenaming] = useState(null);
      const displayProps = { ...props, onRenameAccount: setRenaming };
      const now = props.useNow();
      useEffect(() => {
        if (initialized) return;
        initialized = true;
        void globalThis.duckweedAccountNames?.().catch(() => {});
        document.querySelector('button[class*="QuotaHeader-module__primaryAction"]:not(:disabled)')?.click();
        // Open this view with the compact navigation rail, as in the reference.
        document.querySelector('button.sidebar-toggle-floating[aria-label="Collapse (Ctrl+B)"]')?.click();
      }, []);
      if (current === 'cards' && !privateMode) return props.cards();
      const groups = props.types
        .map(type => [type, props.entries.filter(entry => entry.type === type)])
        .filter(([, entries]) => entries.length > 0)
        .map(([type, entries]) => buildGroup(type, entries, props, now));
      return h('div', { className: 'dqx-ledger' },
        renaming && h(RenameDialog, { file: renaming, onClose: () => setRenaming(null) }),
        groups.map(group => h(Section, { key: group.type, group, props: displayProps, now })),
        h(Forecasts, { groups, props, now }));
    }

    function Toggle() {
      useSyncExternalStore(subscribe, privacySnapshot, privacySnapshot);
      const current = useSyncExternalStore(subscribe, getView, getView);
      return h('div', { className: 'dqx-toggle', role: 'group', 'aria-label': 'Layout' },
        h('button', { type: 'button', 'aria-pressed': current === 'ledger', 'aria-label': 'Ledger', title: 'Ledger', onClick: () => setView('ledger') }, h(RowsIcon)),
        h('button', { type: 'button', 'aria-pressed': current === 'cards', 'aria-label': 'Cards', title: 'Cards', disabled: privateMode, onClick: () => setView('cards') }, h(GridIcon)),
        h('button', { type: 'button', 'aria-pressed': privateMode, 'aria-label': 'Hide account names', title: 'Hide account names', onClick: () => setPrivate(!privateMode) }, svg(['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12', 'M3 3l18 18'])));
    }

    return { Ledger, Toggle };
  }

  let components = null;
  const componentsFor = React => components ??= createView(React);
  globalThis.duckweedLedger = {
    render: props => props.React.createElement(componentsFor(props.React).Ledger, props),
    toggle: React => React.createElement(componentsFor(React).Toggle),
    isLedger: () => view === 'ledger',
    customName, setNames,
    helpers: { normalize, buildGroup, poolMembers, nextReset, historySeries, burnRate, projectPool, historyWindow, tone, burnAnalysis },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.duckweedLedger.helpers;
})();
