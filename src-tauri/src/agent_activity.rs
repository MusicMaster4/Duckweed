//! Turn-completion detection for persistent coding-agent CLIs.
//!
//! A normal command leaves the shell process tree when it finishes. Codex,
//! Claude Code, and other coding agents stay alive and wait for another prompt,
//! so process-tree idleness cannot describe a completed turn. Codex, Claude,
//! and Grok expose durable session records; hook-capable agents use a tiny
//! app-owned bridge that records only the terminal id and agent kind.
//!
//! Long multi-step turns often write intermediate "done" records. Codex
//! auto-continues with `task_complete` → `task_started` a few milliseconds
//! later; Grok emits `turn_completed` for sub-task callbacks; OpenCode can
//! publish `session.idle` while background work is still running. Candidate
//! completions therefore wait a quiet period, and any fresh working signal
//! cancels the pending notification.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Datelike, Local, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_sessions;

const POLL: Duration = Duration::from_millis(350);
const DISCOVERY_POLL: Duration = Duration::from_secs(2);
/// Cadence for a pane that is following a transcript it is not sure about.
/// Agents like Claude Code only create their session file with the first
/// prompt, which the user may not send for minutes, so the search never stops
/// — it just stops costing a directory walk every two seconds.
const WEAK_RECHECK_POLL: Duration = Duration::from_secs(15);
const WEAK_RECHECK_AFTER: Duration = Duration::from_secs(60);
const DISCOVERY_START_DELAY: Duration = Duration::from_secs(1);
const START_TOLERANCE: Duration = Duration::from_secs(3);
/// Only the tail can contain work written after an old session was resumed.
/// Eight MiB is deliberately generous for the one-second discovery delay and
/// avoids rereading a potentially huge historical transcript from the start.
const RESUMED_SESSION_TAIL_BYTES: u64 = 8 * 1024 * 1024;
/// Codex auto-continues within ~5–10 ms of `task_complete`. A short quiet
/// window absorbs that hand-off (and OpenCode's premature idle) without
/// making a real idle turn feel laggy.
const COMPLETE_QUIET: Duration = Duration::from_millis(800);
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
    /// The transcript was matched by creation time, so it is certainly the
    /// session this pane launched. A `false` here means the pane fell back to
    /// "most recently written transcript for this project", which can belong
    /// to another copy of the same CLI — an editor's integrated terminal, a
    /// second Duckweed window — because agents like Claude Code only create
    /// their transcript once the first prompt is sent, several seconds after
    /// discovery starts. Weak matches keep looking for the real one.
    strong: bool,
    /// Candidate turn end waiting for a quiet period before emit.
    pending_complete: Option<Instant>,
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

/// Bridge-hook completions also wait for quiet: a single premature
/// `session.idle` / Stop hook must not beat the next activity line.
struct PendingHook {
    agent: String,
    since: Instant,
}

/// How a new session-log line affects completion state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LineSignal {
    None,
    /// Agent is actively working — cancel any pending completion.
    Working,
    /// Candidate turn end — schedule emit after [`COMPLETE_QUIET`].
    Completed,
}

