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

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use crate::automatic_approval::{Policy as ApprovalPolicy, Queue as ApprovalQueue};

/// Cap on one protocol line handed to the webview. Agents stream file contents
/// and diffs inline, so the ceiling is generous — but a runaway line must not
/// be able to grow the webview message queue without bound.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Cap on one WebSocket message from the shared Codex service. A message over
/// it is a protocol error that ends the whole connection, so it must sit well
/// above any legitimate response: `plugin/list` alone returns the full remote
/// catalog, already over 11 MB. Messages over `MAX_LINE_BYTES` are still kept
/// out of the webview; this only decides whether the session survives them.
const MAX_CODEX_MESSAGE_BYTES: usize = 256 * 1024 * 1024;

/// Stderr is diagnostics, never protocol. Keep only enough to explain a failed
/// start; a chatty agent must not pin megabytes of logs in memory forever.
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentFrame {
    /// Ordered native delivery, retained briefly for renderer reattachment.
    Sequenced { sequence: u64, frame: Box<AgentFrame> },
    /// One protocol line from the agent's stdout.
    Stdout { line: String },
    /// One diagnostic line from the agent's stderr.
    Stderr { line: String },
    /// A permission was answered by native code while the renderer may be asleep.
    AutomaticApproval { permission_id: String, option_id: String },
    /// The process is gone; no further frames follow.
    Exit { code: Option<i32>, reconnect: bool },
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

#[derive(Deserialize, Clone)]
pub struct AgentSpawnOptions {
    pub program: String,
    pub renderer_recovery_id: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

struct Process {
    stdin: Option<Arc<Mutex<ProcessInput>>>,
    child: Child,
    pid: Option<u32>,
    runtime_roots: Vec<u32>,
    ownership: CodexOwnership,
    service: Option<crate::codex_transport::Service>,
    reconnect_on_exit: bool,
    approvals: Arc<Mutex<ApprovalQueue>>,
    channel: Arc<Mutex<AgentDelivery>>,
}

const MAX_REPLAY_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLAY_FRAMES: usize = 16_384;

struct AgentDelivery {
    channel: Option<Channel<AgentFrame>>,
    replayable: bool,
    instance_id: Option<String>,
    sequence: u64,
    replay_after: u64,
    frames: VecDeque<(u64, AgentFrame, usize)>,
    bytes: usize,
}

impl AgentDelivery {
    fn new(channel: Channel<AgentFrame>, instance_id: Option<String>) -> Self {
        Self { channel: Some(channel), replayable: instance_id.is_some(), instance_id, sequence: 0, replay_after: 0, frames: VecDeque::new(), bytes: 0 }
    }

    fn send(&mut self, frame: AgentFrame) -> Result<(), tauri::Error> {
        if !self.replayable {
            return self.channel.as_ref().map_or(Ok(()), |channel| channel.send(frame));
        }
        self.sequence += 1;
        let bytes = match &frame {
            AgentFrame::Stdout { line } | AgentFrame::Stderr { line } => line.len(),
            _ => 128,
        };
        self.frames.push_back((self.sequence, frame.clone(), bytes));
        self.bytes += bytes;
        while self.bytes > MAX_REPLAY_BYTES || self.frames.len() > MAX_REPLAY_FRAMES {
            let (sequence, _, bytes) = self.frames.pop_front().unwrap();
            self.bytes -= bytes;
            self.replay_after = sequence;
        }
        if let Some(channel) = &self.channel {
            if channel.send(AgentFrame::Sequenced { sequence: self.sequence, frame: Box::new(frame) }).is_err() {
                self.channel = None;
            }
        }
        // A vanished renderer must never close a live agent's output pipe.
        Ok(())
    }

    fn checkpoint_saved(&mut self, sequence: u64) {
        if sequence > self.sequence || sequence < self.replay_after { return; }
        while self.frames.front().is_some_and(|(current, _, _)| *current <= sequence) {
            let (_, _, bytes) = self.frames.pop_front().unwrap();
            self.bytes -= bytes;
        }
        self.replay_after = sequence;
    }

    fn attach(&mut self, sequence: u64, channel: Channel<AgentFrame>) -> Result<(), String> {
        if !self.replayable || sequence > self.sequence || sequence < self.replay_after {
            return Err("The live agent is still running, but its renderer checkpoint is too old to reconnect safely.".into());
        }
        for (current, frame, _) in &self.frames {
            if *current > sequence {
                channel.send(AgentFrame::Sequenced { sequence: *current, frame: Box::new(frame.clone()) }).map_err(err)?;
            }
        }
        self.channel = Some(channel);
        Ok(())
    }
}

/// Track only conversations addressed by this connection. A shared service
/// can broadcast unrelated thread notifications belonging to other clients.
#[derive(Default)]
struct CodexOwnership {
    threads: HashMap<String, Option<String>>,
    starts: HashMap<String, Option<String>>,
    unsubscribes: HashMap<String, String>,
    closing: HashSet<String>,
}

impl CodexOwnership {
    fn sent(&mut self, line: &str) {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        let method = frame["method"].as_str().unwrap_or_default();
        let thread = frame["params"]["threadId"].as_str().map(str::to_owned);
        if matches!(
            method,
            "thread/start" | "thread/resume" | "thread/fork" | "turn/start"
        ) {
            self.starts.insert(
                frame["id"].to_string(),
                if method == "turn/start" {
                    thread.clone()
                } else {
                    None
                },
            );
        }
        if let Some(thread) = thread {
            if method == "thread/unsubscribe" {
                let id = frame["id"].to_string();
                self.closing.insert(id.clone());
                self.unsubscribes.insert(id, thread);
            } else if matches!(method, "turn/start" | "thread/shellCommand" | "thread/resume") {
                self.threads.entry(thread).or_default();
            }
        }
    }

    /// Update ownership and report account changes from the same parse. Large
    /// transcript responses should not be deserialized again just to inspect
    /// their top-level method.
    fn received(&mut self, line: &str) -> bool {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        let account_updated = frame["method"] == "account/updated";
        if let Some(id) = frame.get("id") {
            let key = id.to_string();
            self.closing.remove(&key);
            if let Some(thread) = self.unsubscribes.remove(&key) {
                if frame.get("error").is_none() {
                    self.threads.remove(&thread);
                }
            }
            if let Some(start) = self.starts.remove(&key) {
                if let Some(thread) = frame["result"]["thread"]["id"].as_str() {
                    let active = frame["result"]["thread"]["activeTurnId"].as_str().map(str::to_owned)
                        .or_else(|| frame["result"]["thread"]["turns"].as_array().and_then(|turns| {
                            turns.iter().rev().find(|turn| turn["status"] == "inProgress")
                                .and_then(|turn| turn["id"].as_str()).map(str::to_owned)
                        }))
                        .or_else(|| frame["result"]["initialTurnsPage"]["data"].as_array().and_then(|turns| {
                            turns.iter().find(|turn| turn["status"] == "inProgress")
                                .and_then(|turn| turn["id"].as_str()).map(str::to_owned)
                        }));
                    let turn = self.threads.entry(thread.to_owned()).or_default();
                    if active.is_some() { *turn = active; }
                } else if let (Some(thread), Some(turn)) =
                    (start, frame["result"]["turn"]["id"].as_str())
                {
                    if let Some(active) = self.threads.get_mut(&thread) {
                        *active = Some(turn.to_owned());
                    }
                }
            }
            return account_updated;
        }
        let method = frame["method"].as_str().unwrap_or_default();
        let params = &frame["params"];
        if method == "thread/started" {
            if let (Some(parent), Some(child)) = (
                params["thread"]["parentThreadId"].as_str(),
                params["thread"]["id"].as_str(),
            ) {
                if self.threads.contains_key(parent) {
                    self.threads.entry(child.to_owned()).or_default();
                }
            }
        }
        if let Some(thread) = params["threadId"].as_str() {
            if self.threads.contains_key(thread)
                && matches!(
                    params["item"]["type"].as_str(),
                    Some("collabAgentToolCall" | "collabToolCall")
                )
            {
                if let Some(children) = params["item"]["receiverThreadIds"].as_array() {
                    for child in children.iter().filter_map(|child| child.as_str()) {
                        self.threads.entry(child.to_owned()).or_default();
                    }
                }
            }
            if method == "thread/closed" {
                self.threads.remove(thread);
            } else if let Some(turn) = self.threads.get_mut(thread) {
                if method == "turn/started" {
                    *turn = params["turn"]["id"].as_str().map(str::to_owned);
                }
                if method == "turn/completed" {
                    *turn = None;
                }
            }
        }
        account_updated
    }

    fn shutdown_requests(&self) -> Vec<serde_json::Value> {
        let mut requests = Vec::new();
        for (thread, turn) in &self.threads {
            requests.push(serde_json::json!({"method":"thread/goal/set","params":{"threadId":thread,"status":"paused"}}));
            if let Some(turn) = turn {
                requests.push(serde_json::json!({"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}}));
            }
            requests.push(serde_json::json!({"method":"thread/backgroundTerminals/clean","params":{"threadId":thread}}));
            requests.push(
                serde_json::json!({"method":"thread/unsubscribe","params":{"threadId":thread}}),
            );
        }
        for (index, request) in requests.iter_mut().enumerate() {
            request["id"] = serde_json::json!(format!("duckweed-shutdown-{index}"));
        }
        requests
    }
}

enum ProcessInput {
    JsonLines(ChildStdin),
    Codex(tungstenite::WebSocket<crate::codex_transport::ProxyWriter>),
}

impl ProcessInput {
    fn send(&mut self, line: &str) -> Result<(), String> {
        match self {
            Self::JsonLines(stdin) => {
                stdin.write_all(line.as_bytes()).map_err(err)?;
                stdin.write_all(b"\n").map_err(err)?;
                stdin.flush().map_err(err)
            }
            Self::Codex(writer) => crate::codex_transport::send(writer, line),
        }
    }
}

#[derive(Default)]
struct AgentProcInner {
    processes: Mutex<HashMap<String, Arc<Mutex<Process>>>>,
    approval_policy: Mutex<ApprovalPolicy>,
    protocol_frames: AtomicU64,
    protocol_bytes: AtomicU64,
}

#[derive(Clone, Default)]
pub struct AgentProcManager {
    inner: Arc<AgentProcInner>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl AgentProcManager {
    pub fn set_automatic_approval(&self, setting: &serde_json::Value) {
        self.inner.approval_policy.lock().unwrap().set(setting);
    }

    /// Native timers and pipe writes remain live when WebView2 throttles or
    /// suspends the renderer. Every process, including later launches, shares policy.
    pub fn start_approval_monitor(&self) {
        let weak = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let handles = inner
                    .processes
                    .lock()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                for handle in handles {
                    let approvals = handle.lock().unwrap().approvals.clone();
                    let due = {
                        let policy = inner.approval_policy.lock().unwrap();
                        let due = approvals.lock().unwrap().due(&policy, Instant::now());
                        due
                    };
                    for decision in due {
                        let handle = handle.clone();
                        let inner = inner.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let (stdin, approvals, channel) = {
                                let process = handle.lock().unwrap();
                                (
                                    process.stdin.clone(),
                                    process.approvals.clone(),
                                    process.channel.clone(),
                                )
                            };
                            let Some(stdin) = stdin else {
                                return;
                            };
                            let mut input = stdin.lock().unwrap();
                            // Recheck after waiting for another writer. Stop, expiry,
                            // disabling or a manual response may have won meanwhile.
                            {
                                let policy = inner.approval_policy.lock().unwrap();
                                if !approvals.lock().unwrap().claim(
                                    &decision.key,
                                    &policy,
                                    Instant::now(),
                                ) {
                                    return;
                                }
                            }
                            let result = input.send(&decision.reply.to_string());
                            drop(input);
                            match result {
                                Ok(()) => {
                                    let _ = channel.lock().unwrap().send(AgentFrame::AutomaticApproval {
                                        permission_id: decision.permission_id,
                                        option_id: decision.option_id,
                                    });
                                }
                                Err(error) => {
                                    let _ = channel.lock().unwrap().send(AgentFrame::Stderr {
                                        line: format!(
                                            "Automatic approval could not reach the agent: {error}"
                                        ),
                                    });
                                }
                            }
                        });
                    }
                }
            }
        });
    }
    pub fn synchronize_codex_auth(&self, id: &str, signed_in: bool) -> Result<String, String> {
        let service = self
            .get(id)
            .and_then(|process| process.lock().unwrap().service.clone());
        let Some(service) = service else {
            return Ok("unchanged".into());
        };
        crate::codex_transport::synchronize(&service, signed_in, || {
            for process in self.inner.processes.lock().unwrap().values() {
                let mut process = process.lock().unwrap();
                if process
                    .service
                    .as_ref()
                    .is_some_and(|other| other.home == service.home)
                {
                    process.reconnect_on_exit = true;
                    if let Some(service) = &process.service {
                        service.reconnecting.store(true, Ordering::Relaxed);
                    }
                }
            }
        })
        .map(str::to_owned)
    }
    pub fn interrupt_codex(&self, id: &str) -> Result<(), String> {
        let handle = self.get(id).ok_or_else(|| format!("no agent process `{id}`"))?;
        let (service, threads) = {
            let process = handle.lock().unwrap();
            (process.service.clone(), process.ownership.threads.iter()
                .map(|(thread, turn)| (thread.clone(), turn.clone())).collect::<Vec<_>>())
        };
        match service {
            Some(service) => crate::codex_transport::interrupt_threads(&service, &threads),
            // A private app-server has no shared work to preserve. Killing its
            // process tree is the backstop when the protocol stops answering.
            None => self.stop(id),
        }
    }

    pub fn set_runtime_roots(&self, id: &str, pids: Vec<u32>) {
        if let Some(process) = self.get(id) {
            process.lock().unwrap().runtime_roots =
                pids.into_iter().filter(|pid| *pid > 0).take(256).collect();
        }
    }
    fn get(&self, id: &str) -> Option<Arc<Mutex<Process>>> {
        self.inner.processes.lock().unwrap().get(id).cloned()
    }

    /// Number of coding-agent sessions currently owned by the custom UI.
    pub fn open_count(&self) -> usize {
        self.inner.processes.lock().unwrap().len()
    }

    /// Aggregate protocol traffic since this Duckweed process started.
    /// Content is deliberately not retained; crash diagnostics only need the
    /// volume that preceded a renderer failure.
    #[cfg(windows)]
    pub fn traffic_totals(&self) -> (u64, u64) {
        (
            self.inner.protocol_frames.load(Ordering::Relaxed),
            self.inner.protocol_bytes.load(Ordering::Relaxed),
        )
    }

    /// Append one protocol line to the agent's stdin.
    ///
    /// The newline is added here so callers cannot half-frame a message: every
    /// protocol we speak treats a line break as the message boundary.
    pub fn send(&self, id: &str, line: &str) -> Result<(), String> {
        let handle = self
            .get(id)
            .ok_or_else(|| format!("no agent process `{id}`"))?;
        let stdin = {
            let mut process = handle.lock().unwrap();
            let stdin = process.stdin.clone()
                .ok_or_else(|| format!("agent process `{id}` has no stdin"))?;
            if !process.approvals.lock().unwrap().outgoing(line) { return Ok(()); }
            // Register before writing: a fast reply can beat the write's return.
            if process.service.is_some() { process.ownership.sent(line); }
            stdin
        };
        // A full stdin pipe must never hold the process lock. The stdout reader
        // needs that lock to deliver replies, and Stop needs it to kill a wedged
        // proxy. Holding it across write_all creates a duplex pipe deadlock.
        let mut input = stdin.lock().unwrap();
        input.send(line).map_err(|error| {
            if matches!(*input, ProcessInput::Codex(_)) {
                format!("duckweed_connection_closed: {error}")
            } else {
                error
            }
        })
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
        self.stop_inner(id, false)
    }

    /// Drop only our shared-service proxy during recovery. Its turns, goals and
    /// background terminals belong to the daemon and must survive reconnection.
    pub fn disconnect(&self, id: &str) -> Result<(), String> {
        self.stop_inner(id, true)
    }

    fn stop_inner(&self, id: &str, preserve_codex_work: bool) -> Result<(), String> {
        let handle = match self.inner.processes.lock().unwrap().remove(id) {
            Some(process) => process,
            // Stopping an agent that already exited is how every teardown path
            // ends; it is not an error.
            None => return Ok(()),
        };
        Self::stop_handle(handle, preserve_codex_work)
    }

    /// Finish stopping a process already removed from the registry.
    fn stop_handle(handle: Arc<Mutex<Process>>, preserve_codex_work: bool) -> Result<(), String> {
        let (stdin, requests, service, threads) = {
            let mut process = handle.lock().unwrap();
            process.approvals.lock().unwrap().clear();
            if preserve_codex_work && process.service.is_some() {
                process.stdin.take();
                if let Some(pid) = process.pid { kill_tree(pid); }
                let _ = process.child.kill();
                return Ok(());
            }
            let requests = process.ownership.shutdown_requests();
            for frame in &requests {
                process.ownership.closing.insert(frame["id"].to_string());
            }
            let threads = process.ownership.threads.iter()
                .map(|(thread, turn)| (thread.clone(), turn.clone())).collect::<Vec<_>>();
            (process.stdin.take(), requests, process.service.clone(), threads)
        };
        // Cleanup also runs after the WebView disappears. Bound even the write
        // itself, not just the response wait, so backpressure cannot trap Stop.
        let (done, wait) = mpsc::channel();
        if let Some(stdin) = stdin {
            thread::spawn(move || {
                let mut input = stdin.lock().unwrap();
                for frame in requests {
                    if input.send(&frame.to_string()).is_err() { break; }
                }
                let _ = done.send(());
            });
        }
        let deadline = Instant::now() + Duration::from_millis(250);
        let _ = wait.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        while !handle.lock().unwrap().ownership.closing.is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let mut process = handle.lock().unwrap();
        let cleanup_unconfirmed = !process.ownership.closing.is_empty();
        if let Some(pid) = process.pid {
            kill_tree(pid);
        }
        let _ = process.child.kill();
        drop(process);
        if cleanup_unconfirmed {
            if let Some(service) = service {
                return crate::codex_transport::interrupt_threads(&service, &threads);
            }
        }
        Ok(())
    }

    /// A renderer failure is not a user Stop. Shared-service work must remain
    /// live while the new document reconnects to its original conversations.
    #[cfg(any(windows, test))]
    pub fn recover_renderer(&self) {
        let ids: Vec<String> = self.inner.processes.lock().unwrap().keys().cloned().collect();
        let mut stale = Vec::new();
        for id in ids {
            let Some(handle) = self.get(&id) else { continue; };
            let delivery = handle.lock().unwrap().channel.clone();
            let mut delivery = delivery.lock().unwrap();
            if delivery.replayable {
                delivery.channel = None;
            } else {
                stale.push(id);
            }
        }
        // This runs on the UI thread, inside WebView2's failure callback. Free
        // the ids now so the reloaded document can start replacements, but kill
        // the old process trees elsewhere: `taskkill` can take seconds, or never
        // return, on a machine that is already out of memory.
        let handles: Vec<_> = {
            let mut processes = self.inner.processes.lock().unwrap();
            stale.iter().filter_map(|id| processes.remove(id)).collect()
        };
        if handles.is_empty() { return; }
        let cleanup = thread::Builder::new().name("agent-renderer-recovery".into()).spawn(move || {
            for handle in handles {
                let _ = Self::stop_handle(handle, true);
            }
        });
        if let Err(error) = cleanup {
            eprintln!("duckweed: could not clean up agents after a renderer failure: {error}");
        }
    }

    /// Frames become dispensable only after their matching adapter state is on disk.
    pub fn checkpoint_saved(&self, id: &str, instance_id: &str, sequence: u64) {
        if let Some(handle) = self.get(id) {
            let delivery = handle.lock().unwrap().channel.clone();
            let mut delivery = delivery.lock().unwrap();
            if delivery.instance_id.as_deref() == Some(instance_id) { delivery.checkpoint_saved(sequence); }
        }
    }

    /// Newest frame produced for a replayable renderer. A renderer that stays
    /// behind it is not receiving its channel and must reattach.
    pub fn sequence(&self, id: &str, instance_id: &str) -> Option<u64> {
        let handle = self.get(id)?;
        let delivery = handle.lock().unwrap().channel.clone();
        let delivery = delivery.lock().unwrap();
        (delivery.instance_id.as_deref() == Some(instance_id)).then_some(delivery.sequence)
    }

    /// Atomically replace a lost renderer channel and replay only newer frames.
    pub fn attach(&self, id: &str, instance_id: &str, sequence: u64, channel: Channel<AgentFrame>) -> Result<bool, String> {
        let Some(handle) = self.get(id) else { return Ok(false); };
        let delivery = handle.lock().unwrap().channel.clone();
        let mut delivery = delivery.lock().unwrap();
        if delivery.instance_id.as_deref() != Some(instance_id) {
            return Err("This pane's live agent has changed. Its current process has been kept running.".into());
        }
        delivery.attach(sequence, channel)?;
        Ok(true)
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self
            .inner
            .processes
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    /// Headless agent roots keyed by terminal id. An agent may open a preview
    /// server without involving the shell that remains underneath its UI.
    pub fn root_processes(&self) -> Vec<(String, u32)> {
        self.inner
            .processes
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(id, process)| {
                let process = process.lock().unwrap();
                process
                    .pid
                    .into_iter()
                    .chain(process.runtime_roots.iter().copied())
                    .map(|pid| (id.clone(), pid))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}

/// Kill the agent and everything it started.
///
/// Every supported agent is a launcher: npm shims re-exec node, Codex spawns
/// sandboxed children, and ACP agents keep worker processes. Killing only the
/// process we hold leaves those running with an orphaned pipe.
pub(crate) fn kill_tree(pid: u32) {
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

/// Ties process trees to the lifetime of this process.
///
/// `stop_all` only runs on a clean exit. When Duckweed crashes or is ended as
/// "not responding", its agents used to keep running with nobody reading them,
/// together with every shell and worker they had started. The next launch then
/// resumed the same conversations in new processes, so each crash doubled the
/// agents working on a session. Windows closes the job handle whenever this
/// process ends, however it ends, and that terminates every member.
#[cfg(windows)]
struct KillOnExitJob(usize);

#[cfg(windows)]
impl KillOnExitJob {
    fn new() -> Option<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Self(job as usize))
        }
    }

    /// Later descendants join automatically. Failure leaves the child untied,
    /// which is the previous behavior, so it is not an error.
    fn adopt(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            AssignProcessToJobObject(self.0 as _, child.as_raw_handle() as _);
        }
    }
}

#[cfg(windows)]
impl Drop for KillOnExitJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

/// End `child` and its descendants when Duckweed itself goes away.
#[cfg(windows)]
fn kill_with_app(child: &Child) {
    static JOB: std::sync::OnceLock<Option<KillOnExitJob>> = std::sync::OnceLock::new();
    if let Some(job) = JOB.get_or_init(KillOnExitJob::new) {
        job.adopt(child);
    }
}

#[cfg(not(windows))]
fn kill_with_app(_child: &Child) {}

#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW — an npm shim would otherwise flash a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

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

/// Refresh OpenCode's models.dev cache before its ACP session advertises the
/// model picker. Filtering the command to OpenRouter keeps its otherwise large
/// stdout small; `--refresh` still updates OpenCode's shared model cache first.
pub fn refresh_opencode_models() -> Result<(), String> {
    let resolved = resolve_program("opencode")
        .ok_or_else(|| "`opencode` was not found on PATH".to_string())?;
    let mut command = build_command(&resolved);
    command.args(["models", "openrouter", "--refresh"]);
    command
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("TERM_PROGRAM", "Duckweed")
        .env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start `{}`: {error}", resolved.display()))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait().map_err(err)? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                return Err(format!(
                    "OpenCode model refresh exited with {}",
                    status
                        .code()
                        .map_or_else(|| "an error".into(), |code| code.to_string())
                ));
            }
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("OpenCode model refresh timed out after 30 seconds".into());
            }
        }
    }
}

