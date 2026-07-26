//! Provider-reported usage limits for coding agents used in the selected range.
//!
//! A transcript total is not a quota. We only draw a meter when the provider
//! reports the current percentage and reset time, either through its official
//! OAuth usage endpoint or a snapshot persisted by the CLI. Agents without
//! either source still get a card, but it says why no trustworthy limit is
//! available instead of asking the user to invent a ceiling.
//!
//! Each successful snapshot is also appended to a small local history so we
//! can estimate how long the remaining allowance lasts at the recent burn
//! rate. That rate still looks back an hour, but weights what happened in the
//! last 30 minutes twice and the last 15 minutes three times, so a session
//! that just picked up (or just stopped) moves the estimate quickly instead of
//! being averaged away by the quiet part of the hour. A drop in utilization is
//! treated as a window reset, not as "negative burn".
//!
//! An idle hour is not an answer, so when there is no recent burn we fall back
//! to the average pace of the window so far — utilization divided by the time
//! elapsed since the window opened. Every forecast says which of the two it
//! came from, and is measured against the window's own reset: a limit that
//! refills before it empties never runs out at all.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA: &str = "oauth-2025-04-20";
const CLAUDE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

/// Burn rate looks back at most this far.
const LOOKBACK_MS: i64 = 60 * 60 * 1000;
/// Recency bands for the burn rate, newest first: `(max age, weight)`. Time
/// inside a band counts `weight` times, so the last quarter hour dominates
/// while the rest of the hour still anchors the estimate.
const BURN_WEIGHTS: [(i64, f64); 3] = [
    (15 * 60 * 1000, 3.0),
    (30 * 60 * 1000, 2.0),
    (LOOKBACK_MS, 1.0),
];
/// Need at least this much elapsed time between baseline and now.
const MIN_SPAN_MS: i64 = 15 * 60 * 1000;
/// Utilization drop of this many points counts as a window reset.
const RESET_DROP: f64 = 5.0;
/// Keep samples long enough to cover the lookback after a quiet stretch.
const HISTORY_RETENTION_MS: i64 = 48 * 60 * 60 * 1000;
/// Don't write a new sample for the same limit more often than this.
const MIN_SAMPLE_GAP_MS: i64 = 2 * 60 * 1000;
/// Remaining at or below this is treated as already exhausted.
const EXHAUSTED_REMAINING: f64 = 0.5;
/// Burn rates smaller than this (percent per hour) are noise / idle.
const MIN_BURN_PER_HOUR: f64 = 0.25;

/// How one limit is trending, and where that number came from.
#[derive(Clone, Debug, Serialize)]
pub struct QuotaForecast {
    /// Utilization points consumed per hour.
    pub per_hour: f64,
    /// `recent` = measured over the last hour of samples, `window` = average
    /// since this window opened (used when nothing burned recently).
    pub basis: String,
    /// Epoch ms when this limit would reach 100% at `per_hour`. `Some(now)`
    /// when already exhausted; `None` when the pace would never empty it.
    pub runs_out_at: Option<i64>,
    /// Utilization projected for the moment the window resets. Lets the UI
    /// show how much of the bar is expected to be gone by then.
    pub projected_percent: Option<f64>,
}

#[derive(Clone, Serialize)]
pub struct QuotaLimit {
    pub id: String,
    pub label: String,
    /// Amount consumed, in `unit`.
    pub used: f64,
    /// The denominator when the provider supplies one.
    pub limit: Option<f64>,
    pub percent: f64,
    /// `percent`, `usd`, or another provider-native counter.
    pub unit: String,
    pub resets_at: Option<i64>,
    /// Length of the quota window, when the provider implies one. With
    /// `resets_at` this gives the elapsed time the average pace divides by.
    pub window_ms: Option<i64>,
    /// Filled in after the provider read; `None` when there is nothing to
    /// project from yet.
    pub forecast: Option<QuotaForecast>,
}

#[derive(Clone, Serialize)]
pub struct Quota {
    pub agent: String,
    pub label: String,
    /// `reported` when the CLI persisted provider state, otherwise
    /// `unavailable`.
    pub source: String,
    /// Subscription tier, when the CLI records one.
    pub plan: Option<String>,
    /// Why an official limit cannot be displayed.
    pub message: Option<String>,
    pub limits: Vec<QuotaLimit>,
}

