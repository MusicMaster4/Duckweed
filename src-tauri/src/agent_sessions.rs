//! Past conversations of the coding-agent CLIs, so the custom UI can resume one.
//!
//! Every agent keeps its own durable record of a conversation, and no two agree
//! on where it lives or what it looks like: Claude writes one JSONL per session
//! under a mangled project folder, Codex writes date-partitioned rollouts whose
//! first line names the working directory, Grok keeps a directory per session
//! under a percent-encoded project name, and OpenCode stores one small JSON per
//! session with the directory inside it. Reading those files is the only way to
//! answer "what did I run in *this* folder?" before the agent is even started —
//! none of the protocols will answer it, and two of them (Claude, Grok) cannot
//! answer it at all.
//!
//! Only enough of each record is read to fill a picker row: an id to resume, a
//! title, and when it was last touched. Codex rollouts are streamed until their
//! first real prompt because resumed conversations can put it deep in the file.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Rows returned to the picker. The picker has a search box, so this bounds the
/// payload rather than what a person can choose from: a folder worked in for a
/// month has hundreds of past conversations, and cutting the searchable source
/// to what fits on screen makes every row outside that window unfindable.
const MAX_RESULTS: usize = 400;
/// Rollouts opened per Codex listing. This caps a walk over a store that is
/// partitioned by date rather than by project, so one folder's history is
/// scattered across all of it. Only the first line of each file is read during
/// that walk, which is what makes a walk this wide affordable.
const MAX_SCANNED: usize = 20_000;
/// Bytes read from the head of a transcript while looking for its first prompt.
/// Codex prepends its whole system prompt, which is ~40 KB on its own.
const HEAD_BYTES: u64 = 256 * 1024;
/// Longest title kept; the picker truncates visually, this bounds the payload.
const MAX_TITLE: usize = 160;
/// A resumed transcript stays bounded so one long-running chat cannot freeze a pane.
const MAX_TRANSCRIPT_ITEMS: usize = 1_000;
const MAX_TRANSCRIPT_TEXT: usize = 400_000;
const MAX_TRANSCRIPT_TOOL_OUTPUT: usize = 20_000;

/// One resumable conversation.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    /// What the agent's resume takes — a CLI flag value or a protocol id.
    pub id: String,
    /// First prompt, or the name the agent gave the thread. Empty when unknown.
    pub title: String,
    /// Milliseconds since the epoch, newest activity.
    pub updated_at: i64,
    /// Milliseconds since the epoch, or 0 when the record does not say.
    pub created_at: i64,
    /// Turns/messages counted, or 0 when counting would mean reading it all.
    pub message_count: u32,
    /// Model the session ran with, when the record names one.
    pub model: String,
    /// Absolute path of the record, for diagnostics and tie-breaking.
    pub path: String,
}

/// Visible history normalized to the same item shapes used by the frontend.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentTranscriptItem {
    User {
        id: String,
        at: i64,
        text: String,
    },
    Assistant {
        id: String,
        at: i64,
        text: String,
        streaming: bool,
    },
    Thinking {
        id: String,
        at: i64,
        text: String,
        streaming: bool,
    },
    Tool {
        id: String,
        at: i64,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        tool: String,
        title: String,
        status: String,
        command: Option<String>,
        output: String,
        changes: Vec<Value>,
    },
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Claude names a project folder by replacing every non-alphanumeric character:
/// `H:\Python\Slop\duckweed` → `H--Python-Slop-duckweed`.
fn claude_project_slug(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|char| if char.is_alphanumeric() { char } else { '-' })
        .collect()
}

/// `encodeURIComponent`, which is how Grok names its per-project folders.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn same_path(left: &str, right: &str) -> bool {
    if left.is_empty() {
        return false;
    }
    #[cfg(windows)]
    {
        let normalize = |value: &str| {
            let normalized = value
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase();
            if let Some(rest) = normalized.strip_prefix(r"\\?\unc\") {
                format!(r"\\{rest}")
            } else if let Some(rest) = normalized.strip_prefix(r"\\?\") {
                rest.to_string()
            } else {
                normalized
            }
        };
        normalize(left) == normalize(right)
    }
    #[cfg(not(windows))]
    {
        Path::new(left) == Path::new(right)
    }
}

fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn modified_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(millis)
        .unwrap_or(0)
}

fn created_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.created())
        .map(millis)
        .unwrap_or(0)
}

/// RFC 3339 (`2026-07-27T11:07:21.294Z`) → epoch millis, 0 when unparseable.
fn parse_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|stamp| stamp.timestamp_millis())
        .unwrap_or(0)
}

/// Collapse a prompt to one line the picker can show.
fn clean_title(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_TITLE {
        return flat;
    }
    let mut title: String = flat.chars().take(MAX_TITLE - 1).collect();
    title.push('…');
    title
}