#[derive(Default)]
pub struct AgentActivityManager {
    watches: Mutex<HashMap<String, Watch>>,
    hook_events: Mutex<Option<HookEvents>>,
    pending_hooks: Mutex<HashMap<String, PendingHook>>,
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
                // Let the CLI read its own executable/configuration first.
                // Transcript discovery is disk-heavy and completion records
                // remain durable, so beginning a moment later loses nothing.
                next_discovery: Instant::now() + DISCOVERY_START_DELAY,
                file: None,
                offset: 0,
                strong: false,
                pending_complete: None,
            },
        );
    }

    pub fn unwatch(&self, id: &str) {
        self.watches.lock().unwrap().remove(id);
        self.pending_hooks.lock().unwrap().remove(id);
    }

    fn poll(&self, app: &AppHandle) {
        let mut watches = self.watches.lock().unwrap();
        let mut claimed: HashSet<PathBuf> = watches
            .values()
            .filter_map(|watch| watch.file.clone())
            .collect();

        for (id, watch) in watches.iter_mut() {
            // Keep searching while nothing is bound, and also while the bound
            // transcript is only a guess: the pane's own session file may not
            // have existed yet when the first search ran.
            if !watch.strong && LOG_AGENTS.contains(&watch.agent.as_str()) {
                if Instant::now() >= watch.next_discovery {
                    let waited = SystemTime::now()
                        .duration_since(watch.started)
                        .unwrap_or_default();
                    watch.next_discovery = Instant::now()
                        + if waited > WEAK_RECHECK_AFTER {
                            WEAK_RECHECK_POLL
                        } else {
                            DISCOVERY_POLL
                        };
                    if let Some((path, strong)) = discover_session(watch, &claimed) {
                        // A guess never replaces a guess — that would only
                        // trade one wrong transcript for another and reset the
                        // read offset each time.
                        if watch.file.as_ref() == Some(&path) {
                            // Same transcript we already follow: just promote a
                            // weak match. Resetting the offset here would
                            // re-ingest historical end-of-turn lines and play
                            // the completion sound again minutes later.
                            if strong {
                                watch.strong = true;
                            }
                        } else if watch.file.is_none() || strong {
                            watch.offset = initial_offset(&path, watch.started);
                            watch.pending_complete = None;
                            watch.strong = strong;
                            claimed.insert(path.clone());
                            watch.file = Some(path);
                        }
                    }
                }
                if watch.file.is_none() {
                    continue;
                }
            } else if watch.file.is_none() {
                continue;
            }

            let signal = ingest_session_lines(watch);
            apply_line_signal(watch, signal);
            if watch
                .pending_complete
                .is_some_and(|since| since.elapsed() >= COMPLETE_QUIET)
            {
                watch.pending_complete = None;
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
        // Log-backed agents never write this bridge file. Avoid opening and
        // stat-ing it every 350 ms while Codex/Claude/Grok are starting.
        let has_hook_agent = self
            .watches
            .lock()
            .unwrap()
            .values()
            .any(|watch| !LOG_AGENTS.contains(&watch.agent.as_str()));
        if !has_hook_agent && self.pending_hooks.lock().unwrap().is_empty() {
            return;
        }

        if has_hook_agent {
            let lines = {
                let mut state = self.hook_events.lock().unwrap();
                let Some(events) = state.as_mut() else {
                    return;
                };
                read_appended_lines(&events.path, &mut events.offset)
            };

            let watches = self.watches.lock().unwrap();
            let mut pending = self.pending_hooks.lock().unwrap();
            for line in lines {
                let Some((id, agent)) = parse_hook_event(&line) else {
                    continue;
                };
                if !watches.get(id).is_some_and(|watch| watch.agent == agent) {
                    continue;
                }
                // Fresh idle/stop from the bridge restarts the quiet window.
                pending.insert(
                    id.to_owned(),
                    PendingHook {
                        agent: agent.to_owned(),
                        since: Instant::now(),
                    },
                );
            }
        }

        let mut pending = self.pending_hooks.lock().unwrap();
        let watches = self.watches.lock().unwrap();
        let ready: Vec<(String, String)> = pending
            .iter()
            .filter(|(id, hook)| {
                hook.since.elapsed() >= COMPLETE_QUIET
                    && watches
                        .get(id.as_str())
                        .is_some_and(|watch| watch.agent == hook.agent)
            })
            .map(|(id, hook)| (id.clone(), hook.agent.clone()))
            .collect();
        for (id, agent) in ready {
            pending.remove(&id);
            let _ = app.emit(
                "agent:complete",
                CompletionPayload {
                    id,
                    agent,
                },
            );
        }
        // Drop hooks for panes that were unwatched or rebound mid-quiet.
        pending.retain(|id, hook| {
            watches
                .get(id.as_str())
                .is_some_and(|watch| watch.agent == hook.agent)
        });
    }
}

fn apply_line_signal(watch: &mut Watch, signal: LineSignal) {
    match signal {
        LineSignal::None => {}
        LineSignal::Working => watch.pending_complete = None,
        LineSignal::Completed => watch.pending_complete = Some(Instant::now()),
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
    // Most coding CLIs are sizeable Node applications. Node 22+ can persist
    // compiled CommonJS/ESM bytecode between runs, which removes a substantial
    // amount of repeated parsing from every subsequent CLI launch. Older Node
    // versions simply ignore this variable, and an explicit user cache or
    // NODE_DISABLE_COMPILE_CACHE always wins.
    if std::env::var_os("NODE_COMPILE_CACHE").is_none()
        && std::env::var_os("NODE_DISABLE_COMPILE_CACHE").is_none()
    {
        env.push((
            "NODE_COMPILE_CACHE".into(),
            std::env::temp_dir()
                .join("duckweed-node-compile-cache")
                .to_string_lossy()
                .into_owned(),
        ));
    }
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
    // session.idle can fire while subagents / background work still run.
    // Debounce the bridge write and cancel it if tools or chat restart.
    let plugin = r#"// Installed by Duckweed. Inert unless OpenCode runs inside a Duckweed PTY.
import { appendFileSync } from "node:fs"

const QUIET_MS = 800

export const DuckweedTerminalNotifications = async () => {
  let idleTimer = null
  const cancel = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const notify = () => {
    const id = process.env.DUCKWEED_TERMINAL_ID
    const target = process.env.DUCKWEED_AGENT_EVENTS
    if (!id || !target) return
    appendFileSync(target, `${id}|opencode\n`, "utf8")
  }
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        cancel()
        idleTimer = setTimeout(() => {
          idleTimer = null
          notify()
        }, QUIET_MS)
        return
      }
      if (
        event.type === "session.error" ||
        event.type === "message.updated" ||
        event.type === "message.part.updated" ||
        event.type === "session.status"
      ) {
        cancel()
      }
    },
    "tool.execute.before": async () => {
      cancel()
    },
    "chat.message": async () => {
      cancel()
    },
  }
}
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

