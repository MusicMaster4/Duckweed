//! Turn-completion detection for persistent coding-agent CLIs.
//!
//! A normal command leaves the shell process tree when it finishes. Codex,
//! Claude Code, and other coding agents stay alive and wait for another prompt,
//! so process-tree idleness cannot describe a completed turn. Codex, Claude,
//! and Grok expose durable session records; hook-capable agents use a tiny
//! app-owned bridge that records only the terminal id and agent kind.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_millis(350);
const DISCOVERY_POLL: Duration = Duration::from_secs(2);
const START_TOLERANCE: Duration = Duration::from_secs(3);
const LOG_AGENTS: &[&str] = &["codex", "claude", "grok"];
const SUPPORTED_AGENTS: &[&str] = &[
    "codex",
    "claude",
    "grok",
    "opencode",
    "gemini",
    "antigravity",
    "qwen",
    "copilot",
    "aider",
];

struct Watch {
    agent: String,
    cwd: PathBuf,
    started: SystemTime,
    next_discovery: Instant,
    file: Option<PathBuf>,
    offset: u64,
}

struct SessionCandidate {
    path: PathBuf,
    modified: SystemTime,
    created: Option<SystemTime>,
}

struct HookEvents {
    path: PathBuf,
    offset: u64,
}

#[derive(Default)]
pub struct AgentActivityManager {
    watches: Mutex<HashMap<String, Watch>>,
    hook_events: Mutex<Option<HookEvents>>,
}

#[derive(Clone, Serialize)]
struct CompletionPayload {
    id: String,
    agent: String,
}

impl AgentActivityManager {
    pub fn watch(&self, id: String, agent: String, cwd: String) {
        if !SUPPORTED_AGENTS.contains(&agent.as_str()) {
            return;
        }
        let mut watches = self.watches.lock().unwrap();
        if watches
            .get(&id)
            .is_some_and(|watch| watch.agent == agent && watch.cwd == Path::new(&cwd))
        {
            return;
        }
        watches.insert(
            id,
            Watch {
                agent,
                cwd: PathBuf::from(cwd),
                started: SystemTime::now(),
                next_discovery: Instant::now(),
                file: None,
                offset: 0,
            },
        );
    }

    pub fn unwatch(&self, id: &str) {
        self.watches.lock().unwrap().remove(id);
    }

    fn poll(&self, app: &AppHandle) {
        let mut watches = self.watches.lock().unwrap();
        let mut claimed: HashSet<PathBuf> = watches
            .values()
            .filter_map(|watch| watch.file.clone())
            .collect();

        for (id, watch) in watches.iter_mut() {
            if watch.file.is_none() {
                if !LOG_AGENTS.contains(&watch.agent.as_str()) {
                    continue;
                }
                if Instant::now() < watch.next_discovery {
                    continue;
                }
                watch.next_discovery = Instant::now() + DISCOVERY_POLL;
                let Some(path) = discover_session(watch, &claimed) else {
                    continue;
                };
                watch.offset = fs::metadata(&path)
                    .map(|meta| {
                        let new_session = meta.created().ok().is_some_and(|created| {
                            created
                                >= watch
                                    .started
                                    .checked_sub(START_TOLERANCE)
                                    .unwrap_or(SystemTime::UNIX_EPOCH)
                        });
                        if new_session {
                            0
                        } else {
                            meta.len()
                        }
                    })
                    .unwrap_or(0);
                claimed.insert(path.clone());
                watch.file = Some(path);
                continue;
            }

            if read_completions(watch) {
                let _ = app.emit(
                    "agent:complete",
                    CompletionPayload {
                        id: id.clone(),
                        agent: watch.agent.clone(),
                    },
                );
            }
        }
    }

    fn poll_hook_events(&self, app: &AppHandle) {
        let lines = {
            let mut state = self.hook_events.lock().unwrap();
            let Some(events) = state.as_mut() else {
                return;
            };
            read_appended_lines(&events.path, &mut events.offset)
        };
        if lines.is_empty() {
            return;
        }

        let watches = self.watches.lock().unwrap();
        for line in lines {
            let Some((id, agent)) = parse_hook_event(&line) else {
                continue;
            };
            if !watches.get(id).is_some_and(|watch| watch.agent == agent) {
                continue;
            }
            let _ = app.emit(
                "agent:complete",
                CompletionPayload {
                    id: id.to_owned(),
                    agent: agent.to_owned(),
                },
            );
        }
    }
}