/// Build one card for every agent with at least one request in the selected
/// dashboard range. Empty/installed-only agents are deliberately omitted.
pub fn build(
    used_agents: &HashSet<&'static str>,
    home: &Path,
    history_path: &Path,
    latest_codex_session: Option<&Path>,
) -> Vec<Quota> {
    let now = Utc::now().timestamp_millis();
    let mut history = load_history(history_path);
    let mut quotas: Vec<Quota> = crate::usage::sources::AGENTS
        .iter()
        .filter(|agent| used_agents.contains(agent.id))
        .map(|agent| {
            reported_for_with_codex_session(agent.id, home, latest_codex_session).unwrap_or_else(
                || Quota {
                    agent: agent.id.to_string(),
                    label: agent.label.to_string(),
                    source: "unavailable".into(),
                    plan: None,
                    message: Some(unavailable_message(agent.id).into()),
                    limits: Vec::new(),
                },
            )
        })
        .collect();

    for quota in &mut quotas {
        if quota.source == "reported" && !quota.limits.is_empty() {
            apply_estimate(quota, &mut history, now);
        }
    }
    save_history(history_path, &history);
    quotas
}

fn unavailable_message(agent_id: &str) -> &'static str {
    match agent_id {
        "claude" => {
            "Claude usage could not be fetched from the local OAuth session. Open Claude Code to refresh its sign-in, then refresh Usage."
        }
        "gemini" => {
            "Gemini reports session statistics in /stats; it does not persist a reliable account-wide remaining quota."
        }
        "opencode" => {
            "OpenCode can use many providers, so it has no single account quota to report."
        }
        "antigravity" => {
            "Antigravity records local activity, but not token counts or an account limit snapshot."
        }
        _ => "This agent does not persist provider-reported account limits locally.",
    }
}

// ---------------------------------------------------------------- history / ETA

#[derive(Clone, Serialize, Deserialize)]
struct QuotaSample {
    at: i64,
    agent: String,
    limit_id: String,
    percent: f64,
}

#[derive(Default, Serialize, Deserialize)]
struct QuotaHistory {
    samples: Vec<QuotaSample>,
}

