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
//! title, and when it was last touched. Transcripts run to megabytes, so the
//! head of a file is read and the rest is skipped.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Rows returned to the picker. More than this is scrolling, not choosing.
const MAX_RESULTS: usize = 40;
/// Transcripts to open per agent before giving up — a hard ceiling on the cost
/// of a listing, since Codex partitions by date rather than by project and a
/// busy month is thousands of files.
const MAX_SCANNED: usize = 600;
/// Bytes read from the head of a transcript while looking for its first prompt.
/// Codex prepends its whole system prompt, which is ~40 KB on its own.
const HEAD_BYTES: u64 = 256 * 1024;
/// Longest title kept; the picker truncates visually, this bounds the payload.
const MAX_TITLE: usize = 160;

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

/// Windows paths reach us in both separator flavours and either case; compare
/// them the way the shell does rather than byte for byte.
fn same_path(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    !left.is_empty() && normalize(left) == normalize(right)
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
fn codex_sessions(home: &Path, cwd: &Path) -> Vec<AgentSessionSummary> {
    let names = codex_thread_names(home);
    let cwd_text = cwd.to_string_lossy().to_string();
    let mut found = Vec::new();

    for path in codex_rollouts(&home.join(".codex/sessions")) {
        if found.len() >= MAX_RESULTS {
            break;
        }
        let Some(head) = read_head(&path) else {
            continue;
        };
        let mut lines = head.lines();
        let Some(meta) = lines
            .next()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
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
            for line in lines {
                let Ok(record) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                // Codex records a turn as `response_item` / `event_msg` with a
                // `user_message` payload; both carry the text in `message`.
                let payload = record.get("payload").unwrap_or(&Value::Null);
                let is_user = payload.get("type").and_then(Value::as_str) == Some("user_message")
                    || payload.get("role").and_then(Value::as_str) == Some("user");
                if !is_user {
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
        }
        if summary.title.is_empty() {
            continue;
        }
        found.push(summary);
    }
    found
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
    fn percent_encoding_matches_grok_folder_names() {
        assert_eq!(
            percent_encode(r"H:\Python\Slop\duckweed"),
            "H%3A%5CPython%5CSlop%5Cduckweed"
        );
        assert_eq!(percent_encode("a b"), "a%20b");
    }

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
        assert!(!same_path("", ""));
        assert!(!same_path(r"H:\Python", r"H:\Python\Slop"));
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
