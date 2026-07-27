//! Usage statistics across every coding agent installed on this machine.
//!
//! The problem this module solves is that the interesting data — what you
//! spent, on which model, through which CLI — is scattered across ten
//! incompatible transcript formats totalling several gigabytes, and re-reading
//! all of it on every glance at the settings tab would cost more CPU than the
//! agents themselves.
//!
//! So the scan is incremental and the index is durable:
//!
//! * A file whose size and mtime are unchanged is never opened again; its
//!   contribution is replayed from the index.
//! * Append-only transcripts resume from the byte offset the last scan
//!   reached, so a session that grew by a kilobyte costs a kilobyte of reading.
//! * Parsing runs across a small thread pool, and the per-line byte prefilter
//!   in [`sources`] keeps serde away from the ~99% of lines that hold no usage.
//!
//! Buckets are kept at two resolutions. The last [`RECENT_DAYS`] days sit in
//! five-minute slots, fine enough to drive rolling quota windows; everything
//! older is collapsed to one row per day per model, which is all the charts
//! need and keeps the index small enough to rewrite cheaply.

pub mod pricing;
pub mod quota;
pub mod sources;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};

use pricing::Overrides;
use sources::{Format, Record};

/// Slot width for recent buckets.
const SLOT_MS: i64 = 5 * 60 * 1000;
/// How long buckets stay at five-minute resolution before collapsing to daily.
const RECENT_DAYS: i64 = 8;
/// How long a file's request ids are kept for cross-file duplicate detection.
const DEDUP_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// How far back the duty cycle looks. Kept inside [`RECENT_DAYS`] so every row
/// it reads still has five-minute resolution rather than a collapsed day.
const DUTY_DAYS: i64 = 7;
const INDEX_VERSION: u32 = 1;

// ---------------------------------------------------------------- tokens

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    /// Fresh input, excluding anything served from cache.
    #[serde(default)]
    pub input: u64,
    /// Generated output, excluding reasoning.
    #[serde(default)]
    pub output: u64,
    /// Thinking tokens, where the agent reports them apart from output.
    #[serde(default)]
    pub reasoning: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
}

impl Tokens {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.reasoning + self.cache_read + self.cache_write
    }

    fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.reasoning += other.reasoning;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
}

// ---------------------------------------------------------------- index