/// True for text that is a wrapper the user never typed.
///
/// Both CLIs push context into the conversation as user turns: Claude wraps
/// slash-command plumbing and hook output in tags, Codex opens every thread
/// with `<recommended_plugins>` and the project's AGENTS.md. Any of them makes
/// a fine transcript and a useless session title — every row would read the
/// same — so a turn that opens with a tag or a project-instruction heading is
/// skipped in favour of the next one.
fn is_synthetic_prompt(text: &str) -> bool {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return true;
    }
    // An opening tag on the first line: `<system-reminder>`, `<INSTRUCTIONS>`,
    // `<recommended_plugins>`, `<user_instructions>`, …
    if trimmed.starts_with('<') {
        let head: String = trimmed.chars().take(64).collect();
        if head.contains('>') {
            return true;
        }
    }
    trimmed.starts_with("Caveat: The messages below")
        || trimmed.starts_with("# AGENTS.md")
        || trimmed.starts_with("# CLAUDE.md")
}

/// Read at most [`HEAD_BYTES`] of a file as lossy UTF-8.
fn read_head(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(HEAD_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Text of a message body that may be a string or a content-block array.
fn message_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    let Some(blocks) = value.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn bounded_text(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    let keep = limit.saturating_sub(1);
    let tail: String = text.chars().skip(count - keep).collect();
    format!("…{tail}")
}

fn record_timestamp(record: &Value, fallback: i64) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .map(parse_timestamp)
        .filter(|stamp| *stamp > 0)
        .unwrap_or(fallback)
}

fn claude_tool_kind(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "read" => "read",
        "edit" | "write" | "multiedit" | "notebookedit" => "edit",
        "grep" | "glob" => "search",
        "bash" => "execute",
        "webfetch" | "websearch" => "fetch",
        "task" | "sendmessage" => "task",
        "todowrite" | "taskcreate" | "taskupdate" | "tasklist" | "taskget" => "todo",
        _ => "other",
    }
}

fn claude_tool_title(name: &str, input: &Value) -> String {
    let key = match name.to_ascii_lowercase().as_str() {
        "bash" => "command",
        "read" | "edit" | "write" | "multiedit" | "notebookedit" => "file_path",
        "grep" | "glob" => "pattern",
        "webfetch" => "url",
        "task" => "description",
        "taskcreate" => "subject",
        "taskupdate" | "taskget" => "taskId",
        _ => "",
    };
    let detail = if key.is_empty() {
        String::new()
    } else {
        input
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    clean_title(if detail.is_empty() { name } else { &detail })
}

fn claude_transcript(path: &Path) -> Result<Vec<AgentTranscriptItem>, String> {
    let file =
        File::open(path).map_err(|error| format!("could not open Claude transcript: {error}"))?;
    let fallback_at = modified_millis(path);
    let mut items = Vec::new();
    let mut tools: HashMap<String, usize> = HashMap::new();

    for (line_index, line) in BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        if items.len() >= MAX_TRANSCRIPT_ITEMS {
            break;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        if record_type != "user" && record_type != "assistant" {
            continue;
        }
        let message = record.get("message").unwrap_or(&Value::Null);
        let content = message.get("content").unwrap_or(&Value::Null);
        let base_id = record
            .get("uuid")
            .and_then(Value::as_str)
            .or_else(|| message.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("history-{line_index}"));
        let at = record_timestamp(&record, fallback_at + line_index as i64);

        if record_type == "user" {
            let mut has_tool_result = false;
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    has_tool_result = true;
                    let Some(call_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(index) = tools.get(call_id).copied() else {
                        continue;
                    };
                    let output = bounded_text(
                        &message_text(block.get("content").unwrap_or(&Value::Null)),
                        MAX_TRANSCRIPT_TOOL_OUTPUT,
                    );
                    if let Some(AgentTranscriptItem::Tool {
                        status,
                        output: stored_output,
                        ..
                    }) = items.get_mut(index)
                    {
                        *status = if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                            "error".to_string()
                        } else {
                            "done".to_string()
                        };
                        *stored_output = output;
                    }
                }
            }
            if has_tool_result {
                continue;
            }
            let text = message_text(content);
            if text.trim().is_empty() || is_synthetic_prompt(&text) {
                continue;
            }
            items.push(AgentTranscriptItem::User {
                id: format!("user-{base_id}"),
                at,
                text: bounded_text(&text, MAX_TRANSCRIPT_TEXT),
            });
            continue;
        }

        let Some(blocks) = content.as_array() else {
            let text = message_text(content);
            if !text.trim().is_empty() {
                items.push(AgentTranscriptItem::Assistant {
                    id: format!("assistant-{base_id}"),
                    at,
                    text: bounded_text(&text, MAX_TRANSCRIPT_TEXT),
                    streaming: false,
                });
            }
            continue;
        };
        for (block_index, block) in blocks.iter().enumerate() {
            if items.len() >= MAX_TRANSCRIPT_ITEMS {
                break;
            }
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            match block_type {
                "text" => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.trim().is_empty() {
                        items.push(AgentTranscriptItem::Assistant {
                            id: format!("assistant-{base_id}-{block_index}"),
                            at,
                            text: bounded_text(text, MAX_TRANSCRIPT_TEXT),
                            streaming: false,
                        });
                    }
                }
                "thinking" => {
                    let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                    if !text.trim().is_empty() {
                        items.push(AgentTranscriptItem::Thinking {
                            id: format!("thinking-{base_id}-{block_index}"),
                            at,
                            text: bounded_text(text, MAX_TRANSCRIPT_TEXT),
                            streaming: false,
                        });
                    }
                }
                "tool_use" => {
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{base_id}-{block_index}"));
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let input = block.get("input").unwrap_or(&Value::Null);
                    let command = if name.eq_ignore_ascii_case("bash") {
                        input
                            .get("command")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    } else {
                        None
                    };
                    let index = items.len();
                    items.push(AgentTranscriptItem::Tool {
                        id: format!("tool-{call_id}"),
                        at,
                        call_id: call_id.clone(),
                        title: claude_tool_title(&name, input),
                        tool: claude_tool_kind(&name).to_string(),
                        name,
                        status: "done".to_string(),
                        command,
                        output: String::new(),
                        changes: Vec::new(),
                    });
                    tools.insert(call_id, index);
                }
                _ => {}
            }
        }
    }

    Ok(items)
}