/// Small roots that can contain the session launched for this watch.
///
/// Walking every historical transcript while an agent is starting competes
/// with that same agent for disk access. Codex partitions sessions by date and
/// Claude partitions them by project, so discovery can stay inside those live
/// leaves. Local and UTC dates cover the two conventions around midnight.
fn discovery_roots(watch: &Watch, home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    match watch.agent.as_str() {
        "codex" => {
            let base = home.join(".codex/sessions");
            let started_local = DateTime::<Local>::from(watch.started);
            let started_utc = DateTime::<Utc>::from(watch.started);
            let now_local = Local::now();
            let now_utc = Utc::now();
            for (year, month, day) in [
                (
                    started_local.year(),
                    started_local.month(),
                    started_local.day(),
                ),
                (started_utc.year(), started_utc.month(), started_utc.day()),
                (now_local.year(), now_local.month(), now_local.day()),
                (now_utc.year(), now_utc.month(), now_utc.day()),
            ] {
                let path = base
                    .join(format!("{year:04}"))
                    .join(format!("{month:02}"))
                    .join(format!("{day:02}"));
                if !roots.contains(&path) {
                    roots.push(path);
                }
            }
        }
        "claude" => {
            let slug = claude_project_slug(&watch.cwd);
            roots.push(home.join(".claude/projects").join(&slug));
            roots.push(home.join(".config/claude/projects").join(slug));
        }
        "grok" => roots.push(home.join(".grok/sessions")),
        _ => {}
    }
    roots
}

/// Start at the beginning of a transcript created for this pane, and at the end
/// of one that was already running — its history is somebody else's turn.
fn initial_offset(path: &Path, started: SystemTime) -> u64 {
    fs::metadata(path)
        .map(|meta| {
            let new_session = meta.created().ok().is_some_and(|created| {
                created
                    >= started
                        .checked_sub(START_TOLERANCE)
                        .unwrap_or(SystemTime::UNIX_EPOCH)
            });
            if new_session {
                0
            } else {
                resumed_session_offset(path, started, meta.len()).unwrap_or(meta.len())
            }
        })
        .unwrap_or(0)
}