/// One aggregated bucket: a time slot, a model, and what it cost.
#[derive(Clone, Serialize, Deserialize)]
struct Row {
    /// Bucket start in epoch ms — a five-minute slot, or local midnight once
    /// the row has been collapsed.
    at: i64,
    model: String,
    #[serde(flatten)]
    tokens: Tokens,
    requests: u32,
    /// Sum of the costs the agent priced itself, when it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reported_cost: Option<f64>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct FileIndex {
    mtime: i64,
    size: u64,
    /// Bytes already consumed; always 0 for rewritten formats.
    offset: u64,
    #[serde(default)]
    rows: Vec<Row>,
    /// Request-id hashes, dropped once the file falls out of the dedup window.
    #[serde(default)]
    ids: Vec<u64>,
    /// Newest record in the file, for pruning `ids`.
    #[serde(default)]
    last_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Index {
    version: u32,
    /// Keyed by absolute path.
    files: HashMap<String, FileIndex>,
}

/// The index, held in memory between calls so a repeat visit to the settings
/// tab does not re-read it from disk. Cloning shares the same index.
#[derive(Default, Clone)]
pub struct UsageState {
    inner: std::sync::Arc<Mutex<Option<Index>>>,
}

// ---------------------------------------------------------------- output

#[derive(Default, Clone, Copy, Serialize)]
pub struct Totals {
    #[serde(flatten)]
    pub tokens: Tokens,
    pub cost: f64,
    pub requests: u32,
}

impl Totals {
    fn add(&mut self, tokens: &Tokens, cost: f64, requests: u32) {
        self.tokens.add(tokens);
        self.cost += cost;
        self.requests += requests;
    }
}

#[derive(Serialize)]
pub struct AgentSlice {
    pub agent: String,
    #[serde(flatten)]
    pub totals: Totals,
}

#[derive(Serialize)]
pub struct DaySeries {
    /// Local calendar day, `YYYY-MM-DD`.
    pub date: String,
    pub agents: Vec<AgentSlice>,
    #[serde(flatten)]
    pub totals: Totals,
}

#[derive(Serialize)]
pub struct AgentSummary {
    pub id: String,
    pub label: String,
    pub vendor: String,
    /// Whether any data files were found for it.
    pub installed: bool,
    pub files: u32,
    /// False for agents that log activity but no token counts.
    pub tracks_tokens: bool,
    pub caveat: Option<String>,
    pub last_used: Option<i64>,
    #[serde(flatten)]
    pub totals: Totals,
}

#[derive(Serialize)]
pub struct ModelSummary {
    pub model: String,
    pub agent: String,
    /// False when no price is known, so the cost shown is zero, not cheap.
    pub priced: bool,
    #[serde(flatten)]
    pub totals: Totals,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub generated_at: i64,
    /// Days covered by `days`, as requested.
    pub range_days: u32,
    pub totals: Totals,
    pub days: Vec<DaySeries>,
    pub agents: Vec<AgentSummary>,
    pub models: Vec<ModelSummary>,
    pub quotas: Vec<quota::Quota>,
    /// Models seen with no entry in the price table.
    pub unpriced: Vec<String>,
    pub scan: ScanStats,
}

#[derive(Default, Serialize, Clone)]
pub struct ScanStats {
    pub files_seen: u32,
    /// Files actually opened; the rest were served from the index.
    pub files_read: u32,
    pub bytes_read: u64,
    pub duration_ms: u64,
}

/// What the settings tab asks for.
#[derive(Deserialize, Clone)]
pub struct Query {
    /// Length of the daily series.
    pub days: u32,
    /// Re-stat every file rather than trusting the in-memory index.
    #[serde(default)]
    pub refresh: bool,
}

// ---------------------------------------------------------------- time

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// Local midnight on the day containing `at`.
fn day_start(at: i64) -> i64 {
    Local
        .timestamp_millis_opt(at)
        .single()
        .and_then(|dt| {
            dt.date_naive()
                .and_hms_opt(0, 0, 0)
                .and_then(|naive| Local.from_local_datetime(&naive).single())
        })
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(at - at.rem_euclid(DAY_MS))
}

fn day_label(at: i64) -> String {
    match Local.timestamp_millis_opt(at).single() {
        Some(dt) => format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day()),
        None => String::from("????-??-??"),
    }
}

/// Slot a timestamp into a five-minute bucket, or a whole day once it is old
/// enough that no rolling window will ever look at it again.
fn bucket(at: i64, recent_cutoff: i64) -> i64 {
    if at >= recent_cutoff {
        at - at.rem_euclid(SLOT_MS)
    } else {
        day_start(at)
    }
}

// ---------------------------------------------------------------- scanning

/// A file's on-disk identity, and what we plan to do about it.
enum Plan {
    /// Unchanged: replay the indexed rows.
    Reuse,
    /// Grew: read from `offset`.
    Extend(u64),
    /// New, shrunk, or a rewritten format: read from the start.
    Full,
}

struct Job {
    agent: &'static str,
    path: PathBuf,
    key: String,
    plan: Plan,
    mtime: i64,
    size: u64,
}

