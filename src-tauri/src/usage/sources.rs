//! Where each coding agent leaves its usage records, and how to read them.
//!
//! Every CLI invented its own on-disk shape, so each one gets its own parser.
//! What they have in common is the output: a flat list of [`Record`]s, one per
//! model request, that the aggregator upstream doesn't have to know the origin
//! of.
//!
//! Two rules keep this cheap over gigabytes of transcripts:
//!
//! * **Byte prefilter before JSON.** Line-delimited transcripts are mostly
//!   tool output and pasted files. A `contains` check on the raw line skips
//!   parsing for the ~99% that carry no usage.
//! * **Append-resume.** Session logs only ever grow, so a re-scan starts at
//!   the byte offset the previous scan finished on.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::Tokens;

/// One model request, normalized across agents.
pub struct Record {
    /// When the request completed, epoch milliseconds.
    pub at: i64,
    pub model: String,
    pub tokens: Tokens,
    /// Set only when the agent priced the call itself, which beats our table.
    pub reported_cost: Option<f64>,
    /// Stable hash of the provider's request id. Records sharing one are the
    /// same billed call seen twice (a resumed or compacted transcript replays
    /// history into a new file). Zero disables the check.
    pub dedup: u64,
}

/// Whether a file grows by appending, and can therefore be resumed.
#[derive(Clone, Copy, PartialEq)]
pub enum Format {
    /// Line-delimited; re-scan reads only the bytes added since last time.
    Append,
    /// Rewritten in place; re-scan re-reads the whole file.
    Whole,
}

pub struct Agent {
    pub id: &'static str,
    pub label: &'static str,
    pub vendor: &'static str,
    pub format: Format,
    /// Shown in the UI when the agent's records are less than complete.
    pub caveat: Option<&'static str>,
}

/// Every agent we know how to read, whether or not it is installed.
pub static AGENTS: &[Agent] = &[
    Agent {
        id: "claude",
        label: "Claude Code",
        vendor: "Anthropic",
        format: Format::Append,
        caveat: None,
    },
    Agent {
        id: "codex",
        label: "Codex CLI",
        vendor: "OpenAI",
        format: Format::Append,
        caveat: None,
    },
    Agent {
        id: "gemini",
        label: "Gemini CLI",
        vendor: "Google",
        format: Format::Whole,
        caveat: None,
    },
    Agent {
        id: "opencode",
        label: "OpenCode",
        vendor: "SST",
        format: Format::Whole,
        caveat: None,
    },
    Agent {
        id: "grok",
        label: "Grok CLI",
        vendor: "xAI",
        format: Format::Append,
        caveat: None,
    },
    Agent {
        id: "droid",
        label: "Factory Droid",
        vendor: "Factory",
        format: Format::Whole,
        caveat: Some(
            "Records one total per session, dated to its last activity — not per request.",
        ),
    },
    Agent {
        id: "kilocode",
        label: "Kilo Code",
        vendor: "Kilo",
        format: Format::Whole,
        caveat: Some("Does not record which model ran, so cost comes from the totals it reports."),
    },
    Agent {
        id: "kimi",
        label: "Kimi CLI",
        vendor: "Moonshot",
        format: Format::Append,
        caveat: None,
    },
    Agent {
        id: "antigravity",
        label: "Antigravity CLI",
        vendor: "Google",
        format: Format::Append,
        caveat: Some("Logs prompts but not token counts, so only activity is tracked."),
    },
    Agent {
        id: "pi",
        label: "Pi Coding Agent",
        vendor: "Open source",
        format: Format::Append,
        caveat: None,
    },
];