/// Keep events written between launch and transcript discovery.
///
/// Codex, Claude, and Grok all timestamp their JSONL rows. Starting at the
/// current file length loses a fast completion whenever a resumed transcript
/// is discovered after the first output arrived. Scan only the recent tail and
/// begin at the first row owned by this watch instead.
fn resumed_session_offset(path: &Path, started: SystemTime, len: u64) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let tail_start = len.saturating_sub(RESUMED_SESSION_TAIL_BYTES);
    file.seek(SeekFrom::Start(tail_start)).ok()?;
    let mut reader = BufReader::new(file);
    let mut offset = tail_start;
    let mut line = Vec::new();

    // The seek can land in the middle of a JSON row. Discard that fragment so
    // its timestamp cannot be mistaken for the start of a complete record.
    if tail_start > 0 {
        let read = reader.read_until(b'\n', &mut line).ok()?;
        offset += read as u64;
        line.clear();
    }

    loop {
        let line_start = offset;
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            break;
        }
        offset += read as u64;
        if logged_at(&line).is_some_and(|timestamp| timestamp >= started) {
            return Some(line_start);
        }
        // Keep the start of a row that was still being appended while the
        // transcript was discovered. Advancing to EOF here would skip the
        // completion after its closing bytes and newline arrive.
        if !line.ends_with(b"\n") {
            return Some(line_start);
        }
        line.clear();
    }
    None
}

fn logged_at(line: &[u8]) -> Option<SystemTime> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    let timestamp = value
        .get("timestamp")
        .or_else(|| value.pointer("/payload/timestamp"))?;
    if let Some(text) = timestamp.as_str() {
        let parsed = DateTime::parse_from_rfc3339(text).ok()?;
        let millis = parsed.timestamp_millis();
        return (millis >= 0)
            .then(|| SystemTime::UNIX_EPOCH + Duration::from_millis(millis as u64));
    }
    let numeric = timestamp.as_i64()?;
    (numeric >= 0).then(|| {
        let millis = if numeric >= 1_000_000_000_000 {
            numeric as u64
        } else {
            numeric as u64 * 1_000
        };
        SystemTime::UNIX_EPOCH + Duration::from_millis(millis)
    })
}

/// Returns the transcript to follow and whether the match is a certain one
/// (see [`Watch::strong`]).
fn discover_session(watch: &Watch, claimed: &HashSet<PathBuf>) -> Option<(PathBuf, bool)> {
    let home = home_dir()?;
    discover_session_in_home(watch, claimed, &home)
}

