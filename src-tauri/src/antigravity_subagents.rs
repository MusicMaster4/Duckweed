use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{collections::HashSet, path::Path};
use uuid::Uuid;

// The AGY SQLite store uses CortexStep/StepMetadata protobufs. Read only the
// fields that associate an ACP tool call with a child and its visible output.
const PLANNER_RESPONSE: i64 = 15;
const SYSTEM_MESSAGE: i64 = 101;
const GENERIC_TOOL: i64 = 132;
const MAX_OUTPUT_CHARS: usize = 32_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentUpdate {
    call_id: String,
    thread_id: String,
    status: &'static str,
    tool_name: Option<String>,
    output: Option<String>,
}

fn read_varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut value = 0;
    for shift in (0..=63).step_by(7) {
        let (&byte, rest) = bytes.split_first()?;
        *bytes = rest;
        if shift == 63 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some(value);
        }
    }
    None
}

fn read_bytes<'a>(mut bytes: &'a [u8], field: u64) -> Option<&'a [u8]> {
    while !bytes.is_empty() {
        let tag = read_varint(&mut bytes)?;
        let length = match tag & 7 {
            0 => {
                read_varint(&mut bytes)?;
                continue;
            }
            1 => 8,
            2 => usize::try_from(read_varint(&mut bytes)?).ok()?,
            5 => 4,
            _ => return None,
        };
        let value = bytes.get(..length)?;
        if tag & 7 == 2 && tag >> 3 == field {
            return Some(value);
        }
        bytes = &bytes[length..];
    }
    None
}

fn proto_path<'a>(bytes: &'a [u8], fields: &[u64]) -> Option<&'a [u8]> {
    fields
        .iter()
        .try_fold(bytes, |value, &field| read_bytes(value, field))
}

fn proto_text<'a>(bytes: &'a [u8], fields: &[u64]) -> Option<&'a str> {
    let text = std::str::from_utf8(proto_path(bytes, fields)?).ok()?.trim();
    (!text.is_empty()).then_some(text)
}

fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = Connection::open_with_flags(path, flags)?;
    db.busy_timeout(std::time::Duration::from_millis(250))?;
    Ok(db)
}

fn bounded_output(text: &str) -> String {
    text.chars().take(MAX_OUTPUT_CHARS).collect()
}

fn child_activity(root: &Path, id: &str, status: &str) -> (Option<String>, Option<String>) {
    let read = || -> rusqlite::Result<_> {
        let db = open_db(&root.join("conversations").join(format!("{id}.db")))?;
        let mut stmt = db.prepare(
            "SELECT step_type, metadata, step_payload FROM steps
             WHERE step_type IN (?1, ?2) ORDER BY idx DESC LIMIT 12",
        )?;
        let mut rows = stmt.query([PLANNER_RESPONSE, GENERIC_TOOL])?;
        let mut tool_name = None;
        let mut output = None;
        while let Some(row) = rows.next()? {
            let kind = row.get::<_, i64>(0)?;
            if status == "running" {
                // New planner work supersedes the last tool call.
                if kind == GENERIC_TOOL {
                    let metadata: Option<Vec<u8>> = row.get(1)?;
                    tool_name = metadata
                        .as_deref()
                        .and_then(|data| proto_text(data, &[4, 2]))
                        .map(str::to_owned);
                }
                break;
            }
            if kind == PLANNER_RESPONSE {
                let payload: Option<Vec<u8>> = row.get(2)?;
                if let Some(text) = payload
                    .as_deref()
                    .and_then(|data| proto_text(data, &[20, 1]))
                {
                    output = Some(bounded_output(text));
                    break;
                }
            }
        }
        Ok((tool_name, output))
    };
    read().unwrap_or_default()
}