pub fn start_monitor(app: AppHandle) -> Result<(), String> {
    let paths = install_integrations(&app)?;
    let offset = fs::metadata(&paths.events)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if let Some(manager) = app.try_state::<AgentActivityManager>() {
        *manager.hook_events.lock().unwrap() = Some(HookEvents {
            path: paths.events,
            offset,
        });
    }

    std::thread::Builder::new()
        .name("agent-activity-monitor".into())
        .spawn(move || loop {
            std::thread::sleep(POLL);
            if app.get_webview_window("main").is_none() {
                break;
            }
            if let Some(manager) = app.try_state::<AgentActivityManager>() {
                manager.poll_hook_events(&app);
                manager.poll(&app);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

struct IntegrationPaths {
    root: PathBuf,
    events: PathBuf,
    hook: PathBuf,
    opencode_plugin: PathBuf,
    gemini_defaults: PathBuf,
    qwen_defaults: PathBuf,
}

fn integration_paths(app: &AppHandle) -> Result<IntegrationPaths, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("agent-integrations");
    Ok(IntegrationPaths {
        events: root.join("events.log"),
        hook: root.join(if cfg!(windows) {
            "agent-complete.ps1"
        } else {
            "agent-complete.sh"
        }),
        opencode_plugin: root.join("opencode-plugin.js"),
        gemini_defaults: root.join("gemini-defaults.json"),
        qwen_defaults: root.join("qwen-defaults.json"),
        root,
    })
}

/// Environment inherited by every command launched inside one Duckweed PTY.
/// Third-party hooks remain inert outside Duckweed because these values are
/// absent in normal terminals.
pub fn terminal_env(app: &AppHandle, id: &str) -> Vec<(String, String)> {
    let Ok(paths) = integration_paths(app) else {
        return Vec::new();
    };
    let command = hook_command(&paths.hook, "aider");
    let mut env = vec![
        ("DUCKWEED_TERMINAL_ID".into(), id.into()),
        (
            "DUCKWEED_AGENT_EVENTS".into(),
            paths.events.to_string_lossy().into_owned(),
        ),
    ];
    if std::env::var_os("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").is_none() {
        env.push((
            "GEMINI_CLI_SYSTEM_DEFAULTS_PATH".into(),
            paths.gemini_defaults.to_string_lossy().into_owned(),
        ));
    }
    if std::env::var_os("QWEN_CODE_SYSTEM_DEFAULTS_PATH").is_none() {
        env.push((
            "QWEN_CODE_SYSTEM_DEFAULTS_PATH".into(),
            paths.qwen_defaults.to_string_lossy().into_owned(),
        ));
    }
    if let Some(config) = opencode_inline_config(&paths.opencode_plugin) {
        env.push(("OPENCODE_CONFIG_CONTENT".into(), config));
    }
    if std::env::var_os("AIDER_NOTIFICATIONS").is_none() {
        env.push(("AIDER_NOTIFICATIONS".into(), "true".into()));
    }
    if std::env::var_os("AIDER_NOTIFICATIONS_COMMAND").is_none() {
        env.push(("AIDER_NOTIFICATIONS_COMMAND".into(), command));
    }
    env
}

fn install_integrations(app: &AppHandle) -> Result<IntegrationPaths, String> {
    let paths = integration_paths(app)?;
    fs::create_dir_all(&paths.root).map_err(|error| error.to_string())?;
    write_hook_script(&paths.hook)?;
    install_opencode_plugin(&paths.opencode_plugin)?;
    write_json(&paths.gemini_defaults, &gemini_defaults(&paths.hook))?;
    write_json(&paths.qwen_defaults, &qwen_defaults(&paths.hook))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.events)
        .map_err(|error| error.to_string())?;

    // Each external integration owns a uniquely named file/directory and
    // checks DUCKWEED_TERMINAL_ID before doing anything. Failures here should
    // not prevent the terminal or the built-in log adapters from starting.
    if let Some(home) = home_dir() {
        if home.join(".gemini/antigravity-cli").is_dir() {
            let _ = install_antigravity_plugin(&home, &paths.hook);
        }
        if home.join(".copilot").is_dir() {
            let _ = install_copilot_hook(&home, &paths.hook);
        }
    }
    Ok(paths)
}

fn write_hook_script(path: &Path) -> Result<(), String> {
    let content = if cfg!(windows) {
        r#"param([string]$Agent)
$Payload = [Console]::In.ReadToEnd()
if ($Agent -eq "antigravity" -and $Payload) {
  try {
    $Event = $Payload | ConvertFrom-Json
    if ($Event.fullyIdle -eq $false) {
      Write-Output '{"decision":"allow"}'
      exit 0
    }
  } catch {}
}
if ($env:DUCKWEED_TERMINAL_ID -and $env:DUCKWEED_AGENT_EVENTS) {
  [IO.File]::AppendAllText(
    $env:DUCKWEED_AGENT_EVENTS,
    "$($env:DUCKWEED_TERMINAL_ID)|$Agent$([Environment]::NewLine)"
  )
}
if ($Agent -eq "qwen") {
  Write-Output '{"ok":true}'
} elseif ($Agent -eq "antigravity") {
  Write-Output '{"decision":"allow"}'
} else {
  Write-Output '{}'
}
"#
    } else {
        r#"#!/bin/sh
payload=$(cat)
if [ "$1" = "antigravity" ] && printf '%s' "$payload" | grep -Eq '"fullyIdle"[[:space:]]*:[[:space:]]*false'; then
  printf '{"decision":"allow"}\n'
  exit 0
fi
if [ -n "$DUCKWEED_TERMINAL_ID" ] && [ -n "$DUCKWEED_AGENT_EVENTS" ]; then
  printf '%s|%s\n' "$DUCKWEED_TERMINAL_ID" "$1" >> "$DUCKWEED_AGENT_EVENTS"
fi
case "$1" in
  qwen) printf '{"ok":true}\n' ;;
  antigravity) printf '{"decision":"allow"}\n' ;;
  *) printf '{}\n' ;;
esac
"#
    };
    fs::write(path, content).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn hook_command(path: &Path, agent: &str) -> String {
    let escaped = path.to_string_lossy().replace('"', "\\\"");
    if cfg!(windows) {
        format!(
            "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{escaped}\" {agent}"
        )
    } else {
        format!("\"{escaped}\" {agent}")
    }
}