/// Files belonging to `agent_id`, or an empty list when it isn't installed.
pub fn discover(agent_id: &str, home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match agent_id {
        "claude" => {
            collect(&home.join(".claude/projects"), "jsonl", &mut out);
            collect(&home.join(".config/claude/projects"), "jsonl", &mut out);
        }
        "codex" => {
            collect(&home.join(".codex/sessions"), "jsonl", &mut out);
            collect(&home.join(".codex/archived_sessions"), "jsonl", &mut out);
        }
        "gemini" => {
            // ~/.gemini/tmp/<project hash>/chats/session-*.json
            collect_matching(&home.join(".gemini/tmp"), "json", &mut out, |p| {
                p.parent().is_some_and(|d| d.ends_with("chats"))
            });
        }
        "opencode" => {
            // Current OpenCode stores messages in SQLite (`opencode.db`). Prefer
            // that over the legacy per-message JSON tree so we do not double-
            // count the same requests after a migration.
            let mut dbs = Vec::new();
            for base in opencode_data_dirs(home) {
                let db = base.join("opencode.db");
                if db.is_file() {
                    dbs.push(db);
                }
            }
            if !dbs.is_empty() {
                out.extend(dbs);
            } else {
                for base in opencode_data_dirs(home) {
                    collect(&base.join("storage/message"), "json", &mut out);
                }
            }
        }
        "grok" => {
            collect_matching(&home.join(".grok/sessions"), "jsonl", &mut out, |p| {
                p.file_name().is_some_and(|n| n == "updates.jsonl")
            });
        }
        "droid" => {
            collect_matching(&home.join(".factory/sessions"), "json", &mut out, |p| {
                p.to_string_lossy().ends_with(".settings.json")
            });
        }
        "kilocode" => {
            collect_matching(
                &home.join(".kilocode/cli/global/tasks"),
                "json",
                &mut out,
                |p| p.file_name().is_some_and(|n| n == "ui_messages.json"),
            );
        }
        "kimi" => {
            collect_matching(&home.join(".kimi-code/sessions"), "jsonl", &mut out, |p| {
                p.file_name().is_some_and(|n| n == "wire.jsonl")
            });
        }
        "antigravity" => {
            let history = home.join(".gemini/antigravity-cli/history.jsonl");
            if history.is_file() {
                out.push(history);
            }
        }
        "pi" => {
            // Pi v0.31+ stores one append-only JSONL session per project.
            collect(&home.join(".pi/agent/sessions"), "jsonl", &mut out);
            // v0.30 briefly wrote sessions directly in the agent directory.
            collect_matching(&home.join(".pi/agent"), "jsonl", &mut out, |p| {
                p.parent().is_some_and(|parent| parent.ends_with("agent"))
            });
        }
        _ => {}
    }
    out
}

fn collect(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    collect_matching(dir, ext, out, |_| true);
}

fn collect_matching(
    dir: &Path,
    ext: &str,
    out: &mut Vec<PathBuf>,
    keep: impl Fn(&Path) -> bool + Copy,
) {
    // Transcript trees are a handful of levels deep; the cap only stops a
    // symlink loop from walking forever.
    fn walk(
        dir: &Path,
        ext: &str,
        depth: u32,
        out: &mut Vec<PathBuf>,
        keep: &dyn Fn(&Path) -> bool,
    ) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&path, ext, depth + 1, out, keep);
            } else if path.extension().is_some_and(|e| e == ext) && keep(&path) {
                out.push(path);
            }
        }
    }
    walk(dir, ext, 0, out, &keep);
}

/// Read `path` from `offset`, returning its records and the new offset.
///
/// The offset is always the end of the last complete line consumed, so a file
/// caught mid-write resumes cleanly next time instead of losing a record to a
/// half-flushed line.
pub fn parse(agent_id: &str, path: &Path, offset: u64) -> (Vec<Record>, u64) {
    match agent_id {
        "claude" => lines(path, offset, "\"usage\"", claude_line),
        "codex" => lines(path, offset, "token_count", codex_line),
        "grok" => lines(path, offset, "\"usage\"", grok_line),
        "kimi" => lines(path, offset, "\"usage\"", kimi_line),
        "antigravity" => lines(path, offset, "\"timestamp\"", antigravity_line),
        "pi" => lines(path, offset, "\"usage\"", pi_line),
        "gemini" => (whole(path, gemini_file), 0),
        "opencode" => {
            if is_opencode_db(path) {
                (opencode_db(path), 0)
            } else {
                (whole(path, opencode_file), 0)
            }
        }
        "droid" => (whole(path, droid_file), 0),
        "kilocode" => (whole(path, kilocode_file), 0),
        _ => (Vec::new(), 0),
    }
}

/// Size + mtime used to decide whether a discovered file needs re-parsing.
///
/// For OpenCode's SQLite database, live writes often land in the `-wal` file
/// until a checkpoint, so the main `.db` alone can look unchanged while new
/// usage has already been recorded. Fold the WAL into the fingerprint.
pub fn fingerprint(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mut size = meta.len();
    let mut mtime = meta_mtime_ms(&meta);
    if is_opencode_db(path) {
        let wal = {
            let mut name = path.as_os_str().to_owned();
            name.push("-wal");
            PathBuf::from(name)
        };
        if let Ok(wal_meta) = std::fs::metadata(&wal) {
            size = size.saturating_add(wal_meta.len());
            mtime = mtime.max(meta_mtime_ms(&wal_meta));
        }
    }
    Some((size, mtime))
}