fn discover_session_in_home(
    watch: &Watch,
    claimed: &HashSet<PathBuf>,
    home: &Path,
) -> Option<(PathBuf, bool)> {
    let roots = discovery_roots(watch, home);
    if roots.is_empty() {
        return None;
    }
    let earliest = watch
        .started
        .checked_sub(START_TOLERANCE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut candidates = Vec::new();

    // A resumed Codex thread remains under its original YYYY/MM/DD directory.
    // The state database is the CLI's canonical resume index, so consult it
    // before the small current-day directory scan. Other log-backed agents do
    // not partition their project/session stores by creation date.
    if watch.agent == "codex" {
        for path in agent_sessions::codex_rollout_paths(home, &watch.cwd) {
            if claimed.contains(&path)
                || candidates
                    .iter()
                    .any(|candidate: &SessionCandidate| candidate.path == path)
                || !is_session_file(&watch.agent, &path)
            {
                continue;
            }
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if modified >= earliest {
                candidates.push(SessionCandidate {
                    path,
                    modified,
                    created: metadata.created().ok(),
                });
            }
        }
    }
    for root in roots {
        collect_recent(&root, &watch.agent, earliest, claimed, &mut candidates);
    }
    let matching: Vec<&SessionCandidate> = candidates
        .iter()
        .filter(|candidate| matches_cwd(&watch.agent, &candidate.path, &watch.cwd))
        .collect();

    // A new interactive agent creates its session shortly after Duckweed starts
    // watching it. Prefer that creation-time correlation over last-modified:
    // another Codex/Claude/Grok process in the same project may be writing at
    // the same time and would otherwise steal this pane's watch.
    if let Some(candidate) = nearest_new_session(watch.started, earliest, &matching) {
        return Some((candidate.path.clone(), true));
    }
    matching
        .iter()
        .max_by_key(|candidate| candidate.modified)
        .copied()
        .or_else(|| (candidates.len() == 1).then(|| &candidates[0]))
        .map(|candidate| (candidate.path.clone(), false))
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

/// Read newly appended session lines and fold them into one signal.
///
/// The last non-[`LineSignal::None`] line wins: a `task_complete` followed
/// immediately by `task_started` in the same batch collapses to Working.
fn ingest_session_lines(watch: &mut Watch) -> LineSignal {
    let Some(path) = watch.file.as_ref() else {
        return LineSignal::None;
    };
    let Ok(mut file) = File::open(path) else {
        return LineSignal::None;
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len < watch.offset {
        watch.offset = len;
        return LineSignal::None;
    }
    if len == watch.offset || file.seek(SeekFrom::Start(watch.offset)).is_err() {
        return LineSignal::None;
    }

    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return LineSignal::None;
    }
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return LineSignal::None;
    };
    let complete = &bytes[..=last_newline];
    watch.offset += complete.len() as u64;

    let mut last = LineSignal::None;
    for line in complete
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let next = classify_session_line(&watch.agent, line);
        if next != LineSignal::None {
            last = next;
        }
    }
    last
}

fn classify_session_line(agent: &str, line: &[u8]) -> LineSignal {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return LineSignal::None;
    };
    match agent {
        "codex" => classify_codex(&value),
        "claude" => classify_claude(&value),
        "grok" => classify_grok(&value),
        _ => LineSignal::None,
    }
}

fn classify_codex(value: &Value) -> LineSignal {
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return LineSignal::None;
    }
    match value.pointer("/payload/type").and_then(Value::as_str) {
        // Auto-continue starts the next task within milliseconds of complete.
        Some("task_started") => LineSignal::Working,
        Some("task_complete") => LineSignal::Completed,
        Some("turn_aborted") => match value.pointer("/payload/reason").and_then(Value::as_str) {
            // The user pressed Esc, or sent a new prompt over the running
            // turn. They are at the keyboard: nothing finished, and a sound
            // for their own keystroke is pure noise.
            Some("interrupted") | Some("replaced") => LineSignal::Working,
            // Aborted for any other reason (an error, a refused turn) still
            // hands the prompt back and is worth surfacing.
            _ => LineSignal::Completed,
        },
        _ => LineSignal::None,
    }
}

fn classify_claude(value: &Value) -> LineSignal {
    match value.get("type").and_then(Value::as_str) {
        // Claude Code writes this once the full turn is done (including tool
        // loops). Prefer it over intermediate assistant stop_reason records.
        Some("system")
            if value.get("subtype").and_then(Value::as_str) == Some("turn_duration") =>
        {
            LineSignal::Completed
        }
        Some("assistant") => {
            // Subagent / sidechain transcripts can share the project log.
            if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                return LineSignal::None;
            }
            match value
                .pointer("/message/stop_reason")
                .and_then(Value::as_str)
            {
                // Still calling tools — the turn is not idle.
                Some("tool_use") => LineSignal::Working,
                // Text-only final reply. `stop_sequence` is often a synthetic
                // rate-limit row and is covered by turn_duration when real.
                Some("end_turn") => LineSignal::Completed,
                _ => LineSignal::None,
            }
        }
        // Tool results and follow-up user turns mean work is still flowing.
        Some("user") => {
            let content = value.pointer("/message/content");
            // Esc during a turn: Claude Code records the interruption as a
            // user message. The user stopped the work themselves, so a pending
            // completion for that turn must be dropped, not announced.
            if content.is_some_and(content_is_interrupt) {
                return LineSignal::Working;
            }
            if content
                .map(|content| content_has_tool_result(content))
                .unwrap_or(false)
            {
                LineSignal::Working
            } else {
                LineSignal::None
            }
        }
        _ => LineSignal::None,
    }
}