fn gemini_defaults(hook: &Path) -> Value {
    json!({
        "general": {
            "enableNotifications": true,
            "notificationMethod": "osc777"
        },
        "hooks": {
            "AfterAgent": [{
                "matcher": "*",
                "hooks": [{
                    "name": "duckweed-terminal-notification",
                    "type": "command",
                    "command": hook_command(hook, "gemini"),
                    "timeout": 5
                }]
            }]
        }
    })
}

fn qwen_defaults(hook: &Path) -> Value {
    json!({
        "hooks": {
            "Stop": [{
                "hooks": [{
                    "name": "duckweed-terminal-notification",
                    "type": "command",
                    "command": hook_command(hook, "qwen"),
                    "timeout": 5
                }]
            }]
        }
    })
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn opencode_inline_config(plugin: &Path) -> Option<String> {
    let mut config = match std::env::var("OPENCODE_CONFIG_CONTENT") {
        Ok(raw) => serde_json::from_str::<Value>(&raw).ok()?,
        Err(_) => json!({}),
    };
    let object = config.as_object_mut()?;
    let plugins = object
        .entry("plugin")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()?;
    let path = Value::String(plugin.to_string_lossy().into_owned());
    if !plugins.contains(&path) {
        plugins.push(path);
    }
    serde_json::to_string(&config).ok()
}

fn install_opencode_plugin(path: &Path) -> Result<(), String> {
    let plugin = r#"// Installed by Duckweed. Inert unless OpenCode runs inside a Duckweed PTY.
import { appendFileSync } from "node:fs"

export const DuckweedTerminalNotifications = async () => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return
    const id = process.env.DUCKWEED_TERMINAL_ID
    const target = process.env.DUCKWEED_AGENT_EVENTS
    if (!id || !target) return
    appendFileSync(target, `${id}|opencode\n`, "utf8")
  },
})
"#;
    fs::write(path, plugin).map_err(|error| error.to_string())
}

fn install_antigravity_plugin(home: &Path, hook: &Path) -> Result<(), String> {
    let dir = home.join(".gemini/config/plugins/duckweed-terminal-notifications");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    write_json(
        &dir.join("plugin.json"),
        &json!({ "name": "duckweed-terminal-notifications" }),
    )?;
    write_json(
        &dir.join("hooks.json"),
        &json!({
            "duckweed-terminal-notifications": {
                "Stop": [{
                    "type": "command",
                    "command": hook_command(hook, "antigravity"),
                    "timeout": 5
                }]
            }
        }),
    )
}