fn load_history(path: &Path) -> QuotaHistory {
    let Ok(bytes) = std::fs::read(path) else {
        return QuotaHistory::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_history(path: &Path, history: &QuotaHistory) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(history) {
        let _ = std::fs::write(path, bytes);
    }
}

/// Record the latest reading, then give every limit its own forecast.
fn apply_estimate(quota: &mut Quota, history: &mut QuotaHistory, now: i64) {
    record_samples(quota, history, now);
    let agent = quota.agent.clone();
    for limit in &mut quota.limits {
        limit.forecast = forecast_for(&agent, limit, history, now);
    }
}

fn record_samples(quota: &Quota, history: &mut QuotaHistory, now: i64) {
    history
        .samples
        .retain(|sample| now - sample.at <= HISTORY_RETENTION_MS);

    for limit in &quota.limits {
        if let Some(last) = history
            .samples
            .iter()
            .rev()
            .find(|sample| sample.agent == quota.agent && sample.limit_id == limit.id)
        {
            if now - last.at < MIN_SAMPLE_GAP_MS && (last.percent - limit.percent).abs() < 0.05 {
                continue;
            }
        }
        history.samples.push(QuotaSample {
            at: now,
            agent: quota.agent.clone(),
            limit_id: limit.id.clone(),
            percent: limit.percent,
        });
    }
}

/// What happens to one limit next: when it would empty, and where it lands by
/// the time its window resets.
///
/// The recent burn rate answers "am I about to lose this session"; the window
/// average answers "how am I doing overall" when nothing burned in the last
/// hour. Preferring the former keeps an active session's forecast responsive,
/// and falling back to the latter means an idle card still says something.
fn forecast_for(
    agent: &str,
    limit: &QuotaLimit,
    history: &QuotaHistory,
    now: i64,
) -> Option<QuotaForecast> {
    let remaining = (100.0 - limit.percent).max(0.0);
    if remaining <= EXHAUSTED_REMAINING {
        return Some(QuotaForecast {
            per_hour: 0.0,
            basis: "exhausted".into(),
            runs_out_at: Some(now),
            projected_percent: Some(100.0),
        });
    }

    let recent = burn_rate_per_ms(agent, limit, history, now)
        .map(|per_ms| per_ms * 3_600_000.0)
        .filter(|per_hour| *per_hour > 0.0);
    let (per_hour, basis) = match recent {
        Some(per_hour) => (per_hour, "recent"),
        None => (window_average_per_hour(limit, now)?, "window"),
    };

    let runs_out_at = (per_hour > 0.0).then(|| {
        let eta_ms = (remaining / per_hour * 3_600_000.0).ceil() as i64;
        now.saturating_add(eta_ms.max(0))
    });
    let projected_percent = limit.resets_at.map(|resets| {
        let hours = (resets - now).max(0) as f64 / 3_600_000.0;
        limit.percent + per_hour * hours
    });

    Some(QuotaForecast {
        per_hour,
        basis: basis.into(),
        runs_out_at,
        projected_percent,
    })
}

/// Points-per-hour averaged over the part of the window already elapsed.
///
/// Needs both ends of the window: `resets_at` says when it closes and
/// `window_ms` how long it runs, so the difference is how long the recorded
/// utilization took to accumulate.
fn window_average_per_hour(limit: &QuotaLimit, now: i64) -> Option<f64> {
    if limit.percent <= 0.0 {
        return None;
    }
    let elapsed = limit.window_ms? - (limit.resets_at? - now);
    if elapsed < MIN_SPAN_MS {
        // Too early in the window for the average to mean anything.
        return None;
    }
    let per_hour = limit.percent / (elapsed as f64 / 3_600_000.0);
    (per_hour >= MIN_BURN_PER_HOUR).then_some(per_hour)
}

/// Recency-weighted percent-per-ms burn over the last hour, ignoring post-reset
/// noise.
///
/// Every gap between consecutive samples is one observed rate. Instead of
/// averaging them by duration alone, each millisecond is weighted by how recent
/// it is (`BURN_WEIGHTS`), so an hour that was idle until ten minutes ago
/// reports the pace of those ten minutes rather than a sixth of it. A gap that
/// straddles a band boundary is split across the bands, with its consumption
/// spread evenly over its own duration.
fn burn_rate_per_ms(
    agent: &str,
    limit: &QuotaLimit,
    history: &QuotaHistory,
    now: i64,
) -> Option<f64> {
    let mut series: Vec<(i64, f64)> = history
        .samples
        .iter()
        .filter(|sample| {
            sample.agent == agent
                && sample.limit_id == limit.id
                && sample.at <= now
                && now - sample.at <= LOOKBACK_MS + MIN_SPAN_MS
        })
        .map(|sample| (sample.at, sample.percent))
        .collect();

    // Always include the live reading so a just-fetched snapshot participates.
    if series
        .last()
        .map(|(at, percent)| *at != now || (*percent - limit.percent).abs() > 0.01)
        .unwrap_or(true)
    {
        series.push((now, limit.percent));
    }
    series.sort_by_key(|(at, _)| *at);
    series.dedup_by(|a, b| a.0 == b.0);

    // Drop everything before the latest reset (sharp utilization fall).
    let mut start = 0;
    for i in 1..series.len() {
        if series[i - 1].1 - series[i].1 >= RESET_DROP {
            start = i;
        }
    }
    let series = &series[start..];
    if series.len() < 2 {
        return None;
    }

    let mut weighted_delta = 0.0;
    let mut weighted_span = 0.0;
    let mut covered = 0i64;
    for pair in series.windows(2) {
        let ((from_at, from_percent), (to_at, to_percent)) = (pair[0], pair[1]);
        // Clip to the lookback; a gap reaching further back only counts the
        // part of it that falls inside the hour.
        let from_at = from_at.max(now - LOOKBACK_MS);
        let span = to_at - from_at;
        if span <= 0 {
            continue;
        }
        // Consumption is spread evenly over the gap, so a slice of it carries
        // the matching slice of the delta.
        let rate = (to_percent - from_percent).max(0.0) / (to_at - pair[0].0) as f64;
        covered += span;
        let mut younger_than = 0i64;
        for (age, weight) in BURN_WEIGHTS {
            // Bands are exclusive: 0–15 min counts 3×, 15–30 min 2×, 30–60 min
            // 1×, rather than stacking.
            let band_start = (now - age).max(from_at);
            let band_end = (now - younger_than).min(to_at);
            younger_than = age;
            let overlap = (band_end - band_start).max(0) as f64;
            if overlap <= 0.0 {
                continue;
            }
            weighted_delta += weight * rate * overlap;
            weighted_span += weight * overlap;
        }
    }

    if covered < MIN_SPAN_MS || weighted_span <= 0.0 {
        return None;
    }
    if weighted_delta <= 0.0 {
        // Flat or falling after reset filter → not burning.
        return Some(0.0);
    }

    let per_ms = weighted_delta / weighted_span;
    let per_hour = per_ms * LOOKBACK_MS as f64;
    if per_hour < MIN_BURN_PER_HOUR {
        return Some(0.0);
    }
    Some(per_ms)
}

/// Pull the provider's own rate-limit state for CLIs that persist it.
fn reported_for(agent_id: &str, home: &Path) -> Option<Quota> {
    reported_for_with_codex_session(agent_id, home, None)
}

fn reported_for_with_codex_session(
    agent_id: &str,
    home: &Path,
    latest_codex_session: Option<&Path>,
) -> Option<Quota> {
    match agent_id {
        "claude" => claude_quota(home),
        "codex" => codex_quota(home, latest_codex_session),
        "grok" => grok_quota(home),
        _ => None,
    }
}

#[derive(Deserialize)]
struct ClaudeCredentials {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<ClaudeOauth>,
}

#[derive(Deserialize)]
struct ClaudeOauth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
}