fn meta_mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_opencode_db(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("db"))
}

/// Directories where OpenCode keeps its local data store.
fn opencode_data_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".local/share/opencode"),
        home.join("AppData/Local/opencode"),
    ];
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            dirs.push(PathBuf::from(xdg).join("opencode"));
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

/// Stream a line-delimited file, parsing only lines containing `needle`.
fn lines(
    path: &Path,
    offset: u64,
    needle: &str,
    each: fn(&Value) -> Option<Vec<Record>>,
) -> (Vec<Record>, u64) {
    let Ok(mut file) = File::open(path) else {
        return (Vec::new(), offset);
    };
    if offset > 0 && file.seek(SeekFrom::Start(offset)).is_err() {
        return (Vec::new(), offset);
    }

    let mut reader = BufReader::with_capacity(1 << 18, file);
    let mut out = Vec::new();
    let mut consumed = offset;
    let mut buf = Vec::new();

    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(read) => {
                // A trailing chunk with no newline is a line still being
                // written. Leave the offset before it and pick it up next scan.
                if !buf.ends_with(b"\n") {
                    break;
                }
                consumed += read as u64;
                // The prefilter is the whole point: most lines are tool output
                // or pasted files and never reach serde.
                let Ok(text) = std::str::from_utf8(&buf) else {
                    continue;
                };
                if !text.contains(needle) {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(text.trim_end()) {
                    if let Some(records) = each(&value) {
                        out.extend(records);
                    }
                }
            }
            Err(_) => break,
        }
    }
    (out, consumed)
}