// ---------------------------------------------------------------- Claude Code

/// `~/.claude/projects/<slug>/<session-id>.jsonl`, one file per session.
///
/// The id is the file stem — that is exactly what `claude --resume` takes.
fn claude_sessions(home: &Path, cwd: &Path) -> Vec<AgentSessionSummary> {
    let slug = claude_project_slug(cwd);
    let roots = [
        home.join(".claude/projects").join(&slug),
        home.join(".config/claude/projects").join(&slug),
    ];

    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots.iter() {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                files.push(path);
            }
        }
    }

    files.sort_by_key(|path| std::cmp::Reverse(modified_millis(path)));
    files.truncate(MAX_RESULTS);

    files
        .into_iter()
        .filter_map(|path| {
            let id = path.file_stem()?.to_string_lossy().to_string();
            let head = read_head(&path)?;
            let mut summary = AgentSessionSummary {
                id,
                updated_at: modified_millis(&path),
                created_at: created_millis(&path),
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            };
            for line in head.lines() {
                let Ok(record) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                // A `summary` record is Claude's own name for the thread and
                // beats the raw first prompt whenever the CLI wrote one.
                if record.get("type").and_then(Value::as_str) == Some("summary") {
                    if let Some(text) = record.get("summary").and_then(Value::as_str) {
                        summary.title = clean_title(text);
                    }
                    continue;
                }
                if record.get("type").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                if summary.created_at == 0 {
                    if let Some(stamp) = record.get("timestamp").and_then(Value::as_str) {
                        summary.created_at = parse_timestamp(stamp);
                    }
                }
                if summary.title.is_empty() {
                    let text = record
                        .get("message")
                        .and_then(|message| message.get("content"))
                        .map(message_text)
                        .unwrap_or_default();
                    if !is_synthetic_prompt(&text) {
                        summary.title = clean_title(&text);
                    }
                }
                if !summary.title.is_empty() && summary.created_at != 0 {
                    break;
                }
            }
            // A transcript with no user turn is a session that was opened and
            // abandoned; resuming one would land in an empty conversation.
            if summary.title.is_empty() {
                return None;
            }
            Some(summary)
        })
        .collect()
}

// ---------------------------------------------------------------------- Codex

/// The newest versioned state database used by the installed Codex CLI.
fn codex_state_database(home: &Path) -> Option<PathBuf> {
    fs::read_dir(home.join(".codex"))
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((version, path))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

/// Canonical rollout paths for active Codex threads in one working directory.
///
/// A resumed thread keeps the rollout path from the day it was created. The
/// raw completion monitor uses this index to find that file without walking
/// every historical date directory on each discovery pass.
pub(crate) fn codex_rollout_paths(home: &Path, cwd: &Path) -> Vec<PathBuf> {
    use rusqlite::{Connection, OpenFlags};

    let Some(database) = codex_state_database(home) else {
        return Vec::new();
    };
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(connection) = Connection::open_with_flags(database, flags) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT rollout_path, cwd \
         FROM threads \
         WHERE archived = 0 \
         ORDER BY COALESCE(NULLIF(recency_at_ms, 0), \
                           NULLIF(updated_at_ms, 0), updated_at * 1000) DESC",
    ) else {
        return Vec::new();
    };
    let Ok(mut rows) = statement.query([]) else {
        return Vec::new();
    };
    let cwd_text = cwd.to_string_lossy();
    let mut paths = Vec::new();

    while let Ok(Some(row)) = rows.next() {
        let Ok(path) = row.get::<_, String>(0) else {
            continue;
        };
        let Ok(session_cwd) = row.get::<_, String>(1) else {
            continue;
        };
        if !path.trim().is_empty() && same_path(&session_cwd, &cwd_text) {
            paths.push(PathBuf::from(path));
        }
    }
    paths
}