struct ClaudeCacheEntry {
    checked_at: Instant,
    value: Option<Quota>,
    last_success: Option<Quota>,
}

static CLAUDE_CACHE: OnceLock<Mutex<HashMap<PathBuf, ClaudeCacheEntry>>> = OnceLock::new();
static TLS_PROVIDER: OnceLock<()> = OnceLock::new();

/// Fetch Claude's own `/usage` data with the OAuth session created by Claude
/// Code. Tokens never leave this function except as a Bearer header sent to
/// `api.anthropic.com`, and are never logged or copied into Duckweed's index.
fn claude_quota(home: &Path) -> Option<Quota> {
    let key = home.to_path_buf();
    let cache = CLAUDE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.checked_at.elapsed() < CLAUDE_CACHE_TTL {
                return entry.value.clone().or_else(|| entry.last_success.clone());
            }
        }
    }

    let fetched = fetch_claude_quota(home);
    let mut fallback = None;
    if let Ok(mut guard) = cache.lock() {
        fallback = guard.get(&key).and_then(|entry| entry.last_success.clone());
        let last_success = fetched.clone().or_else(|| fallback.clone());
        guard.insert(
            key,
            ClaudeCacheEntry {
                checked_at: Instant::now(),
                value: fetched.clone(),
                last_success,
            },
        );
    }
    fetched.or(fallback)
}

fn fetch_claude_quota(home: &Path) -> Option<Quota> {
    let path = home.join(".claude/.credentials.json");
    let credentials: ClaudeCredentials = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let oauth = credentials.oauth?;
    if oauth.access_token.trim().is_empty()
        || epoch_ms(oauth.expires_at) <= Utc::now().timestamp_millis() + 30_000
    {
        return None;
    }

    TLS_PROVIDER.get_or_init(|| {
        // The updater uses reqwest with provider-neutral rustls. Install Ring
        // once for the blocking client as well; an already installed provider
        // is a valid outcome.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .user_agent("duckweed/0.1 usage-dashboard")
        .build()
        .ok()?;
    let response = client
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(oauth.access_token)
        .header("anthropic-beta", CLAUDE_BETA)
        .header("accept", "application/json")
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    let payload: Value = response.json().ok()?;
    claude_quota_from_payload(&payload, oauth.subscription_type)
}

fn epoch_ms(value: i64) -> i64 {
    if value < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn claude_quota_from_payload(payload: &Value, plan: Option<String>) -> Option<Quota> {
    const FIVE_HOUR: i64 = 5 * 60 * 60 * 1000;
    const SEVEN_DAY: i64 = 7 * 24 * 60 * 60 * 1000;

    let mut limits = Vec::new();
    for (key, id, label, window) in [
        ("five_hour", "five-hour", "5-hour limit", Some(FIVE_HOUR)),
        ("seven_day", "seven-day", "7-day limit", Some(SEVEN_DAY)),
        (
            "seven_day_oauth_apps",
            "seven-day-oauth-apps",
            "7-day OAuth apps",
            Some(SEVEN_DAY),
        ),
        (
            "seven_day_opus",
            "seven-day-opus",
            "7-day Opus",
            Some(SEVEN_DAY),
        ),
        (
            "seven_day_sonnet",
            "seven-day-sonnet",
            "7-day Sonnet",
            Some(SEVEN_DAY),
        ),
        (
            "seven_day_cowork",
            "seven-day-cowork",
            "7-day Cowork",
            Some(SEVEN_DAY),
        ),
        ("iguana_necktie", "iguana-necktie", "Iguana Necktie", None),
    ] {
        let Some(reported) = payload.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        let Some(percent) = reported.get("utilization").and_then(Value::as_f64) else {
            continue;
        };
        limits.push(QuotaLimit {
            id: id.into(),
            label: label.into(),
            used: percent,
            limit: Some(100.0),
            percent,
            unit: "percent".into(),
            resets_at: reported
                .get("resets_at")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_ms),
            window_ms: window,
            forecast: None,
        });
    }
    if limits.is_empty() {
        return None;
    }
    Some(Quota {
        agent: "claude".into(),
        label: "Claude Code".into(),
        source: "reported".into(),
        plan,
        message: None,
        limits,
    })
}

fn codex_quota(home: &Path, latest_session: Option<&Path>) -> Option<Quota> {
    let value = latest_codex_rate_limits(home, latest_session)?;
    let plan = value
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut limits = Vec::new();
    for (key, fallback) in [
        ("primary", "Primary limit"),
        ("secondary", "Secondary limit"),
    ] {
        let Some(block) = value.get(key).filter(|block| !block.is_null()) else {
            continue;
        };
        let percent = block.get("used_percent").and_then(Value::as_f64)?;
        let minutes = block
            .get("window_minutes")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        limits.push(QuotaLimit {
            id: key.to_string(),
            label: block
                .get("limit_name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| window_name(minutes).unwrap_or_else(|| fallback.to_string())),
            used: percent,
            // Codex supplies a percentage, not the underlying token allowance.
            limit: Some(100.0),
            percent,
            unit: "percent".into(),
            resets_at: block
                .get("resets_at")
                .and_then(Value::as_i64)
                .map(|seconds| seconds * 1000),
            window_ms: (minutes > 0).then(|| minutes * 60 * 1000),
            forecast: None,
        });
    }
    if limits.is_empty() {
        return None;
    }
    Some(Quota {
        agent: "codex".into(),
        label: "Codex CLI".into(),
        source: "reported".into(),
        plan,
        message: None,
        limits,
    })
}

fn grok_quota(home: &Path) -> Option<Quota> {
    let value = latest_grok_credit_config(home)?;
    let context = value.get("ctx")?;
    let config = context.get("config")?;
    let percent = config.get("creditUsagePercent")?.as_f64()?;
    let period = config.get("currentPeriod");
    let kind = period
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resets_at = period
        .and_then(|value| value.get("end"))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms)
        .or_else(|| {
            config
                .get("billingPeriodEnd")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_ms)
        });

    Some(Quota {
        agent: "grok".into(),
        label: "Grok CLI".into(),
        source: "reported".into(),
        plan: context
            .get("subscriptionTier")
            .and_then(Value::as_str)
            .map(str::to_string),
        message: None,
        limits: vec![QuotaLimit {
            id: "credits".into(),
            label: period_name(kind).into(),
            used: percent,
            limit: Some(100.0),
            percent,
            unit: "percent".into(),
            resets_at,
            window_ms: period_window_ms(kind),
            forecast: None,
        }],
    })
}

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn period_name(kind: &str) -> &'static str {
    match kind {
        "USAGE_PERIOD_TYPE_DAILY" => "Daily credit limit",
        "USAGE_PERIOD_TYPE_MONTHLY" => "Monthly credit limit",
        "USAGE_PERIOD_TYPE_WEEKLY" => "Weekly credit limit",
        _ => "Credit limit",
    }
}