/// Claude Code's marker for a turn the user stopped, as plain text or as a
/// single text block.
fn content_is_interrupt(content: &Value) -> bool {
    const MARKER: &str = "[Request interrupted by user";
    match content {
        Value::String(text) => text.starts_with(MARKER),
        Value::Array(items) => items.iter().any(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.starts_with(MARKER))
        }),
        _ => false,
    }
}

fn content_has_tool_result(content: &Value) -> bool {
    match content {
        Value::Array(items) => items.iter().any(|item| {
            item.get("type").and_then(Value::as_str) == Some("tool_result")
                || item
                    .get("content")
                    .map(content_has_tool_result)
                    .unwrap_or(false)
        }),
        Value::Object(map) => map
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "tool_result"),
        _ => false,
    }
}

fn classify_grok(value: &Value) -> LineSignal {
    let Some(update) = value.pointer("/params/update") else {
        return LineSignal::None;
    };
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("tool_call" | "tool_call_update" | "agent_message_chunk" | "agent_thought_chunk") => {
            LineSignal::Working
        }
        Some("user_message_chunk") => LineSignal::Working,
        Some("turn_completed") => {
            // Background Task tool completions are tagged as turn_completed
            // with a synthetic prompt id while the parent turn continues.
            let prompt_id = update.get("prompt_id").and_then(Value::as_str).unwrap_or("");
            // Synthetic ids look like `task-completed-call-<uuid>-N`.
            if prompt_id.starts_with("task-completed-call-") {
                LineSignal::None
            } else {
                LineSignal::Completed
            }
        }
        // Sub-task lifecycle is not the outer agent turn.
        Some("task_completed" | "task_backgrounded") => LineSignal::None,
        _ => LineSignal::None,
    }
}

/// Test helper: true when a line is a completion *candidate* (not Working).
#[cfg(test)]
fn is_completion_line(agent: &str, line: &[u8]) -> bool {
    classify_session_line(agent, line) == LineSignal::Completed
}