/// Build the command for `program`, routing Windows batch shims through cmd.
///
/// `claude`, `codex`, and `opencode` all install as `.cmd` shims on Windows,
/// and CreateProcess cannot execute those directly.
pub(crate) fn build_command(resolved: &Path) -> Command {
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

    let shared = crate::codex_transport::connect(&resolved, &options, MAX_CODEX_MESSAGE_BYTES)?;

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

    let (mut child, shared_reader, shared_writer, service) = match shared {
        Some(connection) => (
            connection.child,
            Some(connection.reader),
            Some(connection.writer),
            Some(connection.service),
        ),
        None => {
            let child = command
                .spawn()
                .map_err(|error| format!("failed to start `{}`: {error}", resolved.display()))?;
            // Not the shared Codex proxy above: its daemon owns work that is
            // meant to outlive this window.
            kill_with_app(&child);
            (child, None, None, None)
        }
    };
    let pid = Some(child.id());
    let stdin = shared_writer
        .map(ProcessInput::Codex)
        .or_else(|| child.stdin.take().map(ProcessInput::JsonLines))
        .map(|input| Arc::new(Mutex::new(input)));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    manager.inner.processes.lock().unwrap().insert(
        id.clone(),
        Arc::new(Mutex::new(Process {
            stdin,
            child,
            pid,
            runtime_roots: Vec::new(),
            ownership: CodexOwnership::default(),
            service,
            reconnect_on_exit: false,
            approvals: Arc::new(Mutex::new(ApprovalQueue::default())),
            channel: Arc::new(Mutex::new(AgentDelivery::new(on_frame, options.renderer_recovery_id))),
        })),
    );

    if let Some(mut reader) = shared_reader {
        let channel = manager.get(&id).ok_or("Agent process disappeared")?.lock().unwrap().channel.clone();
        let metrics = Arc::clone(&manager.inner);
        let process = manager.get(&id).ok_or("Codex proxy disappeared")?;
        std::thread::Builder::new()
            .name(format!("agent-codex-{id}"))
            .spawn(move || {
                loop {
                    let message = match reader.read() {
                        Ok(message) => message,
                        Err(error) => {
                            if !matches!(
                                error,
                                tungstenite::Error::ConnectionClosed
                                    | tungstenite::Error::AlreadyClosed
                            ) {
                                let _ = channel.lock().unwrap().send(AgentFrame::Stderr {
                                    line: format!("Codex service connection ended: {error}"),
                                });
                            }
                            break;
                        }
                    };
                    match message {
                        tungstenite::Message::Text(line) if line.len() > MAX_LINE_BYTES => {
                            let _ = channel.lock().unwrap().send(AgentFrame::Stderr {
                                line: format!(
                                    "Dropped a {} byte Codex message over the {MAX_LINE_BYTES} byte limit.",
                                    line.len()
                                ),
                            });
                            if let Some(reply) =
                                crate::codex_transport::oversized_reply(&line, MAX_LINE_BYTES)
                            {
                                process.lock().unwrap().ownership.received(&reply);
                                if channel.lock().unwrap().send(AgentFrame::Stdout { line: reply }).is_err() {
                                    break;
                                }
                            }
                        }
                        tungstenite::Message::Text(line) => {
                            {
                                let mut process = process.lock().unwrap();
                                if process.ownership.received(&line) {
                                    if let Some(service) = &process.service {
                                        service.acknowledge();
                                    }
                                }
                            }
                            let bytes = line.len() as u64;
                            if deliver_stdout(&process, &channel, line.to_string()).is_err() { break; }
                            metrics.protocol_frames.fetch_add(1, Ordering::Relaxed);
                            metrics.protocol_bytes.fetch_add(bytes, Ordering::Relaxed);
                        }
                        tungstenite::Message::Close(_) => break,
                        // Reading schedules protocol replies. Flush even when an
                        // idle service sends only a ping and no subsequent data.
                        tungstenite::Message::Ping(_) => {
                            if reader.flush().is_err() {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(pid) = pid {
                    kill_tree(pid);
                }
            })
            .map_err(err)?;
    } else if let Some(stdout) = stdout {
        let channel = manager.get(&id).ok_or("Agent process disappeared")?.lock().unwrap().channel.clone();
        let metrics = Arc::clone(&manager.inner);
        let thread_id = id.clone();
        let process = manager.get(&id).ok_or("Agent process disappeared")?;
        std::thread::Builder::new()
            .name(format!("agent-out-{thread_id}"))
            .spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let mut buffer = Vec::new();
                loop {
                    match read_bounded_line(&mut reader, &mut buffer, MAX_LINE_BYTES) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = trimmed_line(&buffer, MAX_LINE_BYTES);
                            if line.is_empty() {
                                continue;
                            }
                            let bytes = line.len() as u64;
                            if deliver_stdout(&process, &channel, line).is_err() { break; }
                            metrics.protocol_frames.fetch_add(1, Ordering::Relaxed);
                            metrics.protocol_bytes.fetch_add(bytes, Ordering::Relaxed);
                        }
                    }
                }
            })
            .map_err(err)?;
    }

    if let Some(stderr) = stderr {
        let channel = manager.get(&id).ok_or("Agent process disappeared")?.lock().unwrap().channel.clone();
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("agent-err-{thread_id}"))
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buffer = Vec::new();
                loop {
                    match read_bounded_line(&mut reader, &mut buffer, MAX_STDERR_LINE_BYTES) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = trimmed_line(&buffer, MAX_STDERR_LINE_BYTES);
                            if line.is_empty() {
                                continue;
                            }
                            if channel.lock().unwrap().send(AgentFrame::Stderr { line }).is_err() {
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
    let channel = processes.lock().unwrap().channel.clone();
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
            let mut process = processes.lock().unwrap();
            process.stdin.take();
            process.approvals.lock().unwrap().clear();
            // A proxy can exit during daemon maintenance or lose its local
            // connection while provider-owned work is still running.
            let reconnect = process.reconnect_on_exit || process.service.is_some();
            drop(process);
            let _ = channel.lock().unwrap().send(AgentFrame::Exit { code, reconnect });
        })
        .map_err(err)?;

    Ok(AgentStarted {
        program: resolved.to_string_lossy().to_string(),
        pid,
    })
}