/// Bring the index up to date and summarize it.
///
/// `emit` is called with `(files_done, files_total)` as parsing progresses so
/// the first scan — which really does read every byte of every transcript —
/// can show progress instead of appearing hung.
pub fn scan(
    home: &Path,
    index_path: &Path,
    overrides: &Overrides,
    state: &UsageState,
    query: &Query,
    emit: &(dyn Fn(u32, u32) + Sync),
) -> Result<Snapshot, String> {
    let started = Instant::now();
    let now = now_ms();
    let recent_cutoff = now - RECENT_DAYS * DAY_MS;
    let mut index_dirty = !index_path.is_file();

    let mut guard = state.inner.lock().map_err(|_| "usage index poisoned")?;
    if guard.is_none() || query.refresh {
        let loaded = load_index(index_path);
        *guard = Some(loaded);
    }
    let index = guard.as_mut().expect("index just populated");

    // Every known source is automatic. Discovery is only metadata work and
    // changed files alone are opened, so there is no manual tracking list to
    // maintain.
    let active: Vec<&'static sources::Agent> = sources::AGENTS.iter().collect();

    // --- plan every file -------------------------------------------------
    let mut jobs: Vec<Job> = Vec::new();
    let mut per_agent_files: HashMap<&str, u32> = HashMap::new();
    let mut latest_codex: Option<(i64, PathBuf)> = None;

    for agent in &active {
        let files = sources::discover(agent.id, home);
        per_agent_files.insert(agent.id, files.len() as u32);
        for path in files {
            let Some((size, mtime)) = sources::fingerprint(&path) else {
                continue;
            };
            if agent.id == "codex"
                && latest_codex
                    .as_ref()
                    .map_or(true, |(latest, _)| mtime > *latest)
            {
                latest_codex = Some((mtime, path.clone()));
            }
            let key = path.to_string_lossy().to_string();

            let plan = match index.files.get(&key) {
                Some(entry) if entry.mtime == mtime && entry.size == size => Plan::Reuse,
                // Only an append-only format can be resumed, and only when the
                // file grew from exactly where we stopped.
                Some(entry)
                    if agent.format == Format::Append
                        && size > entry.size
                        && entry.offset <= entry.size =>
                {
                    Plan::Extend(entry.offset)
                }
                _ => Plan::Full,
            };
            jobs.push(Job {
                agent: agent.id,
                path,
                key,
                plan,
                mtime,
                size,
            });
        }
    }

    // --- seed dedup from files we are not re-reading ---------------------
    // Only ids that survive here; a full re-parse must forget its own ids
    // first or it would dedup against the copy it is replacing.
    let mut seen: HashSet<u64> = HashSet::new();
    for job in &jobs {
        if matches!(job.plan, Plan::Reuse | Plan::Extend(_)) {
            if let Some(entry) = index.files.get(&job.key) {
                seen.extend(entry.ids.iter().copied());
            }
        }
    }

    // --- parse what changed ----------------------------------------------
    let to_read: Vec<&Job> = jobs
        .iter()
        .filter(|j| !matches!(j.plan, Plan::Reuse))
        .collect();
    index_dirty |= !to_read.is_empty();
    let total_read = to_read.len() as u32;
    emit(0, total_read);

    let parsed = parse_all(&to_read, emit);

    // Fold results back into the index. Single-threaded so the dedup set and
    // the row merge stay consistent; the expensive part already happened.
    let mut stats = ScanStats {
        files_seen: jobs.len() as u32,
        files_read: total_read,
        ..ScanStats::default()
    };

    for (job_index, outcome) in parsed.into_iter().enumerate() {
        let job = to_read[job_index];
        let (records, new_offset, bytes) = outcome;
        stats.bytes_read += bytes;

        let entry = index.files.entry(job.key.clone()).or_default();
        if matches!(job.plan, Plan::Full) {
            // Replacing the file wholesale: drop what it previously claimed.
            entry.rows.clear();
            entry.ids.clear();
            entry.last_at = 0;
        }
        entry.mtime = job.mtime;
        entry.size = job.size;
        entry.offset = new_offset;

        let mut fresh: HashMap<(i64, String), Row> = HashMap::new();
        for record in records {
            if record.dedup != 0 && !seen.insert(record.dedup) {
                continue;
            }
            if record.dedup != 0 {
                entry.ids.push(record.dedup);
            }
            entry.last_at = entry.last_at.max(record.at);
            let slot = bucket(record.at, recent_cutoff);
            let row = fresh
                .entry((slot, record.model.clone()))
                .or_insert_with(|| Row {
                    at: slot,
                    model: record.model.clone(),
                    tokens: Tokens::default(),
                    requests: 0,
                    reported_cost: None,
                });
            row.tokens.add(&record.tokens);
            row.requests += 1;
            if let Some(cost) = record.reported_cost {
                *row.reported_cost.get_or_insert(0.0) += cost;
            }
        }
        entry.rows.extend(fresh.into_values());
    }

    // --- aggregate --------------------------------------------------------
    // Path prefix per job so a row can be traced back to its agent.
    let agent_by_key: HashMap<&str, &'static str> =
        jobs.iter().map(|j| (j.key.as_str(), j.agent)).collect();

    let range_days = query.days.max(1) as i64;
    let series_start = day_start(now) - (range_days - 1) * DAY_MS;

    let mut totals = Totals::default();
    let mut by_day: HashMap<i64, HashMap<&'static str, Totals>> = HashMap::new();
    let mut by_agent: HashMap<&'static str, Totals> = HashMap::new();
    let mut last_used: HashMap<&'static str, i64> = HashMap::new();
    let mut by_model: HashMap<(&'static str, String), (Totals, bool)> = HashMap::new();
    let mut unpriced: HashSet<String> = HashSet::new();
    // Which five-minute slots each agent was actually working in, for the duty
    // cycle the quota forecasts project long windows with.
    let duty_cutoff = now - DUTY_DAYS * DAY_MS;
    let mut active_slots: HashMap<&'static str, HashSet<i64>> = HashMap::new();
    let mut first_active: HashMap<&'static str, i64> = HashMap::new();
    for (key, entry) in index.files.iter() {
        let Some(&agent_id) = agent_by_key.get(key.as_str()) else {
            continue;
        };
        for row in &entry.rows {
            let (rates, priced) = pricing::lookup(&row.model, overrides);
            // An agent that priced the call itself knows better than a table
            // of list prices does.
            let cost = row.reported_cost.unwrap_or_else(|| rates.cost(&row.tokens));
            last_used
                .entry(agent_id)
                .and_modify(|last| *last = (*last).max(row.at))
                .or_insert(row.at);

            if row.at >= duty_cutoff && row.requests > 0 {
                active_slots
                    .entry(agent_id)
                    .or_default()
                    .insert(row.at - row.at.rem_euclid(SLOT_MS));
                first_active
                    .entry(agent_id)
                    .and_modify(|first| *first = (*first).min(row.at))
                    .or_insert(row.at);
            }

            if row.at >= series_start {
                if !priced && row.reported_cost.is_none() && row.tokens.total() > 0 {
                    unpriced.insert(row.model.clone());
                }
                totals.add(&row.tokens, cost, row.requests);
                by_agent
                    .entry(agent_id)
                    .or_default()
                    .add(&row.tokens, cost, row.requests);
                let model_entry = by_model
                    .entry((agent_id, row.model.clone()))
                    .or_insert((Totals::default(), priced || row.reported_cost.is_some()));
                model_entry.0.add(&row.tokens, cost, row.requests);
                by_day
                    .entry(day_start(row.at))
                    .or_default()
                    .entry(agent_id)
                    .or_default()
                    .add(&row.tokens, cost, row.requests);
            }
        }
    }

    // --- shape the response ----------------------------------------------
    let mut days = Vec::with_capacity(range_days as usize);
    for offset in 0..range_days {
        let at = series_start + offset * DAY_MS;
        // day_start of a fixed offset can drift across a DST boundary; re-fix.
        let at = day_start(at);
        let slices = by_day.remove(&at).unwrap_or_default();
        let mut day_totals = Totals::default();
        let mut agents: Vec<AgentSlice> = slices
            .into_iter()
            .map(|(agent, t)| {
                day_totals.add(&t.tokens, t.cost, t.requests);
                AgentSlice {
                    agent: agent.to_string(),
                    totals: t,
                }
            })
            .collect();
        agents.sort_by(|a, b| a.agent.cmp(&b.agent));
        days.push(DaySeries {
            date: day_label(at),
            agents,
            totals: day_totals,
        });
    }

    let agents = sources::AGENTS
        .iter()
        .map(|a| {
            let agent_totals = by_agent.get(a.id).copied().unwrap_or_default();
            let last = last_used.get(a.id).copied().unwrap_or_default();
            let files = per_agent_files.get(a.id).copied().unwrap_or(0);
            AgentSummary {
                id: a.id.to_string(),
                label: a.label.to_string(),
                vendor: a.vendor.to_string(),
                installed: files > 0,
                files,
                tracks_tokens: a.id != "antigravity",
                caveat: a.caveat.map(str::to_string),
                last_used: (last > 0).then_some(last),
                totals: agent_totals,
            }
        })
        .collect();

    let mut models: Vec<ModelSummary> = by_model
        .into_iter()
        .map(|((agent, model), (t, priced))| ModelSummary {
            model,
            agent: agent.to_string(),
            priced,
            totals: t,
        })
        .collect();
    models.sort_by(|a, b| {
        b.totals
            .cost
            .partial_cmp(&a.totals.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.totals.tokens.total().cmp(&a.totals.tokens.total()))
    });

    let used_agents: HashSet<&'static str> = by_agent
        .iter()
        .filter_map(|(agent, totals)| (totals.requests > 0).then_some(*agent))
        .collect();
    let history_path = index_path
        .parent()
        .map(|parent| parent.join("quota-history.json"))
        .unwrap_or_else(|| PathBuf::from("quota-history.json"));
    // Reuse discovery work from the index pass. Looking up the newest Codex
    // quota by recursively walking all sessions again added hundreds of
    // milliseconds on large histories.
    let duty = duty_cycles(&active_slots, &first_active, now);
    let quotas = quota::build(
        &used_agents,
        home,
        &history_path,
        latest_codex.as_ref().map(|(_, path)| path.as_path()),
        &duty,
    );

    // --- persist ----------------------------------------------------------
    index_dirty |= compact(index, recent_cutoff, now);
    if index_dirty {
        if let Err(error) = save_index(index_path, index) {
            // A cache we could not write only costs time on the next scan.
            eprintln!("duckweed: could not save usage index: {error}");
        }
    }

    stats.duration_ms = started.elapsed().as_millis() as u64;
    let mut unpriced: Vec<String> = unpriced.into_iter().collect();
    unpriced.sort();

    Ok(Snapshot {
        generated_at: now,
        range_days: range_days as u32,
        totals,
        days,
        agents,
        models,
        quotas,
        unpriced,
        scan: stats,
    })
}

/// What share of the wall clock each agent actually spends burning tokens.
///
/// A quota forecast measured during a working session is a rate per hour of
/// work. Stretched across a multi-day window it has to be deflated by this, or
/// the projection assumes you keep going through the night. Slots come from the
/// transcripts, so the measurement holds for sessions run while Duckweed was
/// closed — which the quota sample history, by construction, cannot see.
///
/// The denominator is the observed span rather than a flat week: someone two
/// days into using an agent is not idle for the five days before that.
fn duty_cycles(
    active_slots: &HashMap<&'static str, HashSet<i64>>,
    first_active: &HashMap<&'static str, i64>,
    now: i64,
) -> HashMap<&'static str, f64> {
    active_slots
        .iter()
        .filter_map(|(agent, slots)| {
            let first = *first_active.get(agent)?;
            let span = (now - first).clamp(DAY_MS, DUTY_DAYS * DAY_MS) as f64;
            let active = slots.len() as f64 * SLOT_MS as f64;
            // Floored well above zero: a duty cycle small enough to push a
            // run-out date past the heat death of the universe is not an
            // estimate, it is a rounding artefact of a very quiet week.
            Some((*agent, (active / span).clamp(0.02, 1.0)))
        })
        .collect()
}