fn read_updates(
    root: &Path,
    parent_id: &str,
    call_ids: &[String],
) -> rusqlite::Result<Vec<SubagentUpdate>> {
    let requested: HashSet<&str> = call_ids.iter().map(String::as_str).collect();
    let parent = open_db(&root.join("conversations").join(format!("{parent_id}.db")))?;
    let index = open_db(&root.join("conversation_summaries.db"))?;
    let mut calls = parent.prepare(
        "SELECT idx, metadata, step_payload FROM steps
         WHERE step_type = ?1 AND instr(metadata, 'invoke_subagent') > 0 ORDER BY idx",
    )?;
    let mut calls = calls.query([GENERIC_TOOL])?;
    let mut child_state = index.prepare(
        "SELECT status, not_fully_idle, killed, step_count FROM conversation_summaries
         WHERE conversation_id = ?1 AND parent_conversation_id = ?2",
    )?;
    let mut messages = parent.prepare(
        "SELECT step_payload FROM steps
         WHERE step_type = ?1 AND idx > ?2 AND instr(step_payload, ?3) > 0 ORDER BY idx DESC",
    )?;
    let mut updates = Vec::new();
    while let Some(row) = calls.next()? {
        let metadata: Vec<u8> = row.get(1)?;
        let Some(call_id) = proto_text(&metadata, &[4, 1]) else {
            continue;
        };
        if !requested.contains(call_id) || proto_text(&metadata, &[4, 2]) != Some("invoke_subagent")
        {
            continue;
        }
        let payload: Option<Vec<u8>> = row.get(2)?;
        // Generic tool response > Any > InvokeSubagent response > conversation ID.
        let Some(result) = payload
            .as_deref()
            .and_then(|data| proto_path(data, &[140, 2, 6]))
        else {
            continue;
        };
        if proto_text(result, &[1])
            != Some("type.googleapis.com/exa.cortex.core.tools.InvokeSubagent")
        {
            continue;
        }
        let Some(id) = proto_text(result, &[2, 2, 1]).and_then(|id| Uuid::parse_str(id).ok())
        else {
            continue;
        };
        let id = id.to_string();
        let mut states = child_state.query([&id, parent_id])?;
        let Some(state) = states.next()? else {
            continue;
        };
        let raw_status = state.get::<_, String>(0)?;
        let not_fully_idle: bool = state.get(1)?;
        let killed: bool = state.get(2)?;
        let steps: i64 = state.get(3)?;
        let mut received = messages.query(rusqlite::params![
            SYSTEM_MESSAGE,
            row.get::<_, i64>(0)?,
            &id
        ])?;
        let mut output = None;
        while let Some(message) = received.next()? {
            let data: Option<Vec<u8>> = message.get(0)?;
            let Some(message) = data.as_deref().and_then(|data| proto_path(data, &[114, 4])) else {
                continue;
            };
            if proto_text(message, &[2]) == Some(parent_id)
                && proto_text(message, &[3]) == Some(&id)
            {
                if let Some(text) = proto_text(message, &[4]) {
                    output = Some(bounded_output(text));
                    break;
                }
            }
        }
        let status = match (raw_status.as_str(), not_fully_idle, killed, steps) {
            (_, _, true, _)
            | (
                "CASCADE_RUN_STATUS_ERROR"
                | "CASCADE_RUN_STATUS_FAILED"
                | "CASCADE_RUN_STATUS_CANCELED"
                | "CASCADE_RUN_STATUS_CANCELLED",
                _,
                _,
                _,
            ) => "error",
            (_, true, _, _)
            | (
                "CASCADE_RUN_STATUS_RUNNING"
                | "CASCADE_RUN_STATUS_BUSY"
                | "CASCADE_RUN_STATUS_CANCELING"
                | "CASCADE_RUN_STATUS_WAITING_FOR_USER",
                _,
                _,
                _,
            ) => "running",
            ("CASCADE_RUN_STATUS_IDLE", false, false, steps) if steps > 1 || output.is_some() => {
                "done"
            }
            ("CASCADE_RUN_STATUS_IDLE", false, false, _) => "pending",
            ("", false, false, _) if output.is_some() => "done",
            ("", false, false, _) => "pending",
            _ => continue,
        };
        let (tool_name, child_output) = child_activity(root, &id, status);
        updates.push(SubagentUpdate {
            call_id: call_id.to_owned(),
            thread_id: id,
            status,
            tool_name,
            output: output.or(child_output),
        });
    }
    Ok(updates)
}

pub fn subagents(parent_id: &str, call_ids: &[String]) -> rusqlite::Result<Vec<SubagentUpdate>> {
    let Ok(id) = Uuid::parse_str(parent_id) else {
        return Ok(Vec::new());
    };
    let Some(home) = crate::agent_sessions::home_dir() else {
        return Ok(Vec::new());
    };
    read_updates(
        &home.join(".gemini/antigravity-cli"),
        &id.to_string(),
        call_ids,
    )
}
#[cfg(test)]
mod tests {
    use super::*;

