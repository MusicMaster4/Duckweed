//! PTY session management.
//!
//! Every terminal pane in the UI owns one session here. Output is streamed to
//! the webview as base64 chunks on a per-session event channel
//! (`pty:data:<id>`) so panes never see each other's bytes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::shells;

/// How much PTY output we buffer before flushing an event to the webview.
const READ_BUF: usize = 16 * 1024;

pub struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cols: u16,
    rows: u16,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
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

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl PtyManager {
    fn insert(&self, id: String, session: Session) {
        self.sessions.lock().unwrap().insert(id, session);
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard
            .get_mut(id)
            .ok_or_else(|| format!("no pty session `{id}`"))?;
        session.writer.write_all(data).map_err(err)?;
        session.writer.flush().map_err(err)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.max(2);
        let rows = rows.max(1);
        let mut guard = self.sessions.lock().unwrap();
        let session = guard
            .get_mut(id)
            .ok_or_else(|| format!("no pty session `{id}`"))?;
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
        let mut session = match self.sessions.lock().unwrap().remove(id) {
            Some(s) => s,
            // Killing an already-dead pane is not an error; the UI does it on
            // every pane close, including panes whose shell already exited.
            None => return Ok(()),
        };
        let _ = session.killer.kill();
        let _ = session.writer.flush();
        Ok(())
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

/// Spawn a shell attached to a fresh PTY and start streaming its output.
pub fn spawn(
    app: &AppHandle,
    manager: &PtyManager,
    id: String,
    cwd: Option<String>,
    shell_id: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnResult, String> {
    if manager.sessions.lock().unwrap().contains_key(&id) {
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
    for arg in &shell.args {
        cmd.arg(arg);
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
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    let killer = child.clone_killer();
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
            cols,
            rows,
        },
    );

    // Reader thread: PTY bytes -> base64 -> webview event.
    let data_event = format!("pty:data:{id}");
    let reader_app = app.clone();
    std::thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        if reader_app.emit(&data_event, encoded).is_err() {
                            break;
                        }
                    }
                }
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
