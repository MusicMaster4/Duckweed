//! PTY session management.
//!
//! Every terminal pane in the UI owns one session here. Output is streamed to
//! the webview through a raw IPC channel owned by that session, so panes never
//! see each other's bytes and output does not need a Base64 round-trip.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};

use crate::process_tree;
use crate::shells;

/// How much PTY output we buffer before flushing an event to the webview.
const READ_BUF: usize = 16 * 1024;

/// Ceiling on one coalesced webview event, so a program dumping a large file
/// still arrives in pieces the UI can render as they land.
const EMIT_MAX: usize = 256 * 1024;

/// Back-pressure ceiling per PTY. A process that prints faster than the webview
/// can consume is slowed down by its terminal, instead of growing RAM forever.
const OUTPUT_QUEUE_CHUNKS: usize = 64;

/// Coalesce writes that land a moment apart into one webview event.
const EMIT_BATCH_WINDOW: Duration = Duration::from_millis(1);

/// Busy changes do not need per-pane polling. One snapshot covers every PTY.
///
/// A process snapshot walks the system-wide process table on Windows. Twice a
/// second keeps the pane state responsive while avoiding five global walks per
/// second whenever Duckweed is merely open. Close/update checks still take an
/// immediate fresh snapshot rather than relying on this cached UI state.
const BUSY_POLL: Duration = Duration::from_millis(500);

pub struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Shell process id, used to detect in-flight commands (child processes).
    pid: Option<u32>,
    cols: u16,
    rows: u16,
}

#[derive(Default)]
struct PtyInner {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    busy: Mutex<HashMap<String, bool>>,
}

#[derive(Clone, Default)]
pub struct PtyManager {
    inner: Arc<PtyInner>,
}

#[derive(Serialize, Clone)]
pub struct SpawnResult {
    pub id: String,
    pub shell_id: String,
    pub shell_label: String,
    pub program: String,
    pub cwd: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
    code: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct BusyPayload {
    id: String,
    busy: bool,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl PtyManager {
    fn insert(&self, id: String, session: Session) {
        self.inner
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(Mutex::new(session)));
        self.inner.busy.lock().unwrap().insert(id, false);
    }

    fn session(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.inner.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let handle = self
            .session(id)
            .ok_or_else(|| format!("no pty session `{id}`"))?;
        let mut session = handle.lock().unwrap();
        session.writer.write_all(data).map_err(err)?;
        session.writer.flush().map_err(err)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.max(2);
        let rows = rows.max(1);
        let handle = self
            .session(id)
            .ok_or_else(|| format!("no pty session `{id}`"))?;
        let mut session = handle.lock().unwrap();
        if session.cols == cols && session.rows == rows {
            return Ok(());
        }
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(err)?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let handle = match self.inner.sessions.lock().unwrap().remove(id) {
            Some(s) => s,
            // Killing an already-dead pane is not an error; the UI does it on
            // every pane close, including panes whose shell already exited.
            None => return Ok(()),
        };
        self.inner.busy.lock().unwrap().remove(id);
        let mut session = handle.lock().unwrap();
        let _ = session.killer.kill();
        let _ = session.writer.flush();
        Ok(())
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self
            .inner
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }

    /// Shell roots keyed by terminal id. Ports walks their descendants to
    /// attribute a listening server to the pane that launched it.
    pub fn root_processes(&self) -> Vec<(String, u32)> {
        self.inner
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, session)| {
                session
                    .lock()
                    .unwrap()
                    .pid
                    .map(|pid| (id.clone(), pid))
            })
            .collect()
    }

    /// True when the shell for `id` still has a child process (a command running).
    pub fn is_busy(&self, id: &str) -> bool {
        self.busy_snapshot(Some(&[id.to_string()]))
            .into_iter()
            .any(|state| state.busy)
    }

    /// True when any of the given sessions has a command still running.
    pub fn any_busy(&self, ids: &[String]) -> bool {
        self.busy_snapshot(Some(ids))
            .into_iter()
            .any(|state| state.busy)
    }

    fn busy_snapshot(&self, only: Option<&[String]>) -> Vec<BusyPayload> {
        let handles: Vec<(String, Arc<Mutex<Session>>)> = {
            let sessions = self.inner.sessions.lock().unwrap();
            sessions
                .iter()
                .filter(|(id, _)| match only {
                    Some(ids) => ids.contains(id),
                    None => true,
                })
                .map(|(id, session)| (id.clone(), session.clone()))
                .collect()
        };
        let with_pids: Vec<(String, u32)> = handles
            .into_iter()
            .filter_map(|(id, session)| session.lock().unwrap().pid.map(|pid| (id, pid)))
            .collect();
        let pids: Vec<u32> = with_pids.iter().map(|(_, pid)| *pid).collect();
        let parents = process_tree::parents_with_children(&pids);
        with_pids
            .into_iter()
            .map(|(id, pid)| BusyPayload {
                id,
                busy: parents.contains(&pid),
            })
            .collect()
    }

    fn refresh_busy(&self) -> Vec<BusyPayload> {
        let snapshot = self.busy_snapshot(None);
        let mut known = self.inner.busy.lock().unwrap();
        let mut changed = Vec::new();
        for state in snapshot {
            if known.get(&state.id).copied() != Some(state.busy) {
                known.insert(state.id.clone(), state.busy);
                changed.push(state);
            }
        }
        changed
    }
}