    fn encode_varint(mut value: u64, bytes: &mut Vec<u8>) {
        while value >= 128 {
            bytes.push((value as u8 & 0x7f) | 0x80);
            value >>= 7;
        }
        bytes.push(value as u8);
    }

    fn field(number: u64, value: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        encode_varint(number << 3 | 2, &mut bytes);
        encode_varint(value.len() as u64, &mut bytes);
        bytes.extend(value);
        bytes
    }

    fn nested(path: &[u64], value: &[u8]) -> Vec<u8> {
        path.iter()
            .rev()
            .fold(value.to_vec(), |value, &key| field(key, &value))
    }

    #[test]
    fn antigravity_matches_parallel_calls_to_native_children_and_results() {
        let root = std::env::temp_dir().join(format!("duckweed-agy-{}", Uuid::new_v4()));
        let conversations = root.join("conversations");
        std::fs::create_dir_all(&conversations).unwrap();
        let parent = Uuid::new_v4().to_string();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let parent_db = Connection::open(conversations.join(format!("{parent}.db"))).unwrap();
        parent_db.execute_batch(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);",
        ).unwrap();
        let index = Connection::open(root.join("conversation_summaries.db")).unwrap();
        index
            .execute_batch(
                "CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT,
                status TEXT, not_fully_idle INTEGER, killed INTEGER, step_count INTEGER
            );",
            )
            .unwrap();

        // Same native tool arguments can launch different children in parallel.
        for (idx, call_id, child, output, running) in [
            (1, "call_1", &first, "270", true),
            (2, "call_10", &second, "843", false),
        ] {
            let metadata = field(
                4,
                &[field(1, call_id.as_bytes()), field(2, b"invoke_subagent")].concat(),
            );
            let result = [
                field(
                    1,
                    b"type.googleapis.com/exa.cortex.core.tools.InvokeSubagent",
                ),
                nested(&[2, 2, 1], child.as_bytes()),
            ]
            .concat();
            parent_db
                .execute(
                    "INSERT INTO steps VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![idx, GENERIC_TOOL, metadata, nested(&[140, 2, 6], &result)],
                )
                .unwrap();
            let message = [
                field(2, parent.as_bytes()),
                field(3, child.as_bytes()),
                field(4, output.as_bytes()),
            ]
            .concat();
            parent_db
                .execute(
                    "INSERT INTO steps VALUES (?1, ?2, NULL, ?3)",
                    rusqlite::params![idx + 10, SYSTEM_MESSAGE, nested(&[114, 4], &message)],
                )
                .unwrap();
            index.execute(
                "INSERT INTO conversation_summaries VALUES (?1, ?2, 'CASCADE_RUN_STATUS_IDLE', ?3, 0, 4)",
                rusqlite::params![child, parent, running],
            ).unwrap();
        }

        let calls = ["call_1".to_owned(), "call_10".to_owned()];
        let updates = read_updates(&root, &parent, &calls).unwrap();
        assert_eq!(updates.len(), 2);
        assert_eq!(
            (
                &updates[0].call_id,
                &updates[0].thread_id,
                updates[0].status,
                updates[0].output.as_deref()
            ),
            (&calls[0], &first, "running", Some("270"))
        );
        assert_eq!(
            (
                &updates[1].call_id,
                &updates[1].thread_id,
                updates[1].status,
                updates[1].output.as_deref()
            ),
            (&calls[1], &second, "done", Some("843"))
        );

        index.execute(
            "UPDATE conversation_summaries SET parent_conversation_id = '' WHERE conversation_id = ?1",
            [&second],
        ).unwrap();
        let updates = read_updates(&root, &parent, &calls).unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].thread_id, first);

        // Explicit error/cancelled/killed and 1-step reply completions settle accurately.
        index
            .execute(
                "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_FAILED', not_fully_idle = 0 WHERE conversation_id = ?1",
                [&first],
            )
            .unwrap();
        let updates = read_updates(&root, &parent, &calls).unwrap();
        assert_eq!(updates[0].status, "error");

        index
            .execute(
                "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0, step_count = 1 WHERE conversation_id = ?1",
                [&first],
            )
            .unwrap();
        let updates = read_updates(&root, &parent, &calls).unwrap();
        assert_eq!(updates[0].status, "done");

        drop((index, parent_db));
        std::fs::remove_file(conversations.join(format!("{parent}.db"))).unwrap();
        std::fs::remove_file(root.join("conversation_summaries.db")).unwrap();
        std::fs::remove_dir(conversations).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