/// Current Codex versions keep the resume picker's canonical rows in SQLite.
/// Reading this first avoids racing a newly created rollout and uses the same
/// title and recency values as `codex resume`.
fn codex_database_sessions(home: &Path, cwd: &Path) -> Option<Vec<AgentSessionSummary>> {
    use rusqlite::{Connection, OpenFlags};

    let database = codex_state_database(home)?;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(database, flags).ok()?;
    let mut statement = connection
        .prepare(
            "SELECT id, rollout_path, created_at, updated_at, cwd, title, model, \
                    created_at_ms, updated_at_ms, recency_at_ms, preview, \
                    first_user_message, name \
             FROM threads \
             WHERE archived = 0 \
             ORDER BY COALESCE(NULLIF(recency_at_ms, 0), \
                               NULLIF(updated_at_ms, 0), updated_at * 1000) DESC",
        )
        .ok()?;
    let mut rows = statement.query([]).ok()?;
    let cwd_text = cwd.to_string_lossy().to_string();
    let mut found = Vec::new();

    while let Some(row) = rows.next().ok()? {
        let session_cwd = row.get::<_, String>(4).ok()?;
        if !same_path(&session_cwd, &cwd_text) {
            continue;
        }

        let title = [
            row.get::<_, Option<String>>(12).ok()?.unwrap_or_default(),
            row.get::<_, String>(5).ok()?,
            row.get::<_, String>(11).ok()?,
            row.get::<_, String>(10).ok()?,
        ]
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .map(|value| clean_title(&value))
        .unwrap_or_else(|| "Untitled session".to_string());
        let created_seconds = row.get::<_, i64>(2).ok()?;
        let updated_seconds = row.get::<_, i64>(3).ok()?;
        let created_millis = row.get::<_, Option<i64>>(7).ok()?.unwrap_or(0);
        let updated_millis = row.get::<_, Option<i64>>(8).ok()?.unwrap_or(0);
        let recency_millis = row.get::<_, Option<i64>>(9).ok()?.unwrap_or(0);

        found.push(AgentSessionSummary {
            id: row.get(0).ok()?,
            title,
            updated_at: [recency_millis, updated_millis, updated_seconds * 1000]
                .into_iter()
                .find(|stamp| *stamp > 0)
                .unwrap_or(0),
            created_at: if created_millis > 0 {
                created_millis
            } else {
                created_seconds * 1000
            },
            model: row.get::<_, Option<String>>(6).ok()?.unwrap_or_default(),
            path: row.get(1).ok()?,
            ..Default::default()
        });
        if found.len() >= MAX_RESULTS {
            break;
        }
    }
    Some(found)
}