/// Parse the changed files across a small pool of threads.
///
/// Results come back in the same order as `jobs` so the caller can pair them
/// up without threading identifiers through.
fn parse_all(jobs: &[&Job], emit: &(dyn Fn(u32, u32) + Sync)) -> Vec<(Vec<Record>, u64, u64)> {
    let total = jobs.len();
    let mut out: Vec<(Vec<Record>, u64, u64)> = Vec::with_capacity(total);
    if total == 0 {
        return out;
    }

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4)
        .min(total);

    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<(Vec<Record>, u64, u64)>>> =
        (0..total).map(|_| Mutex::new(None)).collect();

    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= total {
                    break;
                }
                let job = jobs[index];
                let from = match job.plan {
                    Plan::Extend(offset) => offset,
                    _ => 0,
                };
                let (records, offset) = sources::parse(job.agent, &job.path, from);
                let bytes = job.size.saturating_sub(from);
                *slots[index].lock().expect("slot poisoned") = Some((records, offset, bytes));

                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                // Progress every 1% or so; emitting per file would flood the
                // webview on a first scan of ten thousand transcripts.
                if finished % 64 == 0 || finished == total {
                    emit(finished as u32, total as u32);
                }
            });
        }
    });

    for slot in slots {
        out.push(
            slot.into_inner()
                .expect("slot poisoned")
                .unwrap_or_else(|| (Vec::new(), 0, 0)),
        );
    }
    out
}