/// Publish the request before the monitor can publish its acknowledgement.
fn deliver_stdout(
    process: &Arc<Mutex<Process>>,
    channel: &Arc<Mutex<AgentDelivery>>,
    line: String,
) -> Result<(), tauri::Error> {
    let queue = process.lock().unwrap().approvals.clone();
    let mut queue = queue.lock().unwrap();
    queue.observe(&line);
    channel.lock().unwrap().send(AgentFrame::Stdout { line })
}

fn manager_handle(manager: &AgentProcManager, id: &str) -> Option<Arc<Mutex<Process>>> {
    manager.inner.processes.lock().unwrap().get(id).cloned()
}

/// Read through one complete line while retaining at most `limit` bytes.
///
/// `BufRead::read_until` only lets callers truncate after the delimiter is
/// found, so a malformed or very large JSON response could allocate the whole
/// line first. Codex child hydration returns full transcripts on one JSONL
/// line, making that behavior especially costly when several children finish
/// together. This reader keeps the retained buffer bounded and drains the tail
/// in the `BufReader`'s fixed-size chunks.
fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<usize> {
    buffer.clear();
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(total);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let retained = consumed.min(limit.saturating_sub(buffer.len()));
        buffer.extend_from_slice(&available[..retained]);
        reader.consume(consumed);
        total = total.saturating_add(consumed);
        if newline.is_some() {
            return Ok(total);
        }
    }
}