#[cfg(test)]
mod tests {
    use super::{
        apply_line_signal, claude_project_slug, classify_session_line, discover_session_in_home,
        discovery_roots, gemini_defaults, ingest_session_lines, initial_offset,
        install_antigravity_plugin, install_copilot_hook, install_opencode_plugin,
        is_completion_line, nearest_new_session, parse_hook_event, qwen_defaults,
        read_appended_lines, write_hook_script, LineSignal, SessionCandidate, Watch, START_TOLERANCE,
    };
    use chrono::{DateTime, Utc};
    use rusqlite::{params, Connection};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime};

    fn bare_watch(agent: &str, file: Option<PathBuf>, offset: u64) -> Watch {
        Watch {
            agent: agent.into(),
            cwd: PathBuf::from(r"H:\work"),
            started: SystemTime::now(),
            next_discovery: Instant::now(),
            file,
            offset,
            strong: true,
            pending_complete: None,
        }
    }

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
            "claude",
            br#"{"type":"system","subtype":"turn_duration","durationMs":1200}"#,
        ));
        assert!(is_completion_line(
            "grok",
            br#"{"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"0586a3a5-bf76-4ee8-be99-6f229196e8a7"}}}"#,
        ));
    }

    #[test]
    fn ignores_in_progress_agent_records() {
        assert_eq!(
            classify_session_line(
                "codex",
                br#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            ),
            LineSignal::Working
        );
        assert_eq!(
            classify_session_line(
                "claude",
                br#"{"type":"assistant","message":{"stop_reason":"tool_use"}}"#,
            ),
            LineSignal::Working
        );
        assert!(!is_completion_line(
            "claude",
            br#"{"type":"assistant","message":{"stop_reason":"stop_sequence"}}"#,
        ));
        assert!(!is_completion_line(
            "claude",
            br#"{"type":"assistant","isSidechain":true,"message":{"stop_reason":"end_turn"}}"#,
        ));
        assert!(!is_completion_line(
            "grok",
            br#"{"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"task-completed-call-99f7904f-2551-46b0-aeb6-cf7ede36dbad-27"}}}"#,
        ));
        // Esc during a turn: the user is at the keyboard and stopped the work
        // themselves, and a pending completion for that turn must be dropped.
        assert_eq!(
            classify_session_line(
                "codex",
                br#"{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#,
            ),
            LineSignal::Working
        );
        assert_eq!(
            classify_session_line(
                "claude",
                br#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
            ),
            LineSignal::Working
        );
        // An abort Codex reports for its own reasons still hands back control.
        assert!(is_completion_line(
            "codex",
            br#"{"type":"event_msg","payload":{"type":"turn_aborted","reason":"error"}}"#,
        ));
        assert_eq!(
            classify_session_line(
                "grok",
                br#"{"params":{"update":{"sessionUpdate":"tool_call"}}}"#,
            ),
            LineSignal::Working
        );
    }

    #[test]
    fn claude_slug_matches_its_project_directory_shape() {
        assert_eq!(
            claude_project_slug(Path::new(r"H:\Python\Slop\duckweed")),
            "H--Python-Slop-duckweed"
        );
    }

    #[test]
    fn session_discovery_stays_out_of_historical_roots() {
        let home = Path::new(r"C:\Users\duck");
        let started = SystemTime::now();
        let codex = bare_watch("codex", None, 0);
        let codex_roots = discovery_roots(&codex, home);
        assert!(!codex_roots.is_empty());
        assert!(codex_roots.len() <= 4);
        assert!(codex_roots
            .iter()
            .all(|path| path.components().count() >= home.components().count() + 4));

        let claude = Watch {
            agent: "claude".into(),
            cwd: Path::new(r"H:\Python\Slop\duckweed").into(),
            started,
            next_discovery: Instant::now(),
            file: None,
            offset: 0,
            strong: false,
            pending_complete: None,
        };
        assert!(discovery_roots(&claude, home)
            .iter()
            .all(|path| path.ends_with("H--Python-Slop-duckweed")));
    }

    #[test]
    fn codex_discovery_finds_a_resumed_goal_in_its_original_day() {
        let home = std::env::temp_dir().join(format!(
            "duckweed-agent-activity-resumed-goal-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        let rollout = home
            .join(".codex/sessions/2025/01/02")
            .join("rollout-old-goal.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(
            &rollout,
            concat!(
                r#"{"timestamp":"2025-01-02T12:00:00Z","type":"session_meta","payload":{"id":"old-goal","cwd":"H:\\work"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let database = home.join(".codex/state_5.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    updated_at_ms INTEGER,
                    recency_at_ms INTEGER
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (
                    id, rollout_path, cwd, archived, updated_at, updated_at_ms, recency_at_ms
                 ) VALUES ('old-goal', ?1, ?2, 0, 1, 1, 1)",
                params![rollout.to_string_lossy().as_ref(), r"H:\work"],
            )
            .unwrap();
        drop(connection);

        let watch = bare_watch("codex", None, 0);
        let found = discover_session_in_home(&watch, &Default::default(), &home)
            .map(|(path, _)| path);
        assert_eq!(found.as_deref(), Some(rollout.as_path()));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn resumed_log_harnesses_keep_events_written_before_discovery() {
        let dir = std::env::temp_dir().join(format!(
            "duckweed-agent-activity-resumed-offset-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // A future watch time makes these freshly-created fixtures behave like
        // old resumed files without relying on platform-specific ctime edits.
        let started = SystemTime::now() + Duration::from_secs(10);
        let completed_at = DateTime::<Utc>::from(started + Duration::from_secs(1)).to_rfc3339();
        let cases = [
            (
                "codex",
                format!(
                    r#"{{"timestamp":"{completed_at}","type":"event_msg","payload":{{"type":"task_complete"}}}}"#,
                ),
            ),
            (
                "claude",
                format!(
                    r#"{{"timestamp":"{completed_at}","type":"system","subtype":"turn_duration"}}"#,
                ),
            ),
            (
                "grok",
                format!(
                    r#"{{"timestamp":"{completed_at}","params":{{"update":{{"sessionUpdate":"turn_completed","prompt_id":"root-turn"}}}}}}"#,
                ),
            ),
        ];

        for (agent, completion) in cases {
            let path = dir.join(format!("{agent}.jsonl"));
            let history = "{\"timestamp\":\"2025-01-02T12:00:00Z\"}\n";
            fs::write(&path, format!("{history}{completion}\n")).unwrap();
            let offset = initial_offset(&path, started);
            assert_eq!(offset, history.len() as u64, "{agent}");

            let mut watch = Watch {
                agent: agent.into(),
                cwd: PathBuf::from(r"H:\work"),
                started,
                next_discovery: Instant::now(),
                file: Some(path),
                offset,
                strong: true,
                pending_complete: None,
            };
            assert_eq!(ingest_session_lines(&mut watch), LineSignal::Completed, "{agent}");
        }

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resumed_log_discovery_keeps_a_half_written_completion() {
        let dir = std::env::temp_dir().join(format!(
            "duckweed-agent-activity-partial-offset-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("codex.jsonl");
        let history = "{\"timestamp\":\"2025-01-02T12:00:00Z\"}\n";
        let started = SystemTime::now() + Duration::from_secs(10);
        let completed_at = DateTime::<Utc>::from(started + Duration::from_secs(1)).to_rfc3339();
        let partial = format!(
            r#"{{"timestamp":"{completed_at}","type":"event_msg","payload":{{"type":"task_complete""#,
        );
        fs::write(&path, format!("{history}{partial}")).unwrap();

        let offset = initial_offset(&path, started);
        assert_eq!(offset, history.len() as u64);
        let mut watch = Watch {
            agent: "codex".into(),
            cwd: PathBuf::from(r"H:\work"),
            started,
            next_discovery: Instant::now(),
            file: Some(path.clone()),
            offset,
            strong: true,
            pending_complete: None,
        };
        assert_eq!(ingest_session_lines(&mut watch), LineSignal::None);
        assert_eq!(watch.offset, offset);

        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"}}\n")
            .unwrap();
        assert_eq!(ingest_session_lines(&mut watch), LineSignal::Completed);

        fs::remove_dir_all(dir).unwrap();
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
        let mut watch = bare_watch(
            "codex",
            Some(path.clone()),
            fs::metadata(&path).unwrap().len(),
        );
        assert_eq!(ingest_session_lines(&mut watch), LineSignal::None);

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n")
            .unwrap();
        assert_eq!(ingest_session_lines(&mut watch), LineSignal::Completed);
        assert_eq!(ingest_session_lines(&mut watch), LineSignal::None);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_auto_continue_cancels_a_pending_completion() {
        let dir = std::env::temp_dir().join(format!(
            "duckweed-agent-activity-continue-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        fs::write(&path, b"").unwrap();
        let mut watch = bare_watch("codex", Some(path.clone()), 0);

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        // Real Codex multi-turn chain: complete then start within a few ms.
        file.write_all(
            b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n\
              {\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .unwrap();
        let signal = ingest_session_lines(&mut watch);
        apply_line_signal(&mut watch, signal);
        assert!(watch.pending_complete.is_none());

        file.write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n")
            .unwrap();
        let signal = ingest_session_lines(&mut watch);
        apply_line_signal(&mut watch, signal);
        assert!(watch.pending_complete.is_some());

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

        let plugin = fs::read_to_string(dir.join("opencode-plugin.js")).unwrap();
        assert!(plugin.contains("session.idle"));
        assert!(plugin.contains("QUIET_MS"));
        assert!(plugin.contains("tool.execute.before"));
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