fn install_copilot_hook(home: &Path, hook: &Path) -> Result<(), String> {
    let dir = home.join(".copilot/hooks");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let command = if cfg!(windows) {
        json!({
            "type": "command",
            "powershell": format!(
                "& '{}' copilot",
                hook.to_string_lossy().replace('\'', "''")
            ),
            "timeoutSec": 5
        })
    } else {
        json!({
            "type": "command",
            "bash": hook_command(hook, "copilot"),
            "timeoutSec": 5
        })
    };
    write_json(
        &dir.join("dev.slop.duckweed-terminal-notifications.json"),
        &json!({
            "version": 1,
            "hooks": {
                "agentStop": [command]
            }
        }),
    )
}

fn read_appended_lines(path: &Path, offset: &mut u64) -> Vec<Vec<u8>> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0;
    }
    if len == *offset || file.seek(SeekFrom::Start(*offset)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return Vec::new();
    };
    let complete = &bytes[..=last_newline];
    *offset += complete.len() as u64;
    complete
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(<[u8]>::to_vec)
        .collect()
}

fn parse_hook_event(line: &[u8]) -> Option<(&str, &str)> {
    let text = std::str::from_utf8(line).ok()?.trim();
    let (id, agent) = text.split_once('|')?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || !SUPPORTED_AGENTS.contains(&agent)
    {
        return None;
    }
    Some((id, agent))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn discover_session(watch: &Watch, claimed: &HashSet<PathBuf>) -> Option<PathBuf> {
    let home = home_dir()?;
    let root = match watch.agent.as_str() {
        "codex" => home.join(".codex/sessions"),
        "claude" => home.join(".claude/projects"),
        "grok" => home.join(".grok/sessions"),
        _ => return None,
    };
    let earliest = watch
        .started
        .checked_sub(START_TOLERANCE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut candidates = Vec::new();
    collect_recent(&root, &watch.agent, earliest, claimed, &mut candidates);
    let matching: Vec<&SessionCandidate> = candidates
        .iter()
        .filter(|candidate| matches_cwd(&watch.agent, &candidate.path, &watch.cwd))
        .collect();

    // A new interactive agent creates its session shortly after Duckweed starts
    // watching it. Prefer that creation-time correlation over last-modified:
    // another Codex/Claude/Grok process in the same project may be writing at
    // the same time and would otherwise steal this pane's watch.
    nearest_new_session(watch.started, earliest, &matching)
        .or_else(|| {
            matching
                .iter()
                .max_by_key(|candidate| candidate.modified)
                .copied()
        })
        .or_else(|| (candidates.len() == 1).then(|| &candidates[0]))
        .map(|candidate| candidate.path.clone())
}

fn nearest_new_session<'a>(
    started: SystemTime,
    earliest: SystemTime,
    candidates: &[&'a SessionCandidate],
) -> Option<&'a SessionCandidate> {
    candidates
        .iter()
        .filter_map(|candidate| {
            let created = candidate.created?;
            (created >= earliest).then(|| {
                let distance = created
                    .duration_since(started)
                    .or_else(|_| started.duration_since(created))
                    .unwrap_or_default();
                (*candidate, distance)
            })
        })
        .min_by_key(|(_, distance)| *distance)
        .map(|(candidate, _)| candidate)
}

fn collect_recent(
    dir: &Path,
    agent: &str,
    earliest: SystemTime,
    claimed: &HashSet<PathBuf>,
    out: &mut Vec<SessionCandidate>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_recent(&path, agent, earliest, claimed, out);
            continue;
        }
        if claimed.contains(&path) || !is_session_file(agent, &path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if modified >= earliest {
            out.push(SessionCandidate {
                path,
                modified,
                created: metadata.created().ok(),
            });
        }
    }
}

fn is_session_file(agent: &str, path: &Path) -> bool {
    match agent {
        "codex" | "claude" => path.extension().is_some_and(|ext| ext == "jsonl"),
        "grok" => path.file_name().is_some_and(|name| name == "updates.jsonl"),
        _ => false,
    }
}