/// Collapse aged five-minute rows into daily ones and drop stale dedup ids.
/// Compact old rows and report whether the persisted index actually changed.
///
/// Warm scans commonly touch no transcripts. Returning a dirty bit lets the
/// caller avoid rewriting a multi-megabyte index merely because Settings was
/// reopened.
fn compact(index: &mut Index, recent_cutoff: i64, now: i64) -> bool {
    let dedup_cutoff = now - DEDUP_DAYS * DAY_MS;
    let mut changed = false;
    for entry in index.files.values_mut() {
        if entry.last_at < dedup_cutoff && !entry.ids.is_empty() {
            entry.ids.clear();
            entry.ids.shrink_to_fit();
            changed = true;
        }
        let needs_collapse = entry
            .rows
            .iter()
            .any(|row| row.at < recent_cutoff && row.at != day_start(row.at));
        if !needs_collapse {
            continue;
        }
        changed = true;
        let mut merged: HashMap<(i64, String), Row> = HashMap::new();
        for row in entry.rows.drain(..) {
            let at = bucket(row.at, recent_cutoff);
            let slot = merged
                .entry((at, row.model.clone()))
                .or_insert_with(|| Row {
                    at,
                    model: row.model.clone(),
                    tokens: Tokens::default(),
                    requests: 0,
                    reported_cost: None,
                });
            slot.tokens.add(&row.tokens);
            slot.requests += row.requests;
            if let Some(cost) = row.reported_cost {
                *slot.reported_cost.get_or_insert(0.0) += cost;
            }
        }
        entry.rows = merged.into_values().collect();
    }
    changed
}

