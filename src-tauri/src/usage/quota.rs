//! Provider-reported usage limits for coding agents used in the selected range.
//!
//! A transcript total is not a quota. We only draw a meter when the provider
//! reports the current percentage and reset time, either through its official
//! OAuth usage endpoint or a snapshot persisted by the CLI. Agents without
//! either source still get a card, but it says why no trustworthy limit is
//! available instead of asking the user to invent a ceiling.
//!
//! Each successful snapshot is also appended to a small local history so we
//! can estimate how long the remaining allowance lasts at the last hour's
//! burn rate. A drop in utilization is treated as a window reset, not as
//! "negative burn".

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

/// Prefer a sample about one hour old when computing burn rate.
const LOOKBACK_MS: i64 = 60 * 60 * 1000;
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
    /// Epoch ms when the first limit is expected to hit empty at the observed
    /// last-hour burn rate. `Some(now)` when already exhausted.
    pub available_until: Option<i64>,
    /// Remaining quota with no positive burn observed in the lookback window.
    pub estimate_idle: bool,
}

/// Build one card for every agent with at least one request in the selected
/// dashboard range. Empty/installed-only agents are deliberately omitted.
pub fn build(used_agents: &HashSet<&'static str>, home: &Path, history_path: &Path) -> Vec<Quota> {
    let now = Utc::now().timestamp_millis();
    let mut history = load_history(history_path);
    let mut quotas: Vec<Quota> = crate::usage::sources::AGENTS
        .iter()
        .filter(|agent| used_agents.contains(agent.id))
        .map(|agent| {
            reported_for(agent.id, home).unwrap_or_else(|| Quota {
                agent: agent.id.to_string(),
                label: agent.label.to_string(),
                source: "unavailable".into(),
                plan: None,
                message: Some(unavailable_message(agent.id).into()),
                limits: Vec::new(),
                available_until: None,
                estimate_idle: false,
            })
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

/// Record the latest reading and fill `available_until` / `estimate_idle`.
fn apply_estimate(quota: &mut Quota, history: &mut QuotaHistory, now: i64) {
    record_samples(quota, history, now);
    let (available_until, estimate_idle) = estimate_available_until(quota, history, now);
    quota.available_until = available_until;
    quota.estimate_idle = estimate_idle;
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

/// Per-agent: the soonest any actively burning limit would hit empty.
fn estimate_available_until(
    quota: &Quota,
    history: &QuotaHistory,
    now: i64,
) -> (Option<i64>, bool) {
    let mut any_remaining = false;
    let mut any_burn = false;
    let mut soonest: Option<i64> = None;

    for limit in &quota.limits {
        let remaining = (100.0 - limit.percent).max(0.0);
        if remaining <= EXHAUSTED_REMAINING {
            return (Some(now), false);
        }
        any_remaining = true;

        let Some(burn_per_ms) = burn_rate_per_ms(quota, limit, history, now) else {
            continue;
        };
        if burn_per_ms <= 0.0 {
            continue;
        }
        any_burn = true;
        let eta_ms = (remaining / burn_per_ms).ceil() as i64;
        let until = now.saturating_add(eta_ms.max(0));
        soonest = Some(match soonest {
            Some(other) => other.min(until),
            None => until,
        });
    }

    if let Some(until) = soonest {
        (Some(until), false)
    } else if any_remaining && !any_burn {
        (None, true)
    } else {
        (None, false)
    }
}

/// Percent-per-ms burn from a baseline sample ~1h ago, ignoring post-reset noise.
fn burn_rate_per_ms(
    quota: &Quota,
    limit: &QuotaLimit,
    history: &QuotaHistory,
    now: i64,
) -> Option<f64> {
    let mut series: Vec<(i64, f64)> = history
        .samples
        .iter()
        .filter(|sample| {
            sample.agent == quota.agent
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

    // Prefer the sample closest to one hour ago; otherwise the oldest kept one.
    let target = now - LOOKBACK_MS;
    let baseline = series
        .iter()
        .take(series.len() - 1)
        .min_by_key(|(at, _)| (*at - target).abs())
        .copied()?;
    let (base_at, base_percent) = baseline;
    let elapsed = now - base_at;
    if elapsed < MIN_SPAN_MS {
        return None;
    }

    let delta = limit.percent - base_percent;
    if delta <= 0.0 {
        // Flat or falling after reset filter → not burning.
        return Some(0.0);
    }

    let per_ms = delta / elapsed as f64;
    let per_hour = per_ms * LOOKBACK_MS as f64;
    if per_hour < MIN_BURN_PER_HOUR {
        return Some(0.0);
    }
    Some(per_ms)
}

/// Pull the provider's own rate-limit state for CLIs that persist it.
fn reported_for(agent_id: &str, home: &Path) -> Option<Quota> {
    match agent_id {
        "claude" => claude_quota(home),
        "codex" => codex_quota(home),
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
    let mut limits = Vec::new();
    for (key, id, label) in [
        ("five_hour", "five-hour", "5-hour limit"),
        ("seven_day", "seven-day", "7-day limit"),
        (
            "seven_day_oauth_apps",
            "seven-day-oauth-apps",
            "7-day OAuth apps",
        ),
        ("seven_day_opus", "seven-day-opus", "7-day Opus"),
        ("seven_day_sonnet", "seven-day-sonnet", "7-day Sonnet"),
        ("seven_day_cowork", "seven-day-cowork", "7-day Cowork"),
        ("iguana_necktie", "iguana-necktie", "Iguana Necktie"),
    ] {
        let Some(window) = payload.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        let Some(percent) = window.get("utilization").and_then(Value::as_f64) else {
            continue;
        };
        limits.push(QuotaLimit {
            id: id.into(),
            label: label.into(),
            used: percent,
            limit: Some(100.0),
            percent,
            unit: "percent".into(),
            resets_at: window
                .get("resets_at")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_ms),
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
        available_until: None,
        estimate_idle: false,
    })
}

fn codex_quota(home: &Path) -> Option<Quota> {
    let value = latest_codex_rate_limits(home)?;
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
        available_until: None,
        estimate_idle: false,
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
        }],
        available_until: None,
        estimate_idle: false,
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
fn latest_codex_rate_limits(home: &Path) -> Option<Value> {
    let newest = crate::usage::sources::discover("codex", home)
        .into_iter()
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)?;

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
        let quotas = build(&used, &empty, &history);
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
                })
                .collect(),
            available_until: None,
            estimate_idle: false,
        }
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
        assert!(!quota.estimate_idle);
        let until = quota.available_until.expect("eta");
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
        let until = quota.available_until.expect("eta");
        let eta_min = (until - now) as f64 / 60_000.0;
        assert!(
            (eta_min - (1.0 / 9.0) * 60.0).abs() < 1.0,
            "expected weekly to bind near 6–7 min, got {eta_min}"
        );
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
        let until = quota.available_until.expect("post-reset eta");
        let eta_h = (until - now) as f64 / 3_600_000.0;
        assert!(
            (eta_h - 4.5).abs() < 0.2,
            "expected ~4.5h after reset, got {eta_h}"
        );
    }

    #[test]
    fn exhausted_limit_reports_available_until_now() {
        let now = 1_700_000_000_000i64;
        let mut history = QuotaHistory::default();
        let mut quota = sample_quota("claude", vec![("five-hour", 100.0), ("seven-day", 40.0)]);
        apply_estimate(&mut quota, &mut history, now);
        assert_eq!(quota.available_until, Some(now));
        assert!(!quota.estimate_idle);
    }

    #[test]
    fn flat_history_is_idle_not_infinite() {
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
        apply_estimate(&mut quota, &mut history, now);
        assert!(quota.estimate_idle);
        assert!(quota.available_until.is_none());
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