/// Grok reports the period kind rather than its length; the names are fixed.
fn period_window_ms(kind: &str) -> Option<i64> {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    match kind {
        "USAGE_PERIOD_TYPE_DAILY" => Some(DAY),
        "USAGE_PERIOD_TYPE_WEEKLY" => Some(7 * DAY),
        "USAGE_PERIOD_TYPE_MONTHLY" => Some(30 * DAY),
        _ => None,
    }
}

fn window_name(minutes: i64) -> Option<String> {
    match minutes {
        0 => None,
        m if m % (60 * 24) == 0 => Some(format!("{}-day limit", m / (60 * 24))),
        m if m % 60 == 0 => Some(format!("{}-hour limit", m / 60)),
        m => Some(format!("{m}-minute limit")),
    }
}

/// Read only a bounded tail. Both files store running snapshots, so older
/// entries cannot improve the answer.
fn read_tail(path: &Path, bytes: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(bytes))).ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// The `rate_limits` payload from the newest Codex session.
fn latest_codex_rate_limits(home: &Path, latest_session: Option<&Path>) -> Option<Value> {
    let discovered;
    let newest = if let Some(path) = latest_session {
        path
    } else {
        discovered = crate::usage::sources::discover("codex", home)
            .into_iter()
            .filter_map(|path| {
                let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
                Some((modified, path))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path)?;
        &discovered
    };

    read_tail(&newest, 512 * 1024)?
        .lines()
        .rev()
        .filter(|line| line.contains("rate_limits"))
        .find_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            let limits = value.get("payload")?.get("rate_limits")?;
            (!limits.is_null()).then(|| limits.clone())
        })
}

