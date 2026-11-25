//! Claude Code's own on-disk record of its background agents.
//!
//! Claude reports a background agent's end through a `<task-notification>`
//! frame. That frame is the only live signal, and it can be lost: the frame is
//! dropped, the agent's sidecar is corrupted by a crash, or the CLI never learns
//! the agent ended. The UI then shows a finished agent as working forever.
//!
//! Claude also keeps durable state for every agent of a session under
//! `<projects>/<slug>/<session>/subagents/`:
//!
//! - `agent-<id>.meta.json` gains `"finished": true` when a run ends (completed,
//!   failed or killed) and loses it again when the agent is revived.
//! - `agent-<id>.jsonl` is the agent's transcript. A final assistant message
//!   with `stop_reason: end_turn` and no tool call means its turn ended.
//!
//! This module only reads those files. The adapter decides what they mean.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::agent_sessions::home_dir;

/// Enough of the tail to hold the last few transcript records.
const TAIL_BYTES: u64 = 512 * 1024;
const MAX_FINAL_TEXT: usize = 20_000;
const MAX_AGENTS: usize = 64;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSubagentSnapshot {
    pub agent_id: String,
    /// Either file exists for this agent.
    pub found: bool,
    /// The sidecar parsed. A crash can leave it empty or full of NUL bytes.
    pub meta_readable: bool,
    pub finished: bool,
    pub stopped_by_user: bool,
    /// Newest modification time of the sidecar or transcript, in ms.
    pub updated_at: i64,
    /// The transcript's last record is a final answer, not a tool call or request.
    pub transcript_ended: bool,
    pub final_text: Option<String>,
}

/// Claude names a project folder by replacing every non-alphanumeric character.
fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|char| if char.is_alphanumeric() { char } else { '-' })
        .collect()
}

/// Ids come from the CLI, but they still become path components.
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
}

fn modified_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn project_roots(config_dir: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let configured = config_dir
        .map(str::to_string)
        .filter(|dir| !dir.trim().is_empty())
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .filter(|dir| !dir.trim().is_empty());
    if let Some(dir) = configured {
        roots.push(PathBuf::from(dir).join("projects"));
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".claude/projects"));
        roots.push(home.join(".config/claude/projects"));
    }
    roots
}

/// The session's `subagents` folder. The slug is tried first; a session that
/// was resumed from another folder is found by scanning the project roots.
fn subagents_dir(roots: &[PathBuf], cwd: &str, session_id: &str) -> Option<PathBuf> {
    let slug = project_slug(cwd);
    for root in roots {
        let candidate = root.join(&slug).join(session_id).join("subagents");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join(session_id).join("subagents");
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

/// `None` when the sidecar is missing, empty, zeroed, or not JSON.
fn read_meta(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    let text: String = String::from_utf8_lossy(&bytes)
        .chars()
        .filter(|char| *char != '\0')
        .collect();
    let value = serde_json::from_str::<Value>(text.trim()).ok()?;
    value.is_object().then_some(value)
}

fn tail_lines(path: &Path) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = length.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    // The first line of a mid-file read is almost always partial.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

fn assistant_text(record: &Value) -> String {
    record
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn has_tool_use(record: &Value) -> bool {
    record
        .pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        })
}

fn bounded(text: &str) -> String {
    if text.chars().count() <= MAX_FINAL_TEXT {
        return text.to_string();
    }
    text.chars().take(MAX_FINAL_TEXT).collect()
}

/// Whether the transcript ends in a final answer, and that answer's text.
///
/// One API message can be written as several records (thinking, then text),
/// all carrying the same message id, so the text is collected across them.
fn transcript_ending(lines: &[String]) -> (bool, Option<String>) {
    let mut ended_message: Option<String> = None;
    let mut texts: Vec<String> = Vec::new();
    for line in lines.iter().rev() {
        let cleaned: String = line.chars().filter(|char| *char != '\0').collect();
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(cleaned) else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "assistant" => {
                let message_id = record
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(ended) = &ended_message {
                    if *ended != message_id {
                        break;
                    }
                    let text = assistant_text(&record);
                    if !text.trim().is_empty() {
                        texts.push(text);
                    }
                    continue;
                }
                let stop = record
                    .pointer("/message/stop_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if has_tool_use(&record) || !matches!(stop, "end_turn" | "stop_sequence") {
                    return (false, None);
                }
                let text = assistant_text(&record);
                if !text.trim().is_empty() {
                    texts.push(text);
                }
                ended_message = Some(message_id);
            }
            // A tool result, a new prompt, or a request in flight: still going.
            "user" | "api-request" => {
                if ended_message.is_some() {
                    break;
                }
                return (false, None);
            }
            _ => {}
        }
    }
    if ended_message.is_none() {
        return (false, None);
    }
    texts.reverse();
    let text = texts.join("\n").trim().to_string();
    (true, (!text.is_empty()).then(|| bounded(&text)))
}