fn matches_cwd(agent: &str, path: &Path, cwd: &Path) -> bool {
    if cwd.as_os_str().is_empty() {
        return true;
    }
    match agent {
        "codex" => first_json_line(path)
            .and_then(|value| value.pointer("/payload/cwd")?.as_str().map(PathBuf::from))
            .is_some_and(|logged| same_path(&logged, cwd)),
        "claude" => {
            let slug = claude_project_slug(cwd);
            path.parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(&slug))
                || first_logged_cwd(path).is_some_and(|logged| same_path(&logged, cwd))
        }
        "grok" => path
            .parent()
            .map(|dir| dir.join("summary.json"))
            .and_then(|summary| fs::read_to_string(summary).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.pointer("/info/cwd")?.as_str().map(PathBuf::from))
            .is_some_and(|logged| same_path(&logged, cwd)),
        _ => false,
    }
}

fn first_json_line(path: &Path) -> Option<Value> {
    let line = BufReader::new(File::open(path).ok()?)
        .lines()
        .next()?
        .ok()?;
    serde_json::from_str(&line).ok()
}

fn first_logged_cwd(path: &Path) -> Option<PathBuf> {
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(256).flatten() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            return Some(PathBuf::from(cwd));
        }
    }
    None
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(
            right
                .to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\'),
        )
}

fn claude_project_slug(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|char| if char.is_alphanumeric() { char } else { '-' })
        .collect()
}

fn read_completions(watch: &mut Watch) -> bool {
    let Some(path) = watch.file.as_ref() else {
        return false;
    };
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len < watch.offset {
        watch.offset = len;
        return false;
    }
    if len == watch.offset || file.seek(SeekFrom::Start(watch.offset)).is_err() {
        return false;
    }

    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return false;
    }
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return false;
    };
    let complete = &bytes[..=last_newline];
    watch.offset += complete.len() as u64;

    complete
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .any(|line| is_completion_line(&watch.agent, line))
}