/// Thread names Codex keeps in one flat index, keyed by thread id.
fn codex_thread_names(home: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    let Ok(file) = File::open(home.join(".codex/session_index.jsonl")) else {
        return names;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (Some(id), Some(name)) = (
            record.get("id").and_then(Value::as_str),
            record.get("thread_name").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !name.trim().is_empty() {
            names.insert(id.to_string(), clean_title(name));
        }
    }
    names
}

/// Every `rollout-*.jsonl` under `~/.codex/sessions/YYYY/MM/DD`, newest day first.
fn codex_rollouts(root: &Path) -> Vec<PathBuf> {
    /// One level of numeric directories, largest name first.
    fn descend(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        dirs
    }

    let mut files = Vec::new();
    for year in descend(root) {
        for month in descend(&year) {
            for day in descend(&month) {
                let Ok(entries) = fs::read_dir(&day) else {
                    continue;
                };
                let mut in_day: Vec<PathBuf> = entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
                    .collect();
                in_day.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                files.extend(in_day);
                if files.len() >= MAX_SCANNED {
                    return files;
                }
            }
        }
    }
    files
}

/// Codex rollouts: the first line is a `session_meta` naming the working
/// directory, so the scan can reject a file after one line.
fn codex_rollout_sessions(home: &Path, cwd: &Path) -> Vec<AgentSessionSummary> {
    let names = codex_thread_names(home);
    let cwd_text = cwd.to_string_lossy().to_string();
    let mut found = Vec::new();

    for path in codex_rollouts(&home.join(".codex/sessions")) {
        if found.len() >= MAX_RESULTS {
            break;
        }
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let mut lines = BufReader::new(file).lines().map_while(Result::ok);
        let Some(meta) = lines
            .next()
            .and_then(|line| serde_json::from_str::<Value>(&line).ok())
        else {
            continue;
        };
        if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = meta.get("payload").cloned().unwrap_or(Value::Null);
        let session_cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
        if !same_path(session_cwd, &cwd_text) {
            continue;
        }
        let Some(id) = payload
            .get("id")
            .or_else(|| payload.get("session_id"))
            .and_then(Value::as_str)
        else {
            continue;
        };

        let mut summary = AgentSessionSummary {
            id: id.to_string(),
            title: names.get(id).cloned().unwrap_or_default(),
            updated_at: modified_millis(&path),
            created_at: payload
                .get("timestamp")
                .and_then(Value::as_str)
                .map(parse_timestamp)
                .unwrap_or_else(|| created_millis(&path)),
            model: payload
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().to_string(),
            ..Default::default()
        };

        if summary.title.is_empty() {
            let mut fallback_title = String::new();
            // Continued rollouts can replay a large prior conversation before
            // their first real prompt. Scan complete JSONL records instead of
            // cutting the title search at a byte boundary.
            for line in lines {
                let Ok(record) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                // Codex records a turn as `response_item` / `event_msg` with a
                // `user_message` payload; both carry the text in `message`.
                let payload = record.get("payload").unwrap_or(&Value::Null);
                let is_user = payload.get("type").and_then(Value::as_str) == Some("user_message")
                    || payload.get("role").and_then(Value::as_str) == Some("user");
                if !is_user {
                    let is_assistant = payload.get("type").and_then(Value::as_str)
                        == Some("agent_message")
                        || payload.get("role").and_then(Value::as_str) == Some("assistant");
                    if is_assistant && fallback_title.is_empty() {
                        let text = payload
                            .get("message")
                            .or_else(|| payload.get("content"))
                            .map(message_text)
                            .unwrap_or_default();
                        if !text.trim().is_empty() {
                            fallback_title = clean_title(&text);
                        }
                    }
                    continue;
                }
                let text = payload
                    .get("message")
                    .or_else(|| payload.get("content"))
                    .map(message_text)
                    .unwrap_or_default();
                if is_synthetic_prompt(&text) {
                    continue;
                }
                summary.title = clean_title(&text);
                break;
            }
            if summary.title.is_empty() {
                summary.title = fallback_title;
            }
        }
        if summary.title.is_empty() {
            summary.title = "Untitled session".to_string();
        }
        found.push(summary);
    }
    found
}

fn codex_sessions(home: &Path, cwd: &Path) -> Vec<AgentSessionSummary> {
    codex_database_sessions(home, cwd).unwrap_or_else(|| codex_rollout_sessions(home, cwd))
}

// ----------------------------------------------------------------------- Grok

/// `~/.grok/sessions/<percent-encoded cwd>/<session-id>/summary.json`.
///
/// The folder name is the working directory the session ran in, encoded with
/// whichever separators the launching shell used — both are tried, and a full
/// scan of the sessions root is the fallback for anything else (a session
/// started from a different drive-letter case, say).
fn grok_sessions(home: &Path, cwd: &Path) -> Vec<AgentSessionSummary> {
    let root = home.join(".grok/sessions");
    let cwd_text = cwd.to_string_lossy().to_string();

    let mut project_dirs: Vec<PathBuf> = [
        percent_encode(&cwd_text.replace('/', "\\")),
        percent_encode(&cwd_text.replace('\\', "/")),
    ]
    .iter()
    .map(|name| root.join(name))
    .filter(|dir| dir.is_dir())
    .collect();
    project_dirs.dedup();

    if project_dirs.is_empty() {
        let Ok(entries) = fs::read_dir(&root) else {
            return Vec::new();
        };
        project_dirs = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
    }

    // One prompt-history file per project, so a session with no summary line
    // can still be labelled with what the user actually asked for.
    let mut first_prompts: HashMap<String, String> = HashMap::new();
    for dir in &project_dirs {
        let Ok(file) = File::open(dir.join("prompt_history.jsonl")) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let (Some(id), Some(prompt)) = (
                record.get("session_id").and_then(Value::as_str),
                record.get("prompt").and_then(Value::as_str),
            ) else {
                continue;
            };
            if is_synthetic_prompt(prompt) {
                continue;
            }
            first_prompts
                .entry(id.to_string())
                .or_insert_with(|| clean_title(prompt));
        }
    }

    let mut found = Vec::new();
    for dir in project_dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let summary_path = path.join("summary.json");
            let Ok(text) = fs::read_to_string(&summary_path) else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let info = record.get("info").cloned().unwrap_or(Value::Null);
            let session_cwd = info.get("cwd").and_then(Value::as_str).unwrap_or("");
            if !same_path(session_cwd, &cwd_text) {
                continue;
            }
            let Some(id) = info
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
            else {
                continue;
            };
            let named = record
                .get("session_summary")
                .and_then(Value::as_str)
                .map(clean_title)
                .filter(|title| !title.is_empty());
            let title = named
                .or_else(|| first_prompts.get(&id).cloned())
                .unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            found.push(AgentSessionSummary {
                id,
                title,
                updated_at: record
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .map(parse_timestamp)
                    .filter(|stamp| *stamp > 0)
                    .unwrap_or_else(|| modified_millis(&summary_path)),
                created_at: record
                    .get("created_at")
                    .and_then(Value::as_str)
                    .map(parse_timestamp)
                    .unwrap_or(0),
                message_count: record
                    .get("num_chat_messages")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32,
                model: record
                    .get("current_model_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    found
}

// ------------------------------------------------------------------- OpenCode

/// `<data>/opencode/storage/session/<project>/ses_*.json` — one small record
/// per session, already carrying the directory, title, and timestamps.
fn opencode_sessions(home: &Path, cwd: &Path) -> Vec<AgentSessionSummary> {
    let cwd_text = cwd.to_string_lossy().to_string();
    let roots = [
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share")),
        home.join(".local/share"),
    ];

    let mut found = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for root in roots {
        let sessions = root.join("opencode/storage/session");
        if seen.contains(&sessions) {
            continue;
        }
        seen.push(sessions.clone());
        let Ok(projects) = fs::read_dir(&sessions) else {
            continue;
        };
        for project in projects.flatten() {
            let Ok(entries) = fs::read_dir(project.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().is_some_and(|ext| ext == "json") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(record) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let directory = record
                    .get("directory")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !same_path(directory, &cwd_text) {
                    continue;
                }
                let Some(id) = record.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let title = record
                    .get("title")
                    .and_then(Value::as_str)
                    .map(clean_title)
                    .filter(|title| !title.is_empty())
                    .or_else(|| {
                        record
                            .get("slug")
                            .and_then(Value::as_str)
                            .map(|slug| slug.replace('-', " "))
                    })
                    .unwrap_or_default();
                if title.is_empty() {
                    continue;
                }
                let time = record.get("time").cloned().unwrap_or(Value::Null);
                found.push(AgentSessionSummary {
                    id: id.to_string(),
                    title,
                    updated_at: time
                        .get("updated")
                        .and_then(Value::as_i64)
                        .unwrap_or_else(|| modified_millis(&path)),
                    created_at: time.get("created").and_then(Value::as_i64).unwrap_or(0),
                    path: path.to_string_lossy().to_string(),
                    ..Default::default()
                });
            }
        }
    }
    found
}

// --------------------------------------------------------------------- Cursor

/// Cursor Agent keeps its chats in a SQLite store whose schema it does not
/// publish, and its ACP mode exposes no listing. Returning nothing is the
/// honest answer; the picker says so rather than pretending the folder is new.
fn cursor_sessions(_home: &Path, _cwd: &Path) -> Vec<AgentSessionSummary> {
    Vec::new()
}

/// Resumable sessions `agent` recorded for `cwd`, newest first.
pub fn list(agent: &str, cwd: &str) -> Result<Vec<AgentSessionSummary>, String> {
    let Some(home) = home_dir() else {
        return Err("no home directory".into());
    };
    let path = Path::new(cwd);
    let mut sessions = match agent {
        "claude" => claude_sessions(&home, path),
        "codex" => codex_sessions(&home, path),
        "grok" => grok_sessions(&home, path),
        "opencode" => opencode_sessions(&home, path),
        "cursor" => cursor_sessions(&home, path),
        other => return Err(format!("unknown agent `{other}`")),
    };
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    sessions.truncate(MAX_RESULTS);
    Ok(sessions)
}

/// Visible history for a selected conversation.
///
/// ACP agents replay their own history and Codex returns turns in
/// `thread/resume`. Claude is the only provider that needs an on-disk fallback.
pub fn transcript(
    agent: &str,
    cwd: &str,
    session_id: &str,
) -> Result<Vec<AgentTranscriptItem>, String> {
    if agent != "claude" {
        return Ok(Vec::new());
    }
    let selected = list(agent, cwd)?
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| "the selected session is no longer available".to_string())?;
    claude_transcript(Path::new(&selected.path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("duckweed-sessions-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(path).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
    }

    #[test]
    fn claude_slug_mangles_every_separator() {
        assert_eq!(
            claude_project_slug(Path::new(r"H:\Python\Slop\duckweed")),
            "H--Python-Slop-duckweed"
        );
    }

    #[test]
    fn claude_task_management_tools_restore_as_todo_activity() {
        for name in ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] {
            assert_eq!(claude_tool_kind(name), "todo");
        }
    }

    #[test]
    fn percent_encoding_matches_grok_folder_names() {
        assert_eq!(
            percent_encode(r"H:\Python\Slop\duckweed"),
            "H%3A%5CPython%5CSlop%5Cduckweed"
        );
        assert_eq!(percent_encode("a b"), "a%20b");
    }

    #[cfg(windows)]
    #[test]
    fn paths_compare_across_separators_and_case() {
        assert!(same_path(
            r"H:\Python\Slop\duckweed",
            "h:/python/slop/duckweed"
        ));
        assert!(same_path(
            r"H:\Python\Slop\duckweed\",
            r"H:\Python\Slop\duckweed"
        ));
        assert!(same_path(
            r"\\?\H:\Python\Slop\duckweed",
            r"H:\Python\Slop\duckweed"
        ));
        assert!(same_path(
            r"\\?\UNC\server\share\project",
            r"\\server\share\project"
        ));
        assert!(!same_path("", ""));
        assert!(!same_path(r"H:\Python", r"H:\Python\Slop"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_paths_preserve_case_and_separator_meaning() {
        assert!(same_path("/work/Foo", "/work/Foo/"));
        assert!(!same_path("/work/Foo", "/work/foo"));
        assert!(!same_path("/work/Foo", r"\work\Foo"));
        assert!(!same_path("", ""));
    }

    #[test]
    fn synthetic_prompts_never_become_titles() {
        assert!(is_synthetic_prompt("<command-name>/effort</command-name>"));
        assert!(is_synthetic_prompt("<recommended_plugins> Here is a list"));
        assert!(is_synthetic_prompt(
            "# AGENTS.md instructions for H:\\Python"
        ));
        assert!(is_synthetic_prompt("   "));
        assert!(!is_synthetic_prompt("Fix the failing test"));
        // A prompt that merely mentions a comparison is not a wrapper.
        assert!(!is_synthetic_prompt(
            "<- why does this arrow break the parser"
        ));
    }

    #[test]
    fn claude_listing_reads_id_from_the_filename_and_title_from_the_first_prompt() {
        let home = temp_dir("claude");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let file = home
            .join(".claude/projects/H--Python-Slop-duckweed")
            .join("abc-123.jsonl");
        write(
            &file,
            concat!(
                r#"{"type":"mode","mode":"normal"}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-27T11:03:04.392Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-07-27T11:04:04.392Z","message":{"role":"user","content":"Fix   the failing test"}}"#,
                "\n",
            ),
        );

        let found = claude_sessions(&home, cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "abc-123");
        assert_eq!(found[0].title, "Fix the failing test");
    }

    #[test]
    fn claude_listing_prefers_the_written_summary() {
        let home = temp_dir("claude-summary");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        write(
            &home
                .join(".claude/projects/H--Python-Slop-duckweed")
                .join("s1.jsonl"),
            concat!(
                r#"{"type":"summary","summary":"Agent resume UI"}"#,
                "\n",
                r#"{"type":"user","message":{"role":"user","content":"whatever"}}"#,
                "\n",
            ),
        );
        let found = claude_sessions(&home, cwd);
        assert_eq!(found[0].title, "Agent resume UI");
    }

    #[test]
    fn claude_transcript_restores_visible_turns_and_tool_results() {
        let home = temp_dir("claude-transcript");
        let file = home.join("session.jsonl");
        write(
            &file,
            concat!(
                r#"{"type":"user","uuid":"u1","timestamp":"2026-07-27T11:04:04.392Z","message":{"role":"user","content":"Fix the parser"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a1","timestamp":"2026-07-27T11:04:05.392Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Inspect the entry point"},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"bun test"}}]}}"#,
                "\n",
                r#"{"type":"user","uuid":"r1","timestamp":"2026-07-27T11:04:06.392Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"12 pass"}]}]}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a2","timestamp":"2026-07-27T11:04:07.392Z","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}"#,
                "\n",
            ),
        );

        let items = claude_transcript(&file).unwrap();
        assert_eq!(items.len(), 4);
        assert!(matches!(
            &items[0],
            AgentTranscriptItem::User { text, .. } if text == "Fix the parser"
        ));
        assert!(matches!(
            &items[1],
            AgentTranscriptItem::Thinking { text, streaming, .. }
                if text == "Inspect the entry point" && !streaming
        ));
        assert!(matches!(
            &items[2],
            AgentTranscriptItem::Tool {
                call_id,
                status,
                command,
                output,
                ..
            } if call_id == "tool-1"
                && status == "done"
                && command.as_deref() == Some("bun test")
                && output == "12 pass"
        ));
        assert!(matches!(
            &items[3],
            AgentTranscriptItem::Assistant { text, streaming, .. }
                if text == "Done." && !streaming
        ));
    }

    #[test]
    fn codex_listing_keeps_only_rollouts_from_this_folder() {
        let home = temp_dir("codex");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let day = home.join(".codex/sessions/2026/07/26");
        write(
            &day.join("rollout-2026-07-26T21-46-09-mine.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"mine","cwd":"H:\\Python\\Slop\\duckweed","timestamp":"2026-07-27T00:46:09.558Z"}}"#,
                "\n",
                r#"{"payload":{"type":"user_message","message":"Ship the resume picker"}}"#,
                "\n",
            ),
        );
        write(
            &day.join("rollout-2026-07-26T20-00-00-other.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"other","cwd":"C:\\elsewhere","timestamp":"2026-07-27T00:00:00.000Z"}}"#,
                "\n",
            ),
        );
        write(
            &home.join(".codex/session_index.jsonl"),
            "{\"id\":\"mine\",\"thread_name\":\"Resume picker\"}\n",
        );

        let found = codex_sessions(&home, cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "mine");
        // The index's thread name wins over the raw first prompt.
        assert_eq!(found[0].title, "Resume picker");
    }

    #[test]
    fn codex_listing_uses_the_live_state_database_for_new_sessions() {
        use rusqlite::{params, Connection};

        let home = temp_dir("codex-state-database");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let database = home.join(".codex/state_5.sqlite");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    cwd TEXT NOT NULL,
                    title TEXT NOT NULL,
                    model TEXT,
                    created_at_ms INTEGER,
                    updated_at_ms INTEGER,
                    recency_at_ms INTEGER,
                    preview TEXT NOT NULL DEFAULT '',
                    first_user_message TEXT NOT NULL DEFAULT '',
                    name TEXT,
                    archived INTEGER NOT NULL DEFAULT 0
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (
                    id, rollout_path, created_at, updated_at, cwd, title, model,
                    created_at_ms, updated_at_ms, recency_at_ms, archived
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
                params![
                    "today",
                    r"C:\Users\test\.codex\sessions\today.jsonl",
                    100_i64,
                    200_i64,
                    r"\\?\H:\Python\Slop\duckweed",
                    "Available immediately",
                    "gpt-5.6",
                    100_001_i64,
                    200_001_i64,
                    200_002_i64,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (
                    id, rollout_path, created_at, updated_at, cwd, title, archived
                 ) VALUES ('other', 'other.jsonl', 100, 200, 'C:\\elsewhere', 'Other', 0)",
                [],
            )
            .unwrap();
        drop(connection);

        let found = codex_sessions(&home, cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "today");
        assert_eq!(found[0].title, "Available immediately");
        assert_eq!(found[0].updated_at, 200_002);
        assert_eq!(found[0].created_at, 100_001);
        assert_eq!(found[0].model, "gpt-5.6");
    }

    #[test]
    fn codex_listing_returns_more_than_the_previous_forty_row_window() {
        let home = temp_dir("codex-many-results");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let day = home.join(".codex/sessions/2026/07/26");

        for index in 0..45 {
            let contents = format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"session-{index}\",\"cwd\":\"H:\\\\Python\\\\Slop\\\\duckweed\"}}}}\n\
                 {{\"payload\":{{\"type\":\"user_message\",\"message\":\"Prompt {index}\"}}}}\n"
            );
            write(
                &day.join(format!("rollout-2026-07-26T20-00-{index:02}-session.jsonl")),
                &contents,
            );
        }

        let found = codex_sessions(&home, cwd);
        assert_eq!(found.len(), 45);
        assert!(found.iter().any(|session| session.id == "session-44"));
    }

    #[test]
    fn codex_listing_finds_a_prompt_past_the_previous_head_limit() {
        let home = temp_dir("codex-deep-prompt");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let path = home
            .join(".codex/sessions/2026/07/26")
            .join("rollout-2026-07-26T20-00-00-deep.jsonl");
        let padding = "x".repeat(HEAD_BYTES as usize + 1_024);
        let contents = [
            serde_json::json!({
                "type": "session_meta",
                "payload": { "id": "deep", "cwd": r"H:\Python\Slop\duckweed" }
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "developer", "content": padding }
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": { "type": "message", "role": "user", "content": "Recover this old session" }
            })
            .to_string(),
        ]
        .join("\n");
        write(&path, &contents);

        let found = codex_sessions(&home, cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Recover this old session");
    }

    #[test]
    fn codex_listing_keeps_sessions_without_a_normal_user_prompt() {
        let home = temp_dir("codex-title-fallback");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let day = home.join(".codex/sessions/2026/07/26");
        write(
            &day.join("rollout-2026-07-26T20-00-01-agent.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"agent-only","cwd":"H:\\Python\\Slop\\duckweed"}}"#,
                "\n",
                r#"{"payload":{"type":"agent_message","message":"Inspect the history parser"}}"#,
                "\n",
            ),
        );
        write(
            &day.join("rollout-2026-07-26T20-00-00-empty.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"empty","cwd":"H:\\Python\\Slop\\duckweed"}}"#,
                "\n",
            ),
        );

        let found = codex_sessions(&home, cwd);
        assert_eq!(found.len(), 2);
        assert_eq!(
            found
                .iter()
                .find(|session| session.id == "agent-only")
                .map(|session| session.title.as_str()),
            Some("Inspect the history parser")
        );
        assert_eq!(
            found
                .iter()
                .find(|session| session.id == "empty")
                .map(|session| session.title.as_str()),
            Some("Untitled session")
        );
    }

    #[test]
    fn grok_listing_reads_the_percent_encoded_project_folder() {
        let home = temp_dir("grok");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let project = home
            .join(".grok/sessions")
            .join("H%3A%5CPython%5CSlop%5Cduckweed");
        write(
            &project.join("s-1/summary.json"),
            r#"{"info":{"id":"s-1","cwd":"H:\\Python\\Slop\\duckweed"},"session_summary":"","created_at":"2026-07-27T11:07:21.294Z","updated_at":"2026-07-27T11:09:21.294Z","num_chat_messages":4,"current_model_id":"grok-4.5"}"#,
        );
        write(
            &project.join("prompt_history.jsonl"),
            "{\"session_id\":\"s-1\",\"prompt\":\"Add the session picker\"}\n",
        );

        let found = grok_sessions(&home, cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Add the session picker");
        assert_eq!(found[0].message_count, 4);
        assert_eq!(found[0].model, "grok-4.5");
    }

    #[test]
    fn opencode_listing_filters_on_the_recorded_directory() {
        let home = temp_dir("opencode");
        let cwd = Path::new(r"H:\Python\Slop\duckweed");
        let store = home.join(".local/share/opencode/storage/session/global");
        write(
            &store.join("ses_mine.json"),
            r#"{"id":"ses_mine","directory":"H:\\Python\\Slop\\duckweed","title":"Wire the picker","time":{"created":1770727777697,"updated":1770727895431}}"#,
        );
        write(
            &store.join("ses_other.json"),
            r#"{"id":"ses_other","directory":"C:\\elsewhere","title":"Not this one","time":{"created":1,"updated":2}}"#,
        );

        let found = opencode_sessions(&home, cwd);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "ses_mine");
        assert_eq!(found[0].updated_at, 1770727895431);
    }

    #[test]
    fn unknown_agents_are_rejected_rather_than_silently_empty() {
        assert!(list("gemini", r"H:\Python").is_err());
    }
}
