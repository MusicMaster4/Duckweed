//! Headless coding-agent processes behind the custom agent UI.
//!
//! The terminal panes run agents as TUIs over a PTY. That is the right shape
//! for a terminal, but it gives the app nothing to render: the CLI paints
//! characters, not structure. Every agent we support also speaks a
//! line-delimited JSON protocol over plain pipes — Claude's `stream-json`,
//! Codex's `app-server`, and ACP for Cursor / Grok / OpenCode — and those
//! carry the reasoning, tool calls, and diffs the custom UI draws.
//!
//! This module is deliberately protocol-agnostic. It owns process lifetime and
//! framing (one JSON value per line, in both directions); the frontend owns
//! what those lines mean.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Cap on one protocol line handed to the webview. Agents stream file contents
/// and diffs inline, so the ceiling is generous — but a runaway line must not
/// be able to grow the webview message queue without bound.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Stderr is diagnostics, never protocol. Keep only enough to explain a failed
/// start; a chatty agent must not pin megabytes of logs in memory forever.
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentFrame {
    /// One protocol line from the agent's stdout.
    Stdout { line: String },
    /// One diagnostic line from the agent's stderr.
    Stderr { line: String },
    /// The process is gone; no further frames follow.
    Exit { code: Option<i32> },
}

#[derive(Serialize, Clone)]
pub struct AgentStarted {
    /// Executable actually resolved and launched, for error messages.
    pub program: String,
    pub pid: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct AgentAvailability {
    /// Candidate name the frontend asked about (`claude`, `codex`, …).
    pub name: String,
    /// Absolute path when the executable is on PATH, else null.
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct AgentSpawnOptions {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

struct Process {
    stdin: Option<ChildStdin>,
    child: Child,
    pid: Option<u32>,
}

#[derive(Default)]
struct AgentProcInner {
    processes: Mutex<HashMap<String, Arc<Mutex<Process>>>>,
}

#[derive(Clone, Default)]
pub struct AgentProcManager {
    inner: Arc<AgentProcInner>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl AgentProcManager {
    fn get(&self, id: &str) -> Option<Arc<Mutex<Process>>> {
        self.inner.processes.lock().unwrap().get(id).cloned()
    }

    /// Append one protocol line to the agent's stdin.
    ///
    /// The newline is added here so callers cannot half-frame a message: every
    /// protocol we speak treats a line break as the message boundary.
    pub fn send(&self, id: &str, line: &str) -> Result<(), String> {
        let handle = self
            .get(id)
            .ok_or_else(|| format!("no agent process `{id}`"))?;
        let mut process = handle.lock().unwrap();
        let stdin = process
            .stdin
            .as_mut()
            .ok_or_else(|| format!("agent process `{id}` has no stdin"))?;
        stdin.write_all(line.as_bytes()).map_err(err)?;
        stdin.write_all(b"\n").map_err(err)?;
        stdin.flush().map_err(err)
    }

    /// Close the agent's stdin without killing it.
    ///
    /// Claude's `--print` mode ends a session on EOF rather than on a control
    /// message, so this is a graceful stop rather than a kill.
    pub fn close_stdin(&self, id: &str) -> Result<(), String> {
        let Some(handle) = self.get(id) else {
            return Ok(());
        };
        handle.lock().unwrap().stdin.take();
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let handle = match self.inner.processes.lock().unwrap().remove(id) {
            Some(process) => process,
            // Stopping an agent that already exited is how every teardown path
            // ends; it is not an error.
            None => return Ok(()),
        };
        let mut process = handle.lock().unwrap();
        process.stdin.take();
        if let Some(pid) = process.pid {
            kill_tree(pid);
        }
        let _ = process.child.kill();
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.inner.processes.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
}

/// Kill the agent and everything it started.
///
/// Every supported agent is a launcher: npm shims re-exec node, Codex spawns
/// sandboxed children, and ACP agents keep worker processes. Killing only the
/// process we hold leaves those running with an orphaned pipe.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        hide_console(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        // Negative pid targets the process group created in `spawn`.
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW — an npm shim would otherwise flash a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// Every suffix Windows will treat as executable, most specific first.
#[cfg(windows)]
fn path_extensions() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(str::trim)
        .filter(|ext| ext.starts_with('.') && ext.len() > 1)
        .map(|ext| ext.to_ascii_lowercase())
        .collect()
}

/// Find `name` the way a shell would: an explicit path as given, otherwise the
/// first PATH entry that holds it.
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.components().count() > 1 {
        return resolve_direct(candidate);
    }

    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        if let Some(found) = resolve_direct(&dir.join(name)) {
            return Some(found);
        }
    }
    None
}

/// Resolve one concrete path, trying PATHEXT variants on Windows.
///
/// The extension variants are tried *before* the bare name, because npm
/// installs both: `…\npm\claude` is a POSIX shell script that Windows cannot
/// execute, and `…\npm\claude.cmd` beside it is the one that works. Preferring
/// the bare file finds a real file that then fails to spawn.
fn resolve_direct(candidate: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        for ext in path_extensions() {
            let mut name = OsString::from(candidate.as_os_str());
            name.push(&ext);
            let with_ext = PathBuf::from(name);
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    if candidate.is_file() {
        return Some(candidate.to_path_buf());
    }
    None
}

/// Which of the requested executables exist on this machine.
///
/// A PATH lookup rather than a `--version` run: the answer decides whether
/// typing `claude` opens the custom UI, so it has to be cheap enough to ask on
/// every keystroke-completed command and must never start a process.
pub fn probe(names: Vec<String>) -> Vec<AgentAvailability> {
    names
        .into_iter()
        .map(|name| {
            let path = resolve_program(&name).map(|p| p.to_string_lossy().to_string());
            AgentAvailability { name, path }
        })
        .collect()
}

/// Build the command for `program`, routing Windows batch shims through cmd.
///
/// `claude`, `codex`, and `opencode` all install as `.cmd` shims on Windows,
/// and CreateProcess cannot execute those directly.
fn build_command(resolved: &Path) -> Command {
    #[cfg(windows)]
    {
        let batch = resolved
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
        if batch {
            let mut command = Command::new("cmd");
            command.arg("/d").arg("/c").arg(resolved);
            return command;
        }
    }
    Command::new(resolved)
}

/// Launch an agent and stream its protocol lines to the webview.
pub fn start(
    manager: &AgentProcManager,
    on_frame: Channel<AgentFrame>,
    id: String,
    options: AgentSpawnOptions,
) -> Result<AgentStarted, String> {
    if manager.inner.processes.lock().unwrap().contains_key(&id) {
        return Err(format!("agent process `{id}` already exists"));
    }

    let resolved = resolve_program(&options.program)
        .ok_or_else(|| format!("`{}` was not found on PATH", options.program))?;

    let mut command = build_command(&resolved);
    for arg in &options.args {
        command.arg(arg);
    }
    if let Some(cwd) = options
        .cwd
        .filter(|p| !p.is_empty() && Path::new(p).is_dir())
    {
        command.current_dir(cwd);
    }
    // Agents check these to decide whether they are attached to a terminal.
    // Saying "no colour, not a TTY" is what keeps ANSI escapes out of the JSON
    // some of them emit on stderr.
    command.env("NO_COLOR", "1");
    command.env("TERM", "dumb");
    command.env("TERM_PROGRAM", "Duckweed");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if let Some(env) = options.env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group, so `kill_tree` can reach the agent's children.
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start `{}`: {error}", resolved.display()))?;
    let pid = Some(child.id());
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    manager.inner.processes.lock().unwrap().insert(
        id.clone(),
        Arc::new(Mutex::new(Process { stdin, child, pid })),
    );

    if let Some(stdout) = stdout {
        let channel = on_frame.clone();
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("agent-out-{thread_id}"))
            .spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(b'\n', &mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = trimmed_line(&buffer, MAX_LINE_BYTES);
                            if line.is_empty() {
                                continue;
                            }
                            if channel.send(AgentFrame::Stdout { line }).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(err)?;
    }

    if let Some(stderr) = stderr {
        let channel = on_frame.clone();
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("agent-err-{thread_id}"))
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(b'\n', &mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = trimmed_line(&buffer, MAX_STDERR_LINE_BYTES);
                            if line.is_empty() {
                                continue;
                            }
                            if channel.send(AgentFrame::Stderr { line }).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(err)?;
    }

    // Waiter thread: the UI needs the exit to close the session, and reaping
    // the child here keeps a finished agent from lingering as a zombie.
    let processes = Arc::clone(&manager_handle(manager, &id).ok_or("agent process vanished")?);
    let wait_id = id.clone();
    let channel = on_frame;
    std::thread::Builder::new()
        .name(format!("agent-wait-{wait_id}"))
        .spawn(move || {
            let code = loop {
                let status = {
                    let mut process = processes.lock().unwrap();
                    process.child.try_wait()
                };
                match status {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(60)),
                    Err(_) => break None,
                }
            };
            let _ = channel.send(AgentFrame::Exit { code });
        })
        .map_err(err)?;

    Ok(AgentStarted {
        program: resolved.to_string_lossy().to_string(),
        pid,
    })
}

fn manager_handle(manager: &AgentProcManager, id: &str) -> Option<Arc<Mutex<Process>>> {
    manager.inner.processes.lock().unwrap().get(id).cloned()
}

/// Decode one raw line, dropping the line terminator and any oversize tail.
fn trimmed_line(buffer: &[u8], limit: usize) -> String {
    let slice = &buffer[..buffer.len().min(limit)];
    String::from_utf8_lossy(slice).trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_line_terminator() {
        assert_eq!(trimmed_line(b"{\"a\":1}\r\n", MAX_LINE_BYTES), "{\"a\":1}");
        assert_eq!(trimmed_line(b"{\"a\":1}\n", MAX_LINE_BYTES), "{\"a\":1}");
        assert_eq!(trimmed_line(b"{\"a\":1}", MAX_LINE_BYTES), "{\"a\":1}");
    }

    #[test]
    fn truncates_a_runaway_line_instead_of_forwarding_it_whole() {
        let huge = vec![b'x'; 128];
        assert_eq!(trimmed_line(&huge, 16).len(), 16);
    }

    #[test]
    fn blank_lines_survive_as_empty_strings() {
        assert_eq!(trimmed_line(b"\n", MAX_LINE_BYTES), "");
        assert_eq!(trimmed_line(b"   \n", MAX_LINE_BYTES), "");
    }

    #[test]
    fn probing_a_nonexistent_binary_reports_no_path() {
        let found = probe(vec!["duckweed-not-a-real-agent".into()]);
        assert_eq!(found.len(), 1);
        assert!(found[0].path.is_none());
    }

    /// The whole spawn chain against a real agent, when one is installed:
    /// PATH resolution, the batch-shim detour through `cmd`, and one round
    /// trip of line-delimited JSON-RPC.
    ///
    /// This is the path that silently failed before `resolve_direct` learned
    /// to prefer `codex.cmd` over the extensionless npm shim beside it, and a
    /// unit test on resolution order alone would not have caught it.
    #[test]
    fn spawns_an_installed_agent_and_reads_a_protocol_line() {
        use std::io::{BufRead, BufReader, Write};

        let Some(resolved) = resolve_program("codex") else {
            eprintln!("codex is not installed; skipping the live spawn check");
            return;
        };

        let mut command = build_command(&resolved);
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_console(&mut command);
        let mut child = command.spawn().expect("agent should spawn");

        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(
                br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"duckweed","title":"Duckweed","version":"0.1.0"}}}"#,
            )
            .unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();

        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .expect("agent should answer initialize");
        let _ = child.kill();

        assert!(line.contains("\"id\":1"), "unexpected reply: {line}");
    }

    /// npm drops a POSIX shell script next to the `.cmd` shim under the same
    /// name. Windows can only execute the latter, so resolution must not stop
    /// at the first file that happens to exist.
    #[cfg(windows)]
    #[test]
    fn windows_resolution_prefers_the_executable_over_a_bare_shim() {
        let dir = std::env::temp_dir().join("duckweed-resolve-test");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("faux-agent");
        let executable = dir.join("faux-agent.cmd");
        std::fs::write(&shim, b"#!/bin/sh\n").unwrap();
        std::fs::write(&executable, b"@echo off\n").unwrap();

        assert_eq!(resolve_direct(&shim), Some(executable));

        std::fs::remove_file(&shim).unwrap();
        std::fs::remove_file(&dir.join("faux-agent.cmd")).unwrap();
    }
}