/// Grok persists the same credit percentage shown by its `/usage` command in
/// its unified shell log.
fn latest_grok_credit_config(home: &Path) -> Option<Value> {
    let path = home.join(".grok/logs/unified.jsonl");
    read_tail(&path, 1024 * 1024)?
        .lines()
        .rev()
        .filter(|line| line.contains("billing: fetched credits config"))
        .find_map(|line| serde_json::from_str(line).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_names_follow_provider_minutes() {
        assert_eq!(window_name(10080).as_deref(), Some("7-day limit"));
        assert_eq!(window_name(300).as_deref(), Some("5-hour limit"));
        assert_eq!(window_name(45).as_deref(), Some("45-minute limit"));
        assert!(window_name(0).is_none());
    }

    #[test]
    fn only_agents_used_in_the_range_receive_cards() {
        let used = HashSet::from(["claude", "opencode"]);
        let empty = std::env::temp_dir().join("duckweed-no-such-home");
        let history = std::env::temp_dir().join(format!(
            "duckweed-quota-history-empty-{}",
            std::process::id()
        ));
        let quotas = build(&used, &empty, &history, None);
        assert_eq!(quotas.len(), 2);
        assert!(quotas.iter().all(|quota| quota.source == "unavailable"));
        assert!(!quotas.iter().any(|quota| quota.agent == "codex"));
        let _ = std::fs::remove_file(&history);
    }

    fn sample_quota(agent: &str, limits: Vec<(&str, f64)>) -> Quota {
        Quota {
            agent: agent.into(),
            label: agent.into(),
            source: "reported".into(),
            plan: None,
            message: None,
            limits: limits
                .into_iter()
                .map(|(id, percent)| QuotaLimit {
                    id: id.into(),
                    label: id.into(),
                    used: percent,
                    limit: Some(100.0),
                    percent,
                    unit: "percent".into(),
                    resets_at: None,
                    window_ms: None,
                    forecast: None,
                })
                .collect(),
        }
    }

    /// Soonest empty across the card's limits — the old card-level headline,
    /// kept here so the per-limit forecasts stay comparable to it.
    fn soonest_runs_out(quota: &Quota) -> Option<i64> {
        quota
            .limits
            .iter()
            .filter_map(|limit| limit.forecast.as_ref()?.runs_out_at)
            .min()
    }

    #[test]
    fn burn_rate_uses_last_hour_and_picks_the_tightest_limit() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory {
            samples: vec![
                QuotaSample {
                    at: now - LOOKBACK_MS,
                    agent: "claude".into(),
                    limit_id: "five-hour".into(),
                    percent: 50.0,
                },
                QuotaSample {
                    at: now - LOOKBACK_MS,
                    agent: "claude".into(),
                    limit_id: "seven-day".into(),
                    percent: 10.0,
                },
            ],
        };
        // 5h: 50% → 90% in 1h = 40%/h, remaining 10% → 15 min
        // week: 10% → 12% in 1h = 2%/h, remaining 88% → 44h
        let mut quota = sample_quota("claude", vec![("five-hour", 90.0), ("seven-day", 12.0)]);
        apply_estimate(&mut quota, &mut history, now);
        assert!(quota.limits.iter().all(|limit| limit
            .forecast
            .as_ref()
            .is_some_and(|forecast| forecast.basis == "recent")));
        let until = soonest_runs_out(&quota).expect("eta");
        let eta_min = (until - now) as f64 / 60_000.0;
        assert!(
            (eta_min - 15.0).abs() < 1.0,
            "expected ~15 min from 5h window, got {eta_min}"
        );
    }

    #[test]
    fn weekly_limit_can_bind_even_when_short_window_is_almost_full_remaining() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory {
            samples: vec![
                QuotaSample {
                    at: now - LOOKBACK_MS,
                    agent: "claude".into(),
                    limit_id: "five-hour".into(),
                    percent: 1.0,
                },
                QuotaSample {
                    at: now - LOOKBACK_MS,
                    agent: "claude".into(),
                    limit_id: "seven-day".into(),
                    percent: 90.0,
                },
            ],
        };
        // 5h barely moved; week 90→99 = 9%/h, remaining 1% → ~6.7 min
        let mut quota = sample_quota("claude", vec![("five-hour", 2.0), ("seven-day", 99.0)]);
        apply_estimate(&mut quota, &mut history, now);
        let until = soonest_runs_out(&quota).expect("eta");
        let eta_min = (until - now) as f64 / 60_000.0;
        assert!(
            (eta_min - (1.0 / 9.0) * 60.0).abs() < 1.0,
            "expected weekly to bind near 6–7 min, got {eta_min}"
        );
    }

    /// Weighting by recency is the whole point: an hour that sat idle until the
    /// last quarter should read much closer to the pace of that quarter than a
    /// flat hourly average would.
    #[test]
    fn recent_minutes_outweigh_the_quiet_start_of_the_hour() {
        let now = 1_700_000_000_000i64;
        let minute = 60 * 1000;
        let mut history = QuotaHistory {
            samples: [60, 30, 15]
                .into_iter()
                .map(|ago| QuotaSample {
                    at: now - ago * minute,
                    agent: "claude".into(),
                    limit_id: "five-hour".into(),
                    percent: 20.0,
                })
                .collect(),
        };
        // Nothing for 45 minutes, then 10 points in the last 15.
        let mut quota = sample_quota("claude", vec![("five-hour", 30.0)]);
        apply_estimate(&mut quota, &mut history, now);

        let forecast = quota.limits[0].forecast.as_ref().expect("forecast");
        assert_eq!(forecast.basis, "recent");
        // 10 points at weight 3 over 15 min, against 3×15 + 2×15 + 1×30 minutes
        // of weighted time: 600/35 ≈ 17.1%/h, not the flat 10%/h.
        assert!(
            (forecast.per_hour - 600.0 / 35.0).abs() < 0.05,
            "{forecast:?}"
        );
    }

    /// The weights must not distort a steady pace — a limit burning evenly all
    /// hour reports exactly that pace, whichever band the time falls in.
    #[test]
    fn a_steady_hour_is_unchanged_by_the_weights() {
        let now = 1_700_000_000_000i64;
        let minute = 60 * 1000;
        let mut history = QuotaHistory {
            samples: [60, 45, 30, 15]
                .into_iter()
                .map(|ago| QuotaSample {
                    at: now - ago * minute,
                    agent: "claude".into(),
                    limit_id: "five-hour".into(),
                    // 12%/h, sampled every quarter hour.
                    percent: 20.0 + (60 - ago) as f64 * 0.2,
                })
                .collect(),
        };
        let mut quota = sample_quota("claude", vec![("five-hour", 32.0)]);
        apply_estimate(&mut quota, &mut history, now);

        let forecast = quota.limits[0].forecast.as_ref().expect("forecast");
        assert!((forecast.per_hour - 12.0).abs() < 0.01, "{forecast:?}");
    }

    #[test]
    fn reset_drop_does_not_produce_infinite_or_negative_burn() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory {
            samples: vec![
                // Pre-reset: fully used
                QuotaSample {
                    at: now - LOOKBACK_MS,
                    agent: "claude".into(),
                    limit_id: "five-hour".into(),
                    percent: 100.0,
                },
                // Post-reset: back to empty, then mild use
                QuotaSample {
                    at: now - 30 * 60 * 1000,
                    agent: "claude".into(),
                    limit_id: "five-hour".into(),
                    percent: 0.0,
                },
            ],
        };
        let mut quota = sample_quota("claude", vec![("five-hour", 10.0)]);
        apply_estimate(&mut quota, &mut history, now);
        // 0 → 10% over 30 min = 20%/h, remaining 90% → 4.5h
        let until = soonest_runs_out(&quota).expect("post-reset eta");
        let eta_h = (until - now) as f64 / 3_600_000.0;
        assert!(
            (eta_h - 4.5).abs() < 0.2,
            "expected ~4.5h after reset, got {eta_h}"
        );
    }

    #[test]
    fn exhausted_limit_runs_out_now() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory::default();
        let mut quota = sample_quota("claude", vec![("five-hour", 100.0), ("seven-day", 40.0)]);
        apply_estimate(&mut quota, &mut history, now);
        let spent = quota.limits[0].forecast.as_ref().expect("forecast");
        assert_eq!(spent.basis, "exhausted");
        assert_eq!(spent.runs_out_at, Some(now));
        // The week is untouched by the 5-hour window running dry.
        assert!(quota.limits[1].forecast.is_none());
    }

    /// The old behaviour here was a card that just said "stable". With a window
    /// length in hand, an idle limit still reports the pace it was filled at.
    #[test]
    fn idle_limit_falls_back_to_the_window_average() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory {
            samples: vec![QuotaSample {
                at: now - LOOKBACK_MS,
                agent: "claude".into(),
                limit_id: "five-hour".into(),
                percent: 40.0,
            }],
        };
        let mut quota = sample_quota("claude", vec![("five-hour", 40.0)]);
        // 4 of the 5 hours elapsed: 40% in 4h = 10%/h.
        quota.limits[0].window_ms = Some(5 * 60 * 60 * 1000);
        quota.limits[0].resets_at = Some(now + 60 * 60 * 1000);
        apply_estimate(&mut quota, &mut history, now);

        let forecast = quota.limits[0].forecast.as_ref().expect("forecast");
        assert_eq!(forecast.basis, "window");
        assert!((forecast.per_hour - 10.0).abs() < 0.01, "{forecast:?}");
        // 60% left at 10%/h is 6h, well past the reset an hour from now, so the
        // window refills first and the projection stays under the cap.
        let eta_h = (forecast.runs_out_at.expect("eta") - now) as f64 / 3_600_000.0;
        assert!((eta_h - 6.0).abs() < 0.05, "expected ~6h, got {eta_h}");
        assert!((forecast.projected_percent.expect("projection") - 50.0).abs() < 0.01);
    }

    #[test]
    fn a_flat_untouched_window_has_nothing_to_project() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory::default();
        let mut quota = sample_quota("claude", vec![("five-hour", 0.0)]);
        quota.limits[0].window_ms = Some(5 * 60 * 60 * 1000);
        quota.limits[0].resets_at = Some(now + 4 * 60 * 60 * 1000);
        apply_estimate(&mut quota, &mut history, now);
        assert!(quota.limits[0].forecast.is_none());
    }

    #[test]
    fn a_just_opened_window_does_not_extrapolate_from_a_minute_of_use() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory::default();
        let mut quota = sample_quota("claude", vec![("five-hour", 8.0)]);
        quota.limits[0].window_ms = Some(5 * 60 * 60 * 1000);
        // Only 5 minutes in — below MIN_SPAN_MS.
        quota.limits[0].resets_at = Some(now + 5 * 60 * 60 * 1000 - 5 * 60 * 1000);
        apply_estimate(&mut quota, &mut history, now);
        assert!(quota.limits[0].forecast.is_none());
    }

    #[test]
    fn claude_oauth_usage_becomes_provider_reported_windows() {
        let payload: Value = serde_json::from_str(
            r#"{
                "five_hour":{"utilization":99.0,"resets_at":"2026-07-26T15:49:59.832815+00:00"},
                "seven_day":{"utilization":38.0,"resets_at":"2026-08-02T00:59:59.832837+00:00"},
                "seven_day_opus":null,
                "seven_day_sonnet":{"utilization":12.5,"resets_at":"2026-08-02T00:59:59Z"}
            }"#,
        )
        .unwrap();
        let quota = claude_quota_from_payload(&payload, Some("max".into())).unwrap();

        assert_eq!(quota.source, "reported");
        assert_eq!(quota.plan.as_deref(), Some("max"));
        assert_eq!(quota.limits.len(), 3);
        assert_eq!(quota.limits[0].label, "5-hour limit");
        assert!((quota.limits[0].percent - 99.0).abs() < 1e-9);
        assert_eq!(quota.limits[1].label, "7-day limit");
        assert_eq!(quota.limits[2].label, "7-day Sonnet");
        assert!(quota.limits.iter().all(|limit| limit.resets_at.is_some()));
    }

    #[test]
    fn credential_expiry_accepts_seconds_or_milliseconds() {
        assert_eq!(epoch_ms(1_785_000_000), 1_785_000_000_000);
        assert_eq!(epoch_ms(1_785_000_000_000), 1_785_000_000_000);
    }

    #[test]
    fn codex_rate_limits_are_read_from_the_newest_session_tail() {
        let root = std::env::temp_dir().join(format!("duckweed-quota-{}", std::process::id()));
        let dir = root.join(".codex/sessions/2026/07/26");
        std::fs::create_dir_all(&dir).unwrap();

        let stale = r#"{"timestamp":"2026-07-26T10:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1785621051},"secondary":null,"plan_type":"plus"}}}"#;
        let fresh = r#"{"timestamp":"2026-07-26T14:12:32.599Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":47.0,"window_minutes":10080,"resets_at":1785621051},"secondary":{"used_percent":9.0,"window_minutes":300,"resets_at":1785600000},"plan_type":"plus"}}}"#;
        std::fs::write(
            dir.join("rollout-2026-07-26T11-12-24-abc.jsonl"),
            format!("{stale}\n{fresh}\n"),
        )
        .unwrap();

        let quota = reported_for("codex", &root).expect("codex quota");
        assert_eq!(quota.source, "reported");
        assert_eq!(quota.plan.as_deref(), Some("plus"));
        assert_eq!(quota.limits.len(), 2);
        assert_eq!(quota.limits[0].label, "7-day limit");
        assert!((quota.limits[0].percent - 47.0).abs() < 1e-9);
        assert_eq!(quota.limits[0].resets_at, Some(1785621051 * 1000));
        assert_eq!(quota.limits[1].label, "5-hour limit");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn grok_credit_snapshot_is_provider_reported() {
        let root = std::env::temp_dir().join(format!("duckweed-grok-quota-{}", std::process::id()));
        let dir = root.join(".grok/logs");
        std::fs::create_dir_all(&dir).unwrap();
        let line = r#"{"ts":"2026-07-26T15:17:55.732Z","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":14.0,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-07-30T11:57:58.252814+00:00"}},"subscriptionTier":"SuperGrok"}}"#;
        std::fs::write(dir.join("unified.jsonl"), format!("{line}\n")).unwrap();

        let quota = reported_for("grok", &root).expect("grok quota");
        assert_eq!(quota.source, "reported");
        assert_eq!(quota.plan.as_deref(), Some("SuperGrok"));
        assert_eq!(quota.limits[0].label, "Weekly credit limit");
        assert!((quota.limits[0].percent - 14.0).abs() < 1e-9);
        assert!(quota.limits[0].resets_at.is_some());

        let _ = std::fs::remove_dir_all(&root);
    }
}