/// Decode one raw line, dropping the line terminator and any oversize tail.
fn trimmed_line(buffer: &[u8], limit: usize) -> String {
    let slice = &buffer[..buffer.len().min(limit)];
    String::from_utf8_lossy(slice).trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn agents_and_their_children_end_when_the_app_handle_closes() {
        let mut command = Command::new("cmd");
        // The shell stays as the parent of a second, long-lived process.
        command.args(["/d", "/c", "ping -n 60 127.0.0.1 >nul & exit"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_console(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let job = KillOnExitJob::new().unwrap();
        job.adopt(&child);
        let descendant = || crate::process_tree::process_snapshot().into_iter()
            .find(|process| process.ppid == pid).map(|process| process.pid);
        let deadline = Instant::now() + Duration::from_secs(10);
        let grandchild = loop {
            if let Some(found) = descendant() { break found; }
            assert!(Instant::now() < deadline, "the shell never started its child");
            thread::sleep(Duration::from_millis(20));
        };
        // What Windows does to the handle when Duckweed crashes or is killed.
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none()
            || crate::process_tree::process_snapshot().iter().any(|process| process.pid == grandchild)
        {
            if Instant::now() >= deadline { kill_tree(pid); panic!("the agent tree outlived the app"); }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn account_changes_are_reported_without_affecting_ownership() {
        let mut owner = CodexOwnership::default();
        assert!(owner.received(r#"{"method":"account/updated","params":{"authMode":"chatgpt"}}"#));
        assert!(!owner.received(r#"{"method":"account/rateLimits/updated","params":{}}"#));
        assert!(!owner.received("invalid json"));
        assert!(owner.threads.is_empty());
    }

    #[test]
    fn shared_shutdown_owns_only_subscribed_threads_and_their_children() {
        let mut owner = CodexOwnership::default();
        owner.sent(r#"{"id":1,"method":"thread/start","params":{}}"#);
        owner.received(r#"{"id":1,"result":{"thread":{"id":"ours"}}}"#);
        owner.sent(r#"{"id":2,"method":"thread/read","params":{"threadId":"foreign"}}"#);
        owner.received(r#"{"method":"turn/started","params":{"threadId":"foreign","turn":{"id":"foreign-turn"}}}"#);
        owner.received(
            r#"{"method":"turn/started","params":{"threadId":"ours","turn":{"id":"our-turn"}}}"#,
        );
        owner.received(r#"{"method":"item/started","params":{"threadId":"ours","item":{"type":"collabAgentToolCall","receiverThreadIds":["our-child"]}}}"#);
        let requests = owner.shutdown_requests();
        assert_eq!(requests.len(), 7);
        assert!(requests
            .iter()
            .all(|request| request["params"]["threadId"] != "foreign"));
        assert!(requests
            .iter()
            .any(|request| request["method"] == "turn/interrupt"
                && request["params"]["turnId"] == "our-turn"));
    }

    #[test]
    fn shutdown_keeps_threads_until_unsubscribe_is_acknowledged() {
        let mut owner = CodexOwnership::default();
        owner.sent(r#"{"id":1,"method":"turn/start","params":{"threadId":"ours"}}"#);
        owner.sent(r#"{"id":2,"method":"thread/unsubscribe","params":{"threadId":"ours"}}"#);
        assert!(!owner.shutdown_requests().is_empty());
        assert!(!owner.closing.is_empty());
        owner.received(r#"{"id":2,"error":{"code":-1}}"#);
        assert!(owner.closing.is_empty());
        assert!(!owner.shutdown_requests().is_empty());
        owner.sent(r#"{"id":3,"method":"thread/unsubscribe","params":{"threadId":"ours"}}"#);
        owner.received(r#"{"id":3,"result":{}}"#);
        assert!(owner.shutdown_requests().is_empty());
    }

    // A real pipe round-trip without a WebView, provider CLI, or API call.
    #[test]
    #[ignore]
    fn automatic_approval_helper() {
        let Some(path) = std::env::var_os("DUCKWEED_APPROVAL_HELPER_PATH") else { return; };
        let mut log = std::fs::File::create(path).unwrap();
        for id in ["first", "second"] {
            println!("{}", serde_json::json!({"type":"control_request","request_id":id,"request":{
                "subtype":"can_use_tool","tool_name":"Bash","input":{"command":format!("echo {id}")}}}));
        }
        std::io::stdout().flush().unwrap();
        for line in std::io::stdin().lock().lines().take(2) {
            writeln!(log, "{}", line.unwrap()).unwrap();
            log.flush().unwrap();
        }
    }

    #[test]
    fn native_automatic_approvals_run_without_renderer_for_existing_and_later_processes() {
        let root = std::env::temp_dir().join(format!("duckweed-approvals-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = AgentProcManager::default();
        manager.start_approval_monitor();
        let start_fixture = |id: &str| {
            let path = root.join(format!("{id}.jsonl"));
            let env = HashMap::from([("DUCKWEED_APPROVAL_HELPER_PATH".into(), path.to_string_lossy().into_owned())]);
            start(&manager, Channel::new(|_| Ok(())), id.into(), AgentSpawnOptions {
                program: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
                renderer_recovery_id: None, args: vec!["--exact".into(), "agent_proc::tests::automatic_approval_helper".into(),
                    "--ignored".into(), "--nocapture".into()], cwd: None, env: Some(env),
            }).unwrap();
            path
        };
        let existing = start_fixture("existing");
        let timeout = Instant::now() + Duration::from_secs(5);
        loop {
            let count = manager.get("existing").unwrap().lock().unwrap().approvals.lock().unwrap().pending_count();
            if count == 2 { break; }
            assert!(Instant::now() < timeout, "fixture never delivered its permission requests");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(std::fs::read_to_string(&existing).unwrap().is_empty());
        manager.set_automatic_approval(&serde_json::json!("until-disabled"));
        let later = start_fixture("later");
        let timeout = Instant::now() + Duration::from_secs(8);
        loop {
            let done = [&existing, &later].iter().all(|path|
                std::fs::read_to_string(path).unwrap_or_default().lines().count() == 2);
            if done { break; }
            if Instant::now() >= timeout {
                let _ = manager.stop_all();
                panic!("native approvals stalled without a renderer");
            }
            thread::sleep(Duration::from_millis(20));
        }
        for path in [&existing, &later] {
            let replies = std::fs::read_to_string(path).unwrap();
            for line in replies.lines() {
                let frame: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(frame["response"]["response"]["behavior"], "allow");
                let id = frame["response"]["request_id"].as_str().unwrap();
                assert_eq!(frame["response"]["response"]["updatedInput"]["command"], format!("echo {id}"));
            }
        }
        manager.stop_all();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renderer_recovery_reattaches_the_same_local_process_and_replays_missed_output() {
        let manager = AgentProcManager::default();
        let (old_tx, old_rx) = mpsc::channel();
        let started = start(&manager, Channel::new(move |body| { old_tx.send(body).unwrap(); Ok(()) }),
            "live-recovery".into(), AgentSpawnOptions {
                program: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
                renderer_recovery_id: Some("local-fixture".into()),
                args: vec!["--exact".into(), "agent_proc::tests::backpressure_helper".into(), "--ignored".into(), "--nocapture".into()],
                cwd: None, env: Some(HashMap::from([("DUCKWEED_BACKPRESSURE_HELPER".into(), "1".into())])),
            }).unwrap();
        let checkpoint = loop {
            let tauri::ipc::InvokeResponseBody::Json(raw) = old_rx.recv_timeout(Duration::from_secs(3)).unwrap() else { panic!("expected JSON"); };
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["frame"]["line"].as_str().is_some_and(|line| line.contains("ready")) {
                break frame["sequence"].as_u64().unwrap();
            }
        };
        manager.recover_renderer();
        let handle = manager.get("live-recovery").expect("renderer failure removed the local process");
        assert_eq!(handle.lock().unwrap().pid, started.pid);
        assert!(handle.lock().unwrap().child.try_wait().unwrap().is_none());
        let delivery = handle.lock().unwrap().channel.clone();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !delivery.lock().unwrap().frames.iter().any(|(_, frame, _)| matches!(frame, AgentFrame::Stdout { line } if line.contains("alive"))) {
            if Instant::now() >= deadline { manager.stop_all(); panic!("the agent stopped producing output while detached"); }
            thread::sleep(Duration::from_millis(10));
        }
        // A checkpoint from an earlier process in the same pane cannot bind
        // to this one or discard the output needed by its actual renderer.
        assert!(manager.attach("live-recovery", "other-process", checkpoint, Channel::new(|_| Ok(()))).is_err());
        let latest = delivery.lock().unwrap().sequence;
        // The renderer compares this cursor with its own to detect a silent channel.
        assert!(manager.sequence("live-recovery", "local-fixture").is_some_and(|sequence| sequence >= latest && sequence > checkpoint));
        assert_eq!(manager.sequence("live-recovery", "other-process"), None);
        manager.checkpoint_saved("live-recovery", "other-process", latest);
        let (new_tx, new_rx) = mpsc::channel();
        assert!(manager.attach("live-recovery", "local-fixture", checkpoint, Channel::new(move |body| { let _ = new_tx.send(body); Ok(()) })).unwrap());
        let mut replayed = Vec::new();
        while let Ok(tauri::ipc::InvokeResponseBody::Json(raw)) = new_rx.try_recv() {
            replayed.push(serde_json::from_str::<serde_json::Value>(&raw).unwrap());
        }
        assert!(replayed.iter().all(|frame| frame["sequence"].as_u64().unwrap() > checkpoint));
        assert!(replayed.iter().any(|frame| frame["frame"]["line"].as_str().is_some_and(|line| line.contains("alive"))));
        manager.stop_all();
    }

    #[test]
    fn persisted_checkpoints_release_old_replay_frames_without_losing_new_output() {
        let mut delivery = AgentDelivery::new(Channel::new(|_| Ok(())), Some("fixture".into()));
        delivery.send(AgentFrame::Stdout { line: "saved".into() }).unwrap();
        delivery.send(AgentFrame::Stdout { line: "new".into() }).unwrap();
        delivery.checkpoint_saved(1);
        assert_eq!(delivery.frames.len(), 1);
        assert_eq!(delivery.frames.front().unwrap().0, 2);
        assert!(delivery.attach(1, Channel::new(|_| Ok(()))).is_ok());
        delivery.checkpoint_saved(2);
        assert_eq!(delivery.bytes, 0);
        assert!(delivery.frames.is_empty());
        assert!(delivery.attach(1, Channel::new(|_| Ok(()))).is_err());
        assert!(delivery.attach(2, Channel::new(|_| Ok(()))).is_ok());
        delivery.checkpoint_saved(100);
        assert_eq!(delivery.replay_after, 2);
    }

    #[test]
    fn renderer_replay_is_bounded_and_rejects_a_gap_without_discarding_the_process() {
        let mut delivery = AgentDelivery::new(Channel::new(|_| Ok(())), Some("fixture".into()));
        delivery.channel = None;
        for _ in 0..20 { delivery.send(AgentFrame::Stdout { line: "x".repeat(1024 * 1024) }).unwrap(); }
        assert!(delivery.bytes <= MAX_REPLAY_BYTES);
        assert!(delivery.attach(0, Channel::new(|_| Ok(()))).is_err());
        assert!(delivery.channel.is_none());
        let latest = delivery.sequence;
        assert!(delivery.attach(latest, Channel::new(|_| Ok(()))).is_ok());
        assert!(delivery.attach(latest + 1, Channel::new(|_| Ok(()))).is_err());
        for _ in 0..MAX_REPLAY_FRAMES + 1 { delivery.send(AgentFrame::Stderr { line: "x".into() }).unwrap(); }
        assert!(delivery.frames.len() <= MAX_REPLAY_FRAMES);
    }

    // Run only as the child of the backpressure test. No Codex or inference.
    #[test]
    #[ignore]
    fn backpressure_helper() {
        if std::env::var_os("DUCKWEED_BACKPRESSURE_HELPER").is_none() { return; }
        println!("ready");
        std::io::stdout().flush().unwrap();
        thread::sleep(Duration::from_millis(150));
        println!("alive");
        std::io::stdout().flush().unwrap();
        // Deliberately never read stdin, simulating a blocked agent/proxy.
        thread::sleep(Duration::from_secs(30));
    }

    // An isolated pipe reader records shutdown requests without launching Codex.
    #[test]
    #[ignore]
    fn shutdown_helper() {
        let Some(path) = std::env::var_os("DUCKWEED_SHUTDOWN_HELPER_PATH") else { return; };
        let mut log = std::fs::File::create(path).unwrap();
        println!("ready");
        std::io::stdout().flush().unwrap();
        for line in std::io::stdin().lock().lines() {
            writeln!(log, "{}", line.unwrap()).unwrap();
            log.flush().unwrap();
        }
    }

    #[test]
    fn renderer_recovery_and_disconnect_preserve_shared_work_but_stop_still_cleans_it() {
        let root = std::env::temp_dir().join(format!("duckweed-disconnect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for mode in ["disconnect", "renderer", "stop"] {
            let preserve = mode != "stop";
            let path = root.join(format!("shutdown-{mode}.jsonl"));
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "agent_proc::tests::shutdown_helper", "--ignored", "--nocapture"])
                .env("DUCKWEED_SHUTDOWN_HELPER_PATH", &path)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
            hide_console(&mut command);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            let mut child = command.spawn().unwrap();
            let pid = child.id();
            let mut output = BufReader::new(child.stdout.take().unwrap());
            let mut line = String::new();
            while !line.contains("ready") {
                line.clear();
                assert!(output.read_line(&mut line).unwrap() > 0);
            }
            let input = child.stdin.take().unwrap();
            let mut ownership = CodexOwnership::default();
            ownership.sent(r#"{"id":1,"method":"turn/start","params":{"threadId":"ours"}}"#);
            ownership.received(r#"{"id":1,"result":{"turn":{"id":"live-turn"}}}"#);
            let handle = Arc::new(Mutex::new(Process {
                stdin: Some(Arc::new(Mutex::new(ProcessInput::JsonLines(input)))),
                child, pid: Some(pid), runtime_roots: Vec::new(), ownership,
                service: Some(crate::codex_transport::test_service(&root)), reconnect_on_exit: false,
                approvals: Arc::new(Mutex::new(ApprovalQueue::default())), channel: Arc::new(Mutex::new(AgentDelivery::new(Channel::new(|_| Ok(())), None))),
            }));
            // All cleanup requests are confirmed locally. This fixture tests
            // pipe writes and must never invoke the real control-plane fallback.
            let reader_handle = handle.clone();
            let reader = thread::spawn(move || {
                while output.read_line(&mut String::new()).unwrap_or(0) > 0 {}
                reader_handle.lock().unwrap().ownership.closing.clear();
            });
            let manager = AgentProcManager::default();
            manager.inner.processes.lock().unwrap().insert("fixture".into(), handle.clone());
            // The helper exits on EOF once the cleanup writer releases stdin.
            match mode {
                "renderer" => manager.recover_renderer(),
                "disconnect" => manager.disconnect("fixture").unwrap(),
                _ => manager.stop("fixture").unwrap(),
            }
            // Renderer recovery kills off the calling thread, so never hold the
            // process lock across a blocking wait here.
            let deadline = Instant::now() + Duration::from_secs(10);
            while handle.lock().unwrap().child.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "{mode} left the process running");
                thread::sleep(Duration::from_millis(10));
            }
            reader.join().unwrap();
            let recorded = std::fs::read_to_string(&path).unwrap();
            if preserve { assert!(recorded.is_empty(), "reconnection sent shutdown requests: {recorded}"); }
            else {
                for method in ["turn/interrupt", "thread/goal/set", "thread/backgroundTerminals/clean", "thread/unsubscribe"] {
                    assert!(recorded.contains(method), "Stop omitted {method}: {recorded}");
                }
            }
            assert_eq!(manager.open_count(), 0);
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn full_stdin_does_not_block_output_or_stop() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "agent_proc::tests::backpressure_helper", "--ignored", "--nocapture"])
            .env("DUCKWEED_BACKPRESSURE_HELPER", "1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        hide_console(&mut command);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("ready") {
            line.clear();
            assert!(output.read_line(&mut line).unwrap() > 0);
        }
        let input = child.stdin.take().unwrap();
        let handle = Arc::new(Mutex::new(Process {
            stdin: Some(Arc::new(Mutex::new(ProcessInput::JsonLines(input)))),
            child, pid: Some(pid), runtime_roots: Vec::new(),
            ownership: CodexOwnership::default(), service: None, reconnect_on_exit: false,
            approvals: Arc::new(Mutex::new(ApprovalQueue::default())), channel: Arc::new(Mutex::new(AgentDelivery::new(Channel::new(|_| Ok(())), None))),
        }));
        let manager = AgentProcManager::default();
        manager.inner.processes.lock().unwrap().insert("backpressure".into(), handle.clone());
        let sender = manager.clone();
        let (written, write_result) = mpsc::channel();
        let writer = thread::spawn(move || {
            let result = sender.send("backpressure", &"x".repeat(4 * 1024 * 1024));
            let _ = written.send(result);
        });
        let reader_handle = handle.clone();
        let (received, read_result) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut line = String::new();
            while output.read_line(&mut line).unwrap_or(0) > 0 {
                if line.contains("alive") {
                    // The production stdout reader takes this lock to update
                    // ownership before forwarding the frame to the WebView.
                    let _process = reader_handle.lock().unwrap();
                    let _ = received.send(());
                    break;
                }
                line.clear();
            }
        });
        let output_arrived = read_result.recv_timeout(Duration::from_secs(2)).is_ok();
        let write_is_blocked = write_result.try_recv().is_err();
        // Clean up even when checking the old implementation, whose process
        // lock is held by the blocked write and prevents manager.stop().
        if !output_arrived { kill_tree(pid); }
        let started = Instant::now();
        manager.stop("backpressure").unwrap();
        let stop_elapsed = started.elapsed();
        writer.join().unwrap();
        reader.join().unwrap();
        let _ = handle.lock().unwrap().child.wait();
        assert!(output_arrived, "a full stdin pipe blocked live stdout delivery");
        assert!(write_is_blocked, "the fixture did not reproduce stdin backpressure");
        assert!(stop_elapsed < Duration::from_secs(2), "Stop waited on the blocked stdin writer");
        assert_eq!(manager.open_count(), 0);
    }

    #[test]
    fn resumed_live_turn_is_owned_even_without_a_start_notification() {
        let mut owner = CodexOwnership::default();
        owner.sent(r#"{"id":1,"method":"thread/resume","params":{"threadId":"resumed"}}"#);
        assert!(owner.threads.contains_key("resumed"));
        owner.received(r#"{"id":1,"result":{"thread":{"id":"resumed"},"initialTurnsPage":{"data":[{"id":"live-turn","status":"inProgress"}]}}}"#);
        let requests = owner.shutdown_requests();
        assert!(requests.iter().any(|request| request["method"] == "turn/interrupt" && request["params"]["turnId"] == "live-turn"));
        assert!(requests.iter().any(|request| request["method"] == "thread/goal/set" && request["params"]["status"] == "paused"));
    }

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
    fn drains_a_runaway_line_without_retaining_its_tail() {
        use std::io::Cursor;

        let mut input = vec![b'x'; 128];
        input.extend_from_slice(b"\nnext\n");
        let mut reader = BufReader::with_capacity(8, Cursor::new(input));
        let mut buffer = Vec::new();

        assert_eq!(
            read_bounded_line(&mut reader, &mut buffer, 16).unwrap(),
            129
        );
        assert_eq!(buffer, vec![b'x'; 16]);
        assert_eq!(read_bounded_line(&mut reader, &mut buffer, 16).unwrap(), 5);
        assert_eq!(buffer, b"next\n");
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
        kill_tree(child.id());
        let _ = child.wait();

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