/// Start the single app-wide busy monitor. It exits with the main webview.
pub fn start_busy_monitor(app: AppHandle) -> Result<(), String> {
    std::thread::Builder::new()
        .name("pty-busy-monitor".into())
        .spawn(move || loop {
            std::thread::sleep(BUSY_POLL);
            if app.get_webview_window("main").is_none() {
                break;
            }
            let Some(manager) = app.try_state::<PtyManager>() else {
                continue;
            };
            let changed = manager.refresh_busy();
            if !changed.is_empty() && app.emit("pty:busy", changed).is_err() {
                break;
            }
        })
        .map(|_| ())
        .map_err(err)
}

/// Spawn a shell attached to a fresh PTY and start streaming its output.
pub fn spawn(
    app: &AppHandle,
    manager: &PtyManager,
    on_data: Channel<Vec<u8>>,
    id: String,
    cwd: Option<String>,
    shell_id: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnResult, String> {
    if manager.inner.sessions.lock().unwrap().contains_key(&id) {
        return Err(format!("pty session `{id}` already exists"));
    }

    let shell = shells::resolve_shell(shell_id.as_deref());
    let cols = cols.max(2);
    let rows = rows.max(1);

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;

    let mut cmd = CommandBuilder::new(&shell.program);
    let executable = std::path::Path::new(&shell.program)
        .file_stem()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let is_bash = executable == "bash";
    let is_zsh = executable == "zsh";
    let bash_hook = is_bash
        .then(|| crate::terminal_shell_integration::bash_hook(app).ok())
        .flatten();
    if let Some(path) = &bash_hook {
        // --rcfile is the only reliable interactive Bash startup hook. Our
        // file first sources the normal login profile, then installs OSC 133.
        cmd.arg("--noprofile");
        cmd.arg("--rcfile");
        cmd.arg(path.to_string_lossy().as_ref());
        cmd.arg("-i");
    } else {
        for arg in &shell.args {
            cmd.arg(arg);
        }
    }

    // Prefer the project directory; fall back to the user's home so we never
    // inherit the (arbitrary) directory the app was launched from.
    let resolved_cwd = cwd
        .filter(|p| !p.is_empty() && std::path::Path::new(p).is_dir())
        .or_else(|| home_dir().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());
    cmd.cwd(&resolved_cwd);

    // Advertise colour, but never force it: `FORCE_COLOR`/`CLICOLOR_FORCE` would
    // also make tools emit escape codes when their output is redirected, so
    // `some-cmd > out.txt` inside the terminal would end up full of them.
    // Detection through TERM/COLORTERM already works — what was missing was a
    // palette saturated enough to tell the resulting colours apart.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CLICOLOR", "1");
    cmd.env("TERM_PROGRAM", "Duckweed");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    for (key, value) in crate::agent_activity::terminal_env(app, &id) {
        cmd.env(key, value);
    }
    let requested_zdotdir = env
        .as_ref()
        .and_then(|values| values.get("ZDOTDIR"))
        .filter(|value| !value.is_empty())
        .cloned()
        .or_else(|| std::env::var("ZDOTDIR").ok().filter(|value| !value.is_empty()));
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    // Apply integration variables last so a pane-specific environment cannot
    // accidentally point startup at an unrelated script or ZDOTDIR.
    //
    // PowerShell deliberately starts with its normal arguments. Injecting a
    // prompt/PSReadLine hook here can make ConPTY continuously repaint the
    // shared history buffer while the terminal is idle. Besides flashing old
    // commands, that feedback loop consumes CPU and grows the WebView until it
    // becomes unresponsive. Editor-mode command blocks do not need the hook.
    if is_zsh {
        if let Ok(path) = crate::terminal_shell_integration::zsh_zdotdir(app) {
            let original = requested_zdotdir
                .or_else(|| home_dir().map(|value| value.to_string_lossy().to_string()))
                .unwrap_or_else(|| resolved_cwd.clone());
            cmd.env("DUCKWEED_ORIGINAL_ZDOTDIR", original);
            cmd.env("DUCKWEED_ZDOTDIR", path.to_string_lossy().as_ref());
            cmd.env("ZDOTDIR", path.to_string_lossy().as_ref());
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    // Dropping the slave lets the shell see EOF once it exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    manager.insert(
        id.clone(),
        Session {
            writer,
            master: pair.master,
            killer,
            pid,
            cols,
            rows,
        },
    );

    // Reader thread: a bounded queue keeps bulk output from consuming unbounded
    // memory. Back-pressure is normal terminal behaviour and never drops bytes.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(OUTPUT_QUEUE_CHUNKS);
    let (recycle_tx, recycle_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(OUTPUT_QUEUE_CHUNKS);
    std::thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.truncate(n);
                        if tx.send(buf).is_err() {
                            break;
                        }
                        buf = recycle_rx
                            .try_recv()
                            .unwrap_or_else(|_| vec![0u8; READ_BUF]);
                        buf.resize(READ_BUF, 0);
                    }
                }
            }
        })
        .map_err(err)?;

    // Emitter thread: raw bytes -> webview channel, one message per batch.
    //
    // A program flushes a single redraw in many small writes and the PTY hands
    // each one over the moment it lands. Emitting them one by one spreads one
    // redraw across several webview events, and the terminal paints each arrival
    // — a part-drawn frame every time. Draining the queue coalesces them without
    // waiting for anything: a batch only ever holds bytes that had already
    // arrived, so this costs no latency, only round trips.
    std::thread::Builder::new()
        .name(format!("pty-emit-{id}"))
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch = first;
                let deadline = Instant::now() + EMIT_BATCH_WINDOW;
                while batch.len() < EMIT_MAX {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(mut more) => {
                            batch.extend_from_slice(&more);
                            more.clear();
                            more.resize(READ_BUF, 0);
                            let _ = recycle_tx.try_send(more);
                        }
                        Err(_) => break,
                    }
                }
                if on_data.send(batch.clone()).is_err() {
                    break;
                }
                batch.clear();
                batch.resize(READ_BUF, 0);
                let _ = recycle_tx.try_send(batch);
            }
        })
        .map_err(err)?;

    // Waiter thread: report the exit status so the pane can show it.
    let exit_app = app.clone();
    let exit_id = id.clone();
    std::thread::Builder::new()
        .name(format!("pty-wait-{exit_id}"))
        .spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            let _ = exit_app.emit(
                &format!("pty:exit:{exit_id}"),
                ExitPayload { id: exit_id, code },
            );
        })
        .map_err(err)?;

    Ok(SpawnResult {
        id,
        shell_id: shell.id,
        shell_label: shell.label,
        program: shell.program,
        cwd: resolved_cwd,
    })
}

fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }
}