fn snapshot(dir: &Path, agent_id: &str) -> ClaudeSubagentSnapshot {
    let meta_path = dir.join(format!("agent-{agent_id}.meta.json"));
    let transcript_path = dir.join(format!("agent-{agent_id}.jsonl"));
    let found = meta_path.is_file() || transcript_path.is_file();
    let meta = read_meta(&meta_path);
    let flag = |key: &str| {
        meta.as_ref()
            .and_then(|meta| meta.get(key))
            .and_then(Value::as_bool)
            == Some(true)
    };
    let (transcript_ended, final_text) = if transcript_path.is_file() {
        transcript_ending(&tail_lines(&transcript_path))
    } else {
        (false, None)
    };
    ClaudeSubagentSnapshot {
        agent_id: agent_id.to_string(),
        found,
        meta_readable: meta.is_some(),
        finished: flag("finished"),
        stopped_by_user: flag("stoppedByUser"),
        updated_at: modified_millis(&meta_path).max(modified_millis(&transcript_path)),
        transcript_ended,
        final_text,
    }
}

pub fn subagents(
    cwd: &str,
    session_id: &str,
    agent_ids: &[String],
    config_dir: Option<&str>,
) -> Result<Vec<ClaudeSubagentSnapshot>, String> {
    if !safe_component(session_id) {
        return Err("invalid Claude session id".into());
    }
    let Some(dir) = subagents_dir(&project_roots(config_dir), cwd, session_id) else {
        return Ok(Vec::new());
    };
    Ok(agent_ids
        .iter()
        .filter(|id| safe_component(id))
        .take(MAX_AGENTS)
        .map(|id| snapshot(&dir, id))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "duckweed-claude-subagents-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        File::create(path).unwrap().write_all(contents).unwrap();
    }

    fn session_dir(root: &Path, cwd: &str, session: &str) -> PathBuf {
        root.join("projects")
            .join(project_slug(cwd))
            .join(session)
            .join("subagents")
    }

    #[test]
    fn a_final_answer_after_tool_calls_ends_the_transcript() {
        let lines = [
            r#"{"type":"assistant","message":{"id":"m1","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            r#"{"type":"api-request","id":"r1"}"#,
            r#"{"type":"assistant","message":{"id":"m2","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"done"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m2","stop_reason":"end_turn","content":[{"type":"text","text":"All 24 segments delivered."}]}}"#,
            "",
        ]
        .map(str::to_string);
        assert_eq!(
            transcript_ending(&lines),
            (true, Some("All 24 segments delivered.".to_string()))
        );
    }

    #[test]
    fn a_request_in_flight_or_tool_call_is_still_working() {
        let in_flight = [
            r#"{"type":"assistant","message":{"id":"m2","stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}"#,
            r#"{"type":"user","message":{"content":"The coordinator sent a message while you were working"}}"#,
            r#"{"type":"api-request","id":"r2"}"#,
        ]
        .map(str::to_string);
        assert_eq!(transcript_ending(&in_flight), (false, None));

        let tool_call = [
            r#"{"type":"assistant","message":{"id":"m3","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}}"#,
        ]
        .map(str::to_string);
        assert_eq!(transcript_ending(&tool_call), (false, None));
    }

    #[test]
    fn reads_finished_sidecars_and_tolerates_zeroed_ones() {
        let root = temp_dir("meta");
        let cwd = r"H:\Projects\video";
        let dir = session_dir(&root, cwd, "s1");
        write(
            &dir.join("agent-a1.meta.json"),
            br#"{"agentType":"general-purpose","finished":true}"#,
        );
        write(
            &dir.join("agent-a1.jsonl"),
            br#"{"type":"assistant","message":{"id":"m","stop_reason":"end_turn","content":[{"type":"text","text":"Report"}]}}
"#,
        );
        // A crash mid-write leaves the sidecar as NUL bytes.
        write(&dir.join("agent-a2.meta.json"), &[0u8; 274]);
        write(
            &dir.join("agent-a2.jsonl"),
            br#"{"type":"api-request","id":"r"}
"#,
        );
        write(
            &dir.join("agent-a3.meta.json"),
            br#"{"agentType":"general-purpose","revivedAt":1}"#,
        );

        let ids = ["a1", "a2", "a3", "missing", "../escape"].map(str::to_string);
        let found = subagents(cwd, "s1", &ids, Some(root.to_str().unwrap())).unwrap();
        assert_eq!(found.len(), 4);

        assert!(found[0].found && found[0].meta_readable && found[0].finished);
        assert!(found[0].transcript_ended);
        assert_eq!(found[0].final_text.as_deref(), Some("Report"));

        assert!(found[1].found && !found[1].meta_readable && !found[1].finished);
        assert!(!found[1].transcript_ended);

        assert!(found[2].meta_readable && !found[2].finished);
        assert!(!found[3].found);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_a_session_resumed_from_another_folder() {
        let root = temp_dir("moved");
        let dir = session_dir(&root, r"H:\Elsewhere", "s2");
        write(&dir.join("agent-b1.meta.json"), br#"{"finished":true}"#);
        let found = subagents(
            r"H:\Projects\video",
            "s2",
            &["b1".to_string()],
            Some(root.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].finished);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(subagents("H:\\x", "../s", &[], None).is_err());
    }
}