/// Read a whole file that gets rewritten rather than appended to.
fn whole(path: &Path, each: fn(&Value, &Path) -> Vec<Record>) -> Vec<Record> {
    // Session JSON is small; the guard is only against a pathological file.
    const MAX: u64 = 64 << 20;
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if meta.len() > MAX {
        return Vec::new();
    }
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let mut text = String::new();
    if file.read_to_string(&mut text).is_err() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => each(&value, path),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------- helpers

fn u(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn s<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn hash(text: &str) -> u64 {
    // FNV-1a: no dependency, and collisions across a few hundred thousand
    // request ids are vanishingly unlikely.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

fn f(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Parse an ISO-8601 / RFC-3339 timestamp to epoch milliseconds.
fn iso_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn file_mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- parsers

/// `~/.pi/agent/sessions/<project>/<session>.jsonl`
///
/// Pi persists provider-reported token counts and cost on assistant messages.
/// Compaction, branch-summary, and nested tool work can carry the same shape
/// directly on the entry, so those are counted too.
fn pi_line(value: &Value) -> Option<Vec<Record>> {
    let entry_type = s(value, "type")?;
    let (usage, model, at) = if entry_type == "message" {
        let message = value.get("message")?;
        let usage = message.get("usage")?;
        let model = s(message, "model")
            .map(str::to_string)
            .or_else(|| s(message, "provider").map(|provider| format!("pi/{provider}")))
            .unwrap_or_else(|| "pi/nested".to_string());
        let at = message
            .get("timestamp")
            .and_then(Value::as_i64)
            .or_else(|| s(value, "timestamp").and_then(iso_ms))?;
        (usage, model, at)
    } else if matches!(entry_type, "compaction" | "branch_summary") {
        (
            value.get("usage")?,
            "pi/summary".to_string(),
            s(value, "timestamp").and_then(iso_ms)?,
        )
    } else {
        return None;
    };

    let tokens = Tokens {
        input: u(usage, "input"),
        output: u(usage, "output"),
        reasoning: 0,
        cache_read: u(usage, "cacheRead"),
        cache_write: u(usage, "cacheWrite"),
    };
    if tokens.total() == 0 {
        return None;
    }

    let cost = usage.get("cost");
    let reported_cost = cost.map(|parts| {
        parts
            .get("total")
            .and_then(Value::as_f64)
            .unwrap_or_else(|| {
                f(parts, "input")
                    + f(parts, "output")
                    + f(parts, "cacheRead")
                    + f(parts, "cacheWrite")
            })
    });
    let identity = s(value, "id")
        .map(str::to_string)
        .unwrap_or_else(|| format!("{at}:{model}:{}", tokens.total()));

    Some(vec![Record {
        at,
        model,
        tokens,
        reported_cost,
        dedup: hash(&identity),
    }])
}

/// `~/.claude/projects/<slug>/<session>.jsonl`
///
/// One JSON object per line; assistant turns carry `message.usage`.
fn claude_line(value: &Value) -> Option<Vec<Record>> {
    if s(value, "type")? != "assistant" {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let model = s(message, "model").unwrap_or("unknown");
    // Claude Code writes synthetic assistant turns (interrupts, local errors)
    // that were never billed.
    if model.starts_with('<') {
        return None;
    }
    let at = iso_ms(s(value, "timestamp")?)?;

    // Anthropic reports cache reads and writes outside `input_tokens`, and
    // folds thinking into `output_tokens`.
    let tokens = Tokens {
        input: u(usage, "input_tokens"),
        output: u(usage, "output_tokens"),
        reasoning: 0,
        cache_read: u(usage, "cache_read_input_tokens"),
        cache_write: u(usage, "cache_creation_input_tokens"),
    };
    if tokens.total() == 0 {
        return None;
    }

    // A resumed or compacted session replays earlier turns into a new file;
    // the request id is what makes those the same billed call.
    let key = format!(
        "{}:{}",
        s(message, "id").unwrap_or_default(),
        s(value, "requestId").unwrap_or_default()
    );
    Some(vec![Record {
        at,
        model: model.to_string(),
        tokens,
        reported_cost: None,
        dedup: if key == ":" { 0 } else { hash(&key) },
    }])
}

/// `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
///
/// `token_count` events carry a running total plus the delta for the call that
/// just finished; the delta is what we bill.
fn codex_line(value: &Value) -> Option<Vec<Record>> {
    let payload = value.get("payload")?;
    if s(payload, "type")? != "token_count" {
        return None;
    }
    let last = payload.get("info")?.get("last_token_usage")?;
    let at = iso_ms(s(value, "timestamp")?)?;

    // OpenAI nests both subsets: cached input inside `input_tokens`, reasoning
    // inside `output_tokens`. Split them so nothing is counted twice.
    let cache_read = u(last, "cached_input_tokens");
    let reasoning = u(last, "reasoning_output_tokens");
    let tokens = Tokens {
        input: u(last, "input_tokens").saturating_sub(cache_read),
        output: u(last, "output_tokens").saturating_sub(reasoning),
        reasoning,
        cache_read,
        cache_write: u(last, "cache_write_input_tokens"),
    };
    if tokens.total() == 0 {
        return None;
    }
    Some(vec![Record {
        at,
        model: s(payload, "model")
            .or_else(|| s(value, "model"))
            .unwrap_or("gpt-5.6")
            .to_string(),
        tokens,
        reported_cost: None,
        // Codex writes each event once per session file.
        dedup: 0,
    }])
}

/// `~/.grok/sessions/<workspace>/<session>/updates.jsonl`
///
/// A `turn_completed` update reports the turn's usage, already broken down by
/// model when more than one ran.
fn grok_line(value: &Value) -> Option<Vec<Record>> {
    let update = value.get("params")?.get("update")?;
    let usage = update.get("usage")?;
    // Grok stamps seconds at the top level and milliseconds in `_meta`.
    let at = value
        .get("_meta")
        .and_then(|m| m.get("agentTimestampMs"))
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("timestamp")
                .and_then(Value::as_i64)
                .map(|s| s * 1000)
        })?;

    let one = |model: &str, block: &Value, dedup: u64| {
        let cache_read = u(block, "cachedReadTokens");
        let reasoning = u(block, "reasoningTokens");
        Record {
            at,
            model: model.to_string(),
            tokens: Tokens {
                input: u(block, "inputTokens").saturating_sub(cache_read),
                output: u(block, "outputTokens").saturating_sub(reasoning),
                reasoning,
                cache_read,
                cache_write: u(block, "cacheWriteTokens"),
            },
            reported_cost: None,
            dedup,
        }
    };

    let key = s(update, "prompt_id").map(hash).unwrap_or(0);
    let mut out = Vec::new();
    match usage.get("modelUsage").and_then(Value::as_object) {
        Some(per_model) => {
            for (model, block) in per_model {
                // Each model in the turn needs its own dedup key or the second
                // one would be dropped as a repeat of the first.
                let dedup = if key == 0 { 0 } else { key ^ hash(model) };
                out.push(one(model, block, dedup));
            }
        }
        None => out.push(one("grok-4", usage, key)),
    }
    out.retain(|r| r.tokens.total() > 0);
    (!out.is_empty()).then_some(out)
}

/// `~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`
///
/// An OpenAI-compatible wire log, so usage arrives under either that API's
/// field names or the Anthropic ones depending on the upstream provider.
fn kimi_line(value: &Value) -> Option<Vec<Record>> {
    let usage = value
        .get("usage")
        .or_else(|| value.get("response").and_then(|r| r.get("usage")))?;
    let at = s(value, "timestamp")
        .and_then(iso_ms)
        .or_else(|| {
            value
                .get("created")
                .and_then(Value::as_i64)
                .map(|s| s * 1000)
        })
        .or_else(|| value.get("ts").and_then(Value::as_i64))?;

    let cache_read = u(usage, "cache_read_input_tokens")
        .max(u(usage, "cached_tokens"))
        .max(
            usage
                .get("prompt_tokens_details")
                .map(|d| u(d, "cached_tokens"))
                .unwrap_or(0),
        );
    let input = u(usage, "prompt_tokens")
        .max(u(usage, "input_tokens"))
        .saturating_sub(cache_read);
    let output = u(usage, "completion_tokens").max(u(usage, "output_tokens"));
    let tokens = Tokens {
        input,
        output,
        reasoning: 0,
        cache_read,
        cache_write: u(usage, "cache_creation_input_tokens"),
    };
    if tokens.total() == 0 {
        return None;
    }
    Some(vec![Record {
        at,
        model: s(value, "model")
            .or_else(|| value.get("response").and_then(|r| s(r, "model")))
            .unwrap_or("kimi-k2")
            .to_string(),
        tokens,
        reported_cost: None,
        dedup: s(value, "id").map(hash).unwrap_or(0),
    }])
}

/// `~/.gemini/antigravity-cli/history.jsonl`
///
/// Prompts only. Antigravity keeps its turns in protobuf blobs inside per
/// conversation SQLite files and records no token counts, so all we can
/// honestly report is that a request happened.
fn antigravity_line(value: &Value) -> Option<Vec<Record>> {
    let at = value.get("timestamp").and_then(Value::as_i64)?;
    value.get("display")?;
    Some(vec![Record {
        at,
        model: "antigravity".into(),
        tokens: Tokens::default(),
        reported_cost: None,
        dedup: 0,
    }])
}

/// `~/.gemini/tmp/<project hash>/chats/session-*.json`
///
/// The whole conversation in one file. Gemini keeps thinking tokens separate
/// from output rather than nested inside it.
fn gemini_file(value: &Value, _path: &Path) -> Vec<Record> {
    let Some(messages) = value.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let session = s(value, "sessionId").unwrap_or_default();
    let mut out = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let Some(usage) = message.get("tokens") else {
            continue;
        };
        let Some(at) = s(message, "timestamp").and_then(iso_ms) else {
            continue;
        };
        let tokens = Tokens {
            input: u(usage, "input"),
            output: u(usage, "output"),
            reasoning: u(usage, "thoughts"),
            cache_read: u(usage, "cached"),
            cache_write: 0,
        };
        if tokens.total() == 0 {
            continue;
        }
        // Gemini gives messages a uuid, but falling back to the session and
        // index keeps a rewritten file from double-counting.
        let key = match s(message, "id") {
            Some(id) => id.to_string(),
            None => format!("{session}:{index}"),
        };
        out.push(Record {
            at,
            model: s(message, "model").unwrap_or("gemini-3-pro").to_string(),
            tokens,
            reported_cost: None,
            dedup: hash(&key),
        });
    }
    out
}

/// `~/.local/share/opencode/storage/message/<session>/<message>.json`
///
/// One file per message (legacy), and the only agent here that prices its own
/// calls. Current OpenCode keeps the same JSON shape inside `opencode.db`.
fn opencode_file(value: &Value, _path: &Path) -> Vec<Record> {
    if s(value, "role") != Some("assistant") {
        return Vec::new();
    }
    let Some(usage) = value.get("tokens") else {
        return Vec::new();
    };
    let at = value
        .get("time")
        .and_then(|t| t.get("completed").or_else(|| t.get("created")))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if at == 0 {
        return Vec::new();
    }
    let cache = usage.get("cache");
    let tokens = Tokens {
        input: u(usage, "input"),
        output: u(usage, "output"),
        reasoning: u(usage, "reasoning"),
        cache_read: cache.map(|c| u(c, "read")).unwrap_or(0),
        cache_write: cache.map(|c| u(c, "write")).unwrap_or(0),
    };
    if tokens.total() == 0 {
        return Vec::new();
    }
    let model = s(value, "modelID")
        .map(str::to_string)
        .or_else(|| {
            value
                .get("model")
                .and_then(|m| s(m, "modelID").map(str::to_string))
        })
        .unwrap_or_else(|| "unknown".to_string());
    // Prefer the message id; fall back to a stable hash of the payload so
    // rows without an id still dedup across JSON ↔ SQLite migrations.
    let dedup = s(value, "id").map(hash).unwrap_or_else(|| hash(&format!("{model}:{at}:{}", tokens.total())));
    vec![Record {
        at,
        model,
        tokens,
        reported_cost: value.get("cost").and_then(Value::as_f64),
        dedup,
    }]
}

/// `~/.local/share/opencode/opencode.db` — current on-disk store.
///
/// The `message` table holds one JSON document per row in the same shape the
/// legacy per-file storage used, so the record parser is shared.
fn opencode_db(path: &Path) -> Vec<Record> {
    use rusqlite::{Connection, OpenFlags};

    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(path, flags) else {
        return Vec::new();
    };
    let mut stmt = match conn.prepare("SELECT data FROM message") {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for data in rows.flatten() {
        // Same prefilter idea as line-delimited sources: skip user rows and
        // anything without token totals before paying for a full parse.
        if !data.contains("tokens") {
            continue;
        }
        if !(data.contains("\"role\":\"assistant\"") || data.contains("\"role\": \"assistant\"")) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        out.extend(opencode_file(&value, path));
    }
    out
}

/// `~/.factory/sessions/**/<session>.settings.json`
///
/// Droid keeps a per-session running total and never says which model spent
/// it, so the whole session lands on the day it was last touched.
fn droid_file(value: &Value, path: &Path) -> Vec<Record> {
    let Some(usage) = value.get("tokenUsage") else {
        return Vec::new();
    };
    let tokens = Tokens {
        input: u(usage, "inputTokens"),
        output: u(usage, "outputTokens"),
        reasoning: u(usage, "thinkingTokens"),
        cache_read: u(usage, "cacheReadTokens"),
        cache_write: u(usage, "cacheCreationTokens"),
    };
    if tokens.total() == 0 {
        return Vec::new();
    }
    // `providerLock` is the closest thing to a model the file records. It
    // won't match the price table, which is the honest outcome: the tokens
    // are real, the cost is unknown.
    let model = s(value, "providerLock")
        .or_else(|| s(value, "apiProviderLock"))
        .unwrap_or("unknown");
    vec![Record {
        at: file_mtime_ms(path),
        model: format!("droid/{model}"),
        tokens,
        reported_cost: None,
        dedup: 0,
    }]
}

/// `~/.kilocode/cli/global/tasks/<task>/ui_messages.json`
///
/// Cline-style: each API call is a `say` entry whose `text` is itself a JSON
/// string holding the usage and the price Kilo computed.
fn kilocode_file(value: &Value, _path: &Path) -> Vec<Record> {
    let Some(entries) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        if s(entry, "say") != Some("api_req_started") {
            continue;
        }
        let Some(at) = entry.get("ts").and_then(Value::as_i64) else {
            continue;
        };
        let Some(inner) = s(entry, "text").and_then(|t| serde_json::from_str::<Value>(t).ok())
        else {
            continue;
        };
        let tokens = Tokens {
            input: u(&inner, "tokensIn"),
            output: u(&inner, "tokensOut"),
            reasoning: 0,
            cache_read: u(&inner, "cacheReads"),
            cache_write: u(&inner, "cacheWrites"),
        };
        if tokens.total() == 0 {
            continue;
        }
        // The record names a provider, never a model, so Kilo's own `cost` is
        // the only price available.
        let provider = s(&inner, "inferenceProvider")
            .or_else(|| s(&inner, "apiProtocol"))
            .unwrap_or("unknown");
        out.push(Record {
            at,
            model: format!("kilocode/{provider}"),
            tokens,
            reported_cost: inner.get("cost").and_then(Value::as_f64),
            dedup: hash(&format!("{at}:{}", tokens.total())),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(json: &str, f: fn(&Value) -> Option<Vec<Record>>) -> Record {
        let value: Value = serde_json::from_str(json).unwrap();
        f(&value).unwrap().into_iter().next().unwrap()
    }

    #[test]
    fn claude_reads_the_four_token_buckets() {
        let record = one(
            r#"{"type":"assistant","timestamp":"2026-07-06T12:34:15.306Z","requestId":"req_1",
                "message":{"id":"msg_1","model":"claude-opus-4-8","usage":{
                  "input_tokens":5039,"cache_creation_input_tokens":16581,
                  "cache_read_input_tokens":700,"output_tokens":250}}}"#,
            claude_line,
        );
        assert_eq!(record.tokens.input, 5039);
        assert_eq!(record.tokens.output, 250);
        assert_eq!(record.tokens.cache_write, 16581);
        assert_eq!(record.tokens.cache_read, 700);
        assert_eq!(record.model, "claude-opus-4-8");
        assert_ne!(record.dedup, 0);
    }

    #[test]
    fn pi_keeps_provider_reported_usage_and_cost() {
        let record = one(
            r#"{"type":"message","id":"b2c3d4e5","timestamp":"2026-07-26T12:00:02.000Z",
                "message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-5",
                "timestamp":1785067202000,"usage":{"input":1200,"output":300,
                "cacheRead":800,"cacheWrite":50,"totalTokens":2350,
                "cost":{"input":0.0036,"output":0.0045,"cacheRead":0.00024,
                "cacheWrite":0.0001875,"total":0.0085275}}}}"#,
            pi_line,
        );
        assert_eq!(record.model, "claude-sonnet-4-5");
        assert_eq!(record.tokens.input, 1200);
        assert_eq!(record.tokens.output, 300);
        assert_eq!(record.tokens.cache_read, 800);
        assert_eq!(record.tokens.cache_write, 50);
        assert_eq!(record.reported_cost, Some(0.0085275));
        assert_ne!(record.dedup, 0);
    }

    #[test]
    fn claude_skips_synthetic_turns() {
        let value: Value = serde_json::from_str(
            r#"{"type":"assistant","timestamp":"2026-07-06T12:34:15.306Z",
                "message":{"model":"<synthetic>","usage":{"input_tokens":10,"output_tokens":1}}}"#,
        )
        .unwrap();
        assert!(claude_line(&value).is_none());
    }

    #[test]
    fn codex_unnests_cached_input_and_reasoning_output() {
        let record = one(
            r#"{"timestamp":"2026-07-25T18:53:16.145Z","type":"event_msg","payload":{
                 "type":"token_count","model":"gpt-5.6","info":{"last_token_usage":{
                   "input_tokens":92849,"cached_input_tokens":91904,"cache_write_input_tokens":0,
                   "output_tokens":136,"reasoning_output_tokens":80}}}}"#,
            codex_line,
        );
        // Both subsets must come out of their parent or they bill twice.
        assert_eq!(record.tokens.input, 945);
        assert_eq!(record.tokens.cache_read, 91904);
        assert_eq!(record.tokens.output, 56);
        assert_eq!(record.tokens.reasoning, 80);
    }

    #[test]
    fn codex_ignores_rate_limit_only_events() {
        let value: Value = serde_json::from_str(
            r#"{"timestamp":"2026-07-26T14:12:32.599Z","type":"event_msg",
                "payload":{"type":"token_count","info":null,"rate_limits":{}}}"#,
        )
        .unwrap();
        assert!(codex_line(&value).is_none());
    }

    #[test]
    fn grok_splits_a_turn_across_its_models() {
        let value: Value = serde_json::from_str(
            r#"{"timestamp":1783905046,"params":{"update":{"sessionUpdate":"turn_completed",
                 "prompt_id":"p1","usage":{"inputTokens":100,"outputTokens":10,
                 "modelUsage":{"grok-4.5":{"inputTokens":60,"outputTokens":6,"cachedReadTokens":50},
                               "grok-4-fast":{"inputTokens":40,"outputTokens":4}}}}},
                "_meta":{"agentTimestampMs":1783905046913}}"#,
        )
        .unwrap();
        let mut records = grok_line(&value).unwrap();
        records.sort_by(|a, b| a.model.cmp(&b.model));
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].model, "grok-4-fast");
        assert_eq!(records[1].tokens.input, 10);
        assert_eq!(records[1].tokens.cache_read, 50);
        // Milliseconds from _meta win over the seconds at the top level.
        assert_eq!(records[0].at, 1783905046913);
        // Same turn, different models — the keys must differ.
        assert_ne!(records[0].dedup, records[1].dedup);
    }

    #[test]
    fn gemini_keeps_thoughts_out_of_output() {
        let value: Value = serde_json::from_str(
            r#"{"sessionId":"s1","messages":[{"id":"m1","type":"gemini","model":"gemini-3.1-pro-preview",
                 "timestamp":"2026-04-21T12:44:53.969Z",
                 "tokens":{"input":12362,"output":81,"cached":0,"thoughts":339,"total":12782}}]}"#,
        )
        .unwrap();
        let records = gemini_file(&value, Path::new("x"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].tokens.output, 81);
        assert_eq!(records[0].tokens.reasoning, 339);
    }

    #[test]
    fn opencode_keeps_the_cost_it_reported() {
        let value: Value = serde_json::from_str(
            r#"{"id":"msg_1","role":"assistant","modelID":"google/gemini-3-flash-preview",
                "time":{"created":1770727888601,"completed":1770727895423},"cost":0.0104335,
                "tokens":{"input":20567,"output":50,"reasoning":0,"cache":{"read":0,"write":0}}}"#,
        )
        .unwrap();
        let records = opencode_file(&value, Path::new("x"));
        assert_eq!(records[0].reported_cost, Some(0.0104335));
        assert_eq!(records[0].at, 1770727895423);
        assert_eq!(records[0].model, "google/gemini-3-flash-preview");
    }

    #[test]
    fn opencode_sqlite_reads_assistant_usage_rows() {
        let dir = std::env::temp_dir().join(format!(
            "duckweed-opencode-db-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("opencode.db");

        {
            use rusqlite::Connection;
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "msg_1",
                    "ses_1",
                    1770727888601i64,
                    1770727895423i64,
                    r#"{"id":"msg_1","role":"assistant","modelID":"anthropic/claude-sonnet-4-5",
                        "providerID":"openrouter",
                        "time":{"created":1770727888601,"completed":1770727895423},
                        "cost":1.25,
                        "tokens":{"input":1000,"output":200,"reasoning":50,"cache":{"read":10,"write":5}}}"#,
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "msg_user",
                    "ses_1",
                    1770727888000i64,
                    1770727888000i64,
                    r#"{"id":"msg_user","role":"user","time":{"created":1770727888000}}"#,
                ],
            )
            .unwrap();
        }

        let (records, _) = parse("opencode", &path, 0);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].model, "anthropic/claude-sonnet-4-5");
        assert_eq!(records[0].tokens.input, 1000);
        assert_eq!(records[0].tokens.output, 200);
        assert_eq!(records[0].tokens.reasoning, 50);
        assert_eq!(records[0].tokens.cache_read, 10);
        assert_eq!(records[0].tokens.cache_write, 5);
        assert_eq!(records[0].reported_cost, Some(1.25));
        assert_eq!(records[0].at, 1770727895423);

        // Prefer the database when both stores exist under the same home.
        let home = dir.join("home");
        let base = home.join(".local/share/opencode");
        std::fs::create_dir_all(base.join("storage/message/ses")).unwrap();
        std::fs::copy(&path, base.join("opencode.db")).unwrap();
        std::fs::write(
            base.join("storage/message/ses/msg.json"),
            r#"{"id":"legacy","role":"assistant","modelID":"x","time":{"completed":1},
                "cost":9,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}"#,
        )
        .unwrap();
        let found = discover("opencode", &home);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].file_name().and_then(|n| n.to_str()),
            Some("opencode.db")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kilocode_unwraps_the_nested_json_string() {
        let value: Value = serde_json::from_str(
            r#"[{"ts":1771854655731,"type":"say","say":"api_req_started",
                 "text":"{\"tokensIn\":8559,\"tokensOut\":204,\"cacheReads\":320,\"cost\":0.5,\"inferenceProvider\":\"Novita\"}"}]"#,
        )
        .unwrap();
        let records = kilocode_file(&value, Path::new("x"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].tokens.input, 8559);
        assert_eq!(records[0].reported_cost, Some(0.5));
        assert_eq!(records[0].model, "kilocode/Novita");
    }

    #[test]
    fn append_parsing_stops_before_a_half_written_line() {
        let dir = std::env::temp_dir().join(format!("duckweed-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let complete = "{\"type\":\"assistant\",\"timestamp\":\"2026-07-06T12:34:15.306Z\",\"requestId\":\"r\",\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n";
        std::fs::write(&path, format!("{complete}{{\"partial\":\"usage")).unwrap();

        let (records, offset) = parse("claude", &path, 0);
        assert_eq!(records.len(), 1);
        assert_eq!(offset, complete.len() as u64);

        // Finishing the line makes it readable on the next pass, without
        // re-reading the record we already have.
        std::fs::write(&path, format!("{complete}{complete}")).unwrap();
        let (more, next) = parse("claude", &path, offset);
        assert_eq!(more.len(), 1);
        assert_eq!(next, 2 * complete.len() as u64);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