fn is_completion_line(agent: &str, line: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return false;
    };
    match agent {
        "codex" => {
            value.get("type").and_then(Value::as_str) == Some("event_msg")
                && value.pointer("/payload/type").and_then(Value::as_str) == Some("task_complete")
        }
        "claude" => {
            value.get("type").and_then(Value::as_str) == Some("assistant")
                && matches!(
                    value
                        .pointer("/message/stop_reason")
                        .and_then(Value::as_str),
                    Some("end_turn" | "stop_sequence")
                )
        }
        "grok" => {
            value
                .pointer("/params/update/sessionUpdate")
                .and_then(Value::as_str)
                == Some("turn_completed")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        claude_project_slug, gemini_defaults, install_antigravity_plugin, install_copilot_hook,
        install_opencode_plugin, is_completion_line, nearest_new_session, parse_hook_event,
        qwen_defaults, read_appended_lines, read_completions, write_hook_script, SessionCandidate,
        Watch, START_TOLERANCE,
    };
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime};

    #[test]
    fn a_new_session_beats_an_old_session_modified_more_recently() {
        let started = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let old = SessionCandidate {
            path: "old-but-active.jsonl".into(),
            modified: started + Duration::from_secs(2),
            created: Some(started - Duration::from_secs(60)),
        };
        let launched = SessionCandidate {
            path: "launched-for-this-pane.jsonl".into(),
            modified: started + Duration::from_secs(1),
            created: Some(started + Duration::from_millis(80)),
        };
        let matching = [&old, &launched];

        assert_eq!(
            nearest_new_session(started, started - START_TOLERANCE, &matching)
                .map(|candidate| candidate.path.as_path()),
            Some(Path::new("launched-for-this-pane.jsonl"))
        );
    }

    #[test]
    fn recognises_agent_turn_completion_records() {
        assert!(is_completion_line(
            "codex",
            br#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        ));
        assert!(is_completion_line(
            "claude",
            br#"{"type":"assistant","message":{"stop_reason":"end_turn"}}"#,
        ));
        assert!(is_completion_line(
            "grok",
            br#"{"params":{"update":{"sessionUpdate":"turn_completed"}}}"#,
        ));
    }

    #[test]
    fn ignores_in_progress_agent_records() {
        assert!(!is_completion_line(
            "codex",
            br#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
        ));
        assert!(!is_completion_line(
            "claude",
            br#"{"type":"assistant","message":{"stop_reason":"tool_use"}}"#,
        ));
    }

    #[test]
    fn claude_slug_matches_its_project_directory_shape() {
        assert_eq!(
            claude_project_slug(Path::new(r"H:\Python\Slop\duckweed")),
            "H--Python-Slop-duckweed"
        );
    }

    #[test]
    fn follows_only_new_complete_lines() {
        let dir =
            std::env::temp_dir().join(format!("duckweed-agent-activity-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .unwrap();
        let mut watch = Watch {
            agent: "codex".into(),
            cwd: dir.clone(),
            started: SystemTime::now(),
            next_discovery: Instant::now(),
            file: Some(path.clone()),
            offset: fs::metadata(&path).unwrap().len(),
        };
        assert!(!read_completions(&mut watch));

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n")
            .unwrap();
        assert!(read_completions(&mut watch));
        assert!(!read_completions(&mut watch));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_hook_events_before_routing_them_to_a_terminal() {
        assert_eq!(
            parse_hook_event(b"terminal-123|opencode"),
            Some(("terminal-123", "opencode"))
        );
        assert_eq!(
            parse_hook_event(b"pane_7|antigravity"),
            Some(("pane_7", "antigravity"))
        );
        assert_eq!(parse_hook_event(b"terminal-123|unknown"), None);
        assert_eq!(parse_hook_event(b"../terminal|gemini"), None);
    }

    #[test]
    fn hook_settings_use_turn_completion_events() {
        let hook = Path::new(r"C:\Duckweed Data\agent-complete.cmd");
        let gemini = gemini_defaults(hook);
        assert_eq!(
            gemini.pointer("/general/notificationMethod"),
            Some(&serde_json::json!("osc777"))
        );
        assert!(gemini
            .pointer("/hooks/AfterAgent/0/hooks/0/command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| command.ends_with(" gemini")));

        let qwen = qwen_defaults(hook);
        assert!(qwen
            .pointer("/hooks/Stop/0/hooks/0/command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| command.ends_with(" qwen")));
    }

    #[test]
    fn hook_event_reader_waits_for_complete_lines() {
        let dir =
            std::env::temp_dir().join(format!("duckweed-agent-hook-events-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.log");
        fs::write(&path, b"pane-1|gemini\npane-2|open").unwrap();
        let mut offset = 0;
        assert_eq!(
            read_appended_lines(&path, &mut offset),
            vec![b"pane-1|gemini".to_vec()]
        );

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"code\n").unwrap();
        assert_eq!(
            read_appended_lines(&path, &mut offset),
            vec![b"pane-2|opencode".to_vec()]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn creates_isolated_hook_integrations() {
        let dir = std::env::temp_dir().join(format!(
            "duckweed-agent-integrations-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let hook = dir.join(if cfg!(windows) {
            "agent-complete.ps1"
        } else {
            "agent-complete.sh"
        });
        write_hook_script(&hook).unwrap();
        install_opencode_plugin(&dir.join("opencode-plugin.js")).unwrap();
        install_antigravity_plugin(&dir, &hook).unwrap();
        fs::create_dir_all(dir.join(".copilot")).unwrap();
        install_copilot_hook(&dir, &hook).unwrap();

        assert!(fs::read_to_string(dir.join("opencode-plugin.js"))
            .unwrap()
            .contains("session.idle"));
        assert!(dir
            .join(".gemini/config/plugins/duckweed-terminal-notifications/hooks.json")
            .is_file());
        assert!(dir
            .join(".copilot/hooks/dev.slop.duckweed-terminal-notifications.json")
            .is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn antigravity_hook_waits_until_background_work_is_idle() {
        let dir =
            std::env::temp_dir().join(format!("duckweed-agent-hook-run-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let hook = dir.join(if cfg!(windows) {
            "agent-complete.ps1"
        } else {
            "agent-complete.sh"
        });
        let events = dir.join("events.log");
        fs::write(&events, b"").unwrap();
        write_hook_script(&hook).unwrap();

        let run = |payload: &str| {
            let mut command = if cfg!(windows) {
                let mut command = Command::new("powershell.exe");
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ]);
                command.arg(&hook);
                command
            } else {
                Command::new(&hook)
            };
            let mut child = command
                .arg("antigravity")
                .env("DUCKWEED_TERMINAL_ID", "pane-1")
                .env("DUCKWEED_AGENT_EVENTS", &events)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.as_bytes())
                .unwrap();
            assert!(child.wait().unwrap().success());
        };

        run(r#"{"fullyIdle":false}"#);
        assert_eq!(fs::read_to_string(&events).unwrap(), "");
        run(r#"{"fullyIdle":true}"#);
        assert_eq!(
            fs::read_to_string(&events).unwrap().trim(),
            "pane-1|antigravity"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