fn load_index(path: &Path) -> Index {
    let parsed: Option<Index> = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    match parsed {
        // A format change invalidates the cache rather than corrupting totals.
        Some(index) if index.version == INDEX_VERSION => index,
        _ => Index {
            version: INDEX_VERSION,
            files: HashMap::new(),
        },
    }
}

fn save_index(path: &Path, index: &Index) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec(index).map_err(|error| error.to_string())?;
    // Write beside the target and rename, so a crash mid-write cannot leave a
    // truncated index that the next launch would silently treat as empty.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_timestamps_land_in_five_minute_slots() {
        let now = now_ms();
        let cutoff = now - RECENT_DAYS * DAY_MS;
        let slot = bucket(now, cutoff);
        assert_eq!(slot % SLOT_MS, 0);
        assert!(now - slot < SLOT_MS);
    }

    #[test]
    fn old_timestamps_collapse_to_local_midnight() {
        let now = now_ms();
        let cutoff = now - RECENT_DAYS * DAY_MS;
        let old = now - 30 * DAY_MS;
        assert_eq!(bucket(old, cutoff), day_start(old));
    }

    #[test]
    fn day_start_is_idempotent() {
        let at = now_ms() - 3 * DAY_MS;
        assert_eq!(day_start(day_start(at)), day_start(at));
    }

    #[test]
    fn tokens_total_counts_every_bucket() {
        let tokens = Tokens {
            input: 1,
            output: 2,
            reasoning: 4,
            cache_read: 8,
            cache_write: 16,
        };
        assert_eq!(tokens.total(), 31);
    }

    #[test]
    fn selected_range_applies_to_totals_agents_and_models() {
        let dir = std::env::temp_dir().join(format!("duckweed-usage-range-{}", std::process::id()));
        let home = dir.join("home");
        let sessions = home.join(".claude/projects/test");
        std::fs::create_dir_all(&sessions).unwrap();

        let recent = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let line = |timestamp: &str, id: &str, input: u64| {
            format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{timestamp}\",\"requestId\":\"{id}\",\
                 \"message\":{{\"id\":\"{id}\",\"model\":\"claude-sonnet-4-5\",\
                 \"usage\":{{\"input_tokens\":{input},\"output_tokens\":10}}}}}}\n"
            )
        };
        std::fs::write(
            sessions.join("session.jsonl"),
            format!("{}{}", line(&old, "old", 10_000), line(&recent, "new", 100)),
        )
        .unwrap();

        let snapshot = scan(
            &home,
            &dir.join("index.json"),
            &Overrides::new(),
            &UsageState::default(),
            &Query {
                days: 7,
                refresh: false,
            },
            &|_, _| {},
        )
        .unwrap();

        let claude = snapshot
            .agents
            .iter()
            .find(|agent| agent.id == "claude")
            .unwrap();
        assert_eq!(snapshot.totals.tokens.input, 100);
        assert_eq!(claude.totals.tokens.input, snapshot.totals.tokens.input);
        assert_eq!(snapshot.models.len(), 1);
        assert_eq!(
            snapshot.models[0].totals.tokens.input,
            snapshot.totals.tokens.input
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_discovered_agent_is_tracked_automatically() {
        let dir =
            std::env::temp_dir().join(format!("duckweed-usage-toggle-{}", std::process::id()));
        let home = dir.join("home");
        let claude_dir = home.join(".claude/projects/test");
        let codex_dir = home.join(".codex/sessions/2026/07/26");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&codex_dir).unwrap();

        let timestamp = chrono::Utc::now().to_rfc3339();
        std::fs::write(
            claude_dir.join("session.jsonl"),
            format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{timestamp}\",\"requestId\":\"c1\",\
                 \"message\":{{\"id\":\"c1\",\"model\":\"claude-sonnet-4-5\",\
                 \"usage\":{{\"input_tokens\":100,\"output_tokens\":10}}}}}}\n"
            ),
        )
        .unwrap();
        std::fs::write(
            codex_dir.join("session.jsonl"),
            format!(
                "{{\"timestamp\":\"{timestamp}\",\"type\":\"event_msg\",\"payload\":{{\
                 \"type\":\"token_count\",\"model\":\"gpt-5.6\",\"info\":{{\"last_token_usage\":\
                 {{\"input_tokens\":200,\"cached_input_tokens\":0,\"output_tokens\":20,\
                 \"reasoning_output_tokens\":0}}}}}}}}\n"
            ),
        )
        .unwrap();

        let state = UsageState::default();
        let index_path = dir.join("index.json");
        let query = Query {
            days: 7,
            refresh: false,
        };

        let cold = scan(
            &home,
            &index_path,
            &Overrides::new(),
            &state,
            &query,
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(cold.scan.files_read, 2);
        assert_eq!(cold.totals.tokens.input, 300);
        assert!(cold.quotas.iter().any(|quota| quota.agent == "claude"));
        assert!(cold.quotas.iter().any(|quota| quota.agent == "codex"));

        let warm = scan(
            &home,
            &index_path,
            &Overrides::new(),
            &state,
            &query,
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(warm.scan.files_read, 0);
        assert_eq!(warm.totals.tokens.input, 300);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compaction_merges_aged_rows_by_day_and_model() {
        let now = now_ms();
        let recent_cutoff = now - RECENT_DAYS * DAY_MS;
        let old = now - 20 * DAY_MS;
        let mut index = Index {
            version: INDEX_VERSION,
            files: HashMap::new(),
        };
        let make = |at: i64| Row {
            at,
            model: "claude-opus-5".into(),
            tokens: Tokens {
                input: 10,
                ..Tokens::default()
            },
            requests: 1,
            reported_cost: None,
        };
        index.files.insert(
            "a".into(),
            FileIndex {
                rows: vec![
                    make(old),
                    make(old + 6 * 60 * 1000),
                    make(old + 12 * 60 * 1000),
                ],
                last_at: old,
                ..FileIndex::default()
            },
        );

        compact(&mut index, recent_cutoff, now);

        let entry = &index.files["a"];
        assert_eq!(
            entry.rows.len(),
            1,
            "same day and model must merge to one row"
        );
        assert_eq!(entry.rows[0].requests, 3);
        assert_eq!(entry.rows[0].tokens.input, 30);
        assert_eq!(entry.rows[0].at, day_start(old));
        // Well outside the dedup window, so the id list is released.
        assert!(entry.ids.is_empty());
    }

    #[test]
    fn compaction_leaves_recent_rows_at_slot_resolution() {
        let now = now_ms();
        let recent_cutoff = now - RECENT_DAYS * DAY_MS;
        let mut index = Index {
            version: INDEX_VERSION,
            files: HashMap::new(),
        };
        let rows = vec![
            Row {
                at: bucket(now - 60 * 60 * 1000, recent_cutoff),
                model: "m".into(),
                tokens: Tokens::default(),
                requests: 1,
                reported_cost: None,
            },
            Row {
                at: bucket(now - 30 * 60 * 1000, recent_cutoff),
                model: "m".into(),
                tokens: Tokens::default(),
                requests: 1,
                reported_cost: None,
            },
        ];
        index.files.insert(
            "a".into(),
            FileIndex {
                rows,
                last_at: now,
                ..FileIndex::default()
            },
        );
        compact(&mut index, recent_cutoff, now);
        assert_eq!(index.files["a"].rows.len(), 2);
    }

    /// Scan the machine this is running on. Ignored by default because it
    /// depends on whatever agents happen to be installed; run it with
    /// `cargo test -- --ignored --nocapture` to sanity-check a parser against
    /// real transcripts.
    #[test]
    #[ignore]
    fn scans_this_machine() {
        let home = PathBuf::from(
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .expect("a home directory"),
        );
        let dir = std::env::temp_dir().join("duckweed-usage-live");
        std::fs::create_dir_all(&dir).unwrap();
        let index_path = dir.join("usage-index.json");

        let state = UsageState::default();
        let query = Query {
            days: 7,
            refresh: true,
        };
        let overrides = Overrides::new();
        let noisy = |done: u32, total: u32| {
            if total > 0 && done % 2048 == 0 {
                eprintln!("  {done}/{total} files");
            }
        };

        let cold = scan(&home, &index_path, &overrides, &state, &query, &noisy).unwrap();
        eprintln!(
            "\ncold: {} files ({} read, {:.1} MB) in {} ms",
            cold.scan.files_seen,
            cold.scan.files_read,
            cold.scan.bytes_read as f64 / 1e6,
            cold.scan.duration_ms
        );
        for agent in cold.agents.iter().filter(|a| a.installed) {
            eprintln!(
                "  {:<16} {:>6} files  {:>14} tokens  ${:>10.2}  {:>7} req",
                agent.label,
                agent.files,
                agent.totals.tokens.total(),
                agent.totals.cost,
                agent.totals.requests
            );
        }
        eprintln!("\ntop models:");
        for model in cold.models.iter().take(8) {
            eprintln!(
                "  {:<40} {:>14} tokens  ${:>9.2} {}",
                model.model,
                model.totals.tokens.total(),
                model.totals.cost,
                if model.priced { "" } else { "(unpriced)" }
            );
        }
        eprintln!("\nlast {} days:", cold.range_days);
        for day in &cold.days {
            eprintln!(
                "  {}  {:>13} tokens  ${:>8.2}",
                day.date,
                day.totals.tokens.total(),
                day.totals.cost
            );
        }
        eprintln!("\nquotas:");
        for quota in &cold.quotas {
            eprintln!("  {} [{}] {:?}", quota.label, quota.source, quota.plan);
            for limit in &quota.limits {
                eprintln!(
                    "    {:<18} {:.1} {} of {:?}  ({:.0}%)",
                    limit.label, limit.used, limit.unit, limit.limit, limit.percent
                );
            }
        }
        if !cold.unpriced.is_empty() {
            eprintln!("\nunpriced models: {:?}", cold.unpriced);
        }

        // Leave the snapshot on disk so the dashboard can be rendered against
        // real numbers instead of invented ones.
        let dump = dir.join("snapshot.json");
        std::fs::write(&dump, serde_json::to_vec_pretty(&cold).unwrap()).unwrap();
        eprintln!("\nsnapshot written to {}", dump.display());

        // A second pass must re-read almost nothing and must not lose or
        // double-count anything. It can legitimately gain a little: an agent
        // session running right now appends while the test is in flight.
        let warm = scan(&home, &index_path, &overrides, &state, &query, &noisy).unwrap();
        eprintln!(
            "\nwarm: {} read, {} ms",
            warm.scan.files_read, warm.scan.duration_ms
        );
        let (before, after) = (cold.totals.tokens.total(), warm.totals.tokens.total());
        assert!(
            after >= before,
            "a re-scan lost tokens: {before} -> {after}"
        );
        assert!(
            after - before < before / 100 + 10_000_000,
            "a re-scan double-counted: {before} -> {after}"
        );
        assert!(
            warm.scan.files_read * 20 < cold.scan.files_read.max(20),
            "warm scan re-read {} of {} files",
            warm.scan.files_read,
            cold.scan.files_seen
        );
    }

    #[test]
    fn a_mismatched_index_version_is_discarded() {
        let dir = std::env::temp_dir().join(format!("duckweed-idx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage-index.json");
        std::fs::write(
            &path,
            r#"{"version":999,"files":{"a":{"mtime":1,"size":2}}}"#,
        )
        .unwrap();
        assert!(load_index(&path).files.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_the_index_round_trips() {
        let dir = std::env::temp_dir().join(format!("duckweed-idx2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage-index.json");
        let mut index = Index {
            version: INDEX_VERSION,
            files: HashMap::new(),
        };
        index.files.insert(
            "f".into(),
            FileIndex {
                mtime: 5,
                size: 9,
                offset: 9,
                rows: vec![Row {
                    at: 1000,
                    model: "claude-opus-5".into(),
                    tokens: Tokens {
                        input: 3,
                        output: 4,
                        ..Tokens::default()
                    },
                    requests: 1,
                    reported_cost: Some(0.25),
                }],
                ids: vec![7],
                last_at: 1000,
            },
        );
        save_index(&path, &index).unwrap();

        let back = load_index(&path);
        let entry = &back.files["f"];
        assert_eq!(entry.offset, 9);
        assert_eq!(entry.rows[0].tokens.output, 4);
        assert_eq!(entry.rows[0].reported_cost, Some(0.25));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
