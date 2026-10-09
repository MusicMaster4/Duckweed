//! Bridge Codex's shared local service to Duckweed's JSON-line IPC.
//!
//! `app-server proxy` forwards raw WebSocket bytes, not JSON lines. Keep the
//! HTTP upgrade, masking, fragmentation and ping handling in tungstenite.
use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::{Message, WebSocket};

use crate::agent_proc::{build_command, hide_console, kill_tree, AgentSpawnOptions};

type SharedStdin = Arc<Mutex<ChildStdin>>;

pub struct ProxyReader {
    stdout: ChildStdout,
    stdin: SharedStdin,
}

pub struct ProxyWriter(SharedStdin);

impl Read for ProxyReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.stdout.read(bytes)
    }
}

impl Read for ProxyWriter {
    fn read(&mut self, _bytes: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "write-only WebSocket half",
        ))
    }
}

impl Write for ProxyReader {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stdin.lock().unwrap().write_all(bytes)?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stdin.lock().unwrap().flush()
    }
}

impl Write for ProxyWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().write_all(bytes)?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

pub struct Connection {
    pub child: Child,
    pub reader: WebSocket<ProxyReader>,
    pub writer: WebSocket<ProxyWriter>,
    pub service: Service,
}

#[derive(Clone)]
pub struct Service {
    pub home: PathBuf,
    resolved: PathBuf,
    options: AgentSpawnOptions,
    owner: Arc<Mutex<Option<String>>>,
    pub reconnecting: Arc<AtomicBool>,
}

// Compare account ownership, not rotating access tokens. Credentials stay in
// the CLI's store and never enter WebView IPC or application logs.
fn stored_owner(home: &Path) -> Option<String> {
    let native_login = std::fs::metadata(home.join("log/codex-login.log"))
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    let auth: serde_json::Value = std::fs::read(home.join("auth.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if auth.is_null() && native_login.is_none() {
        return None;
    }
    Some(owner_digest(&auth, native_login))
}

fn owner_digest(auth: &serde_json::Value, native_login: Option<std::time::SystemTime>) -> String {
    let key = auth["OPENAI_API_KEY"]
        .as_str()
        .filter(|key| !key.is_empty());
    let owner = if let Some(key) = key {
        serde_json::json!({"type":"apiKey", "key":key})
    } else {
        let jwt = auth["tokens"]["id_token"].as_str().unwrap_or_default();
        let claims: serde_json::Value = jwt
            .split('.')
            .nth(1)
            .and_then(|payload| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(payload)
                    .ok()
            })
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        serde_json::json!({"type":auth["auth_mode"], "account":auth["tokens"]["account_id"],
            "user":claims["sub"], "email":claims["email"], "bedrock":auth["bedrock"]})
    };
    // A new native login can renew an expired sign-in for the same owner.
    // Its log's timestamp is a signal only; never read the login log itself.
    format!(
        "{:x}",
        Sha256::digest(format!("{owner}{native_login:?}").as_bytes())
    )
}

fn can_reload(thread: &serde_json::Value, terminals: &serde_json::Value) -> bool {
    thread["thread"]["status"]["type"] == "idle"
        && terminals["data"].as_array().is_some_and(Vec::is_empty)
}

impl Service {
    pub fn acknowledge(&self) {
        *self.owner.lock().unwrap() = stored_owner(&self.home);
    }
}

fn service(resolved: &Path, options: &AgentSpawnOptions) -> Service {
    let home = options
        .env
        .as_ref()
        .and_then(|env| env.get("CODEX_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(crate::home_dir()).join(".codex"));
    let home = home.canonicalize().unwrap_or(home);
    Service {
        owner: Arc::new(Mutex::new(stored_owner(&home))),
        reconnecting: Arc::new(AtomicBool::new(false)),
        home,
        resolved: resolved.into(),
        options: options.clone(),
    }
}

#[cfg(test)]
pub(crate) fn test_service(home: &Path) -> Service {
    service(Path::new("codex"), &AgentSpawnOptions {
        program: "codex".into(), args: vec!["app-server".into()], cwd: None,
        env: Some([("CODEX_HOME".into(), home.to_string_lossy().into())].into()),
    })
}

/// A native `codex login/logout` writes the store without reloading the daemon.
/// Restart only after checking every loaded thread and its background terminals.
/// Never restart another client's active work to make our account read succeed.
pub fn synchronize(
    service: &Service,
    signed_in: bool,
    before_restart: impl FnOnce(),
) -> Result<&'static str, String> {
    static SYNC: Mutex<()> = Mutex::new(());
    let _guard = SYNC.lock().unwrap();
    if service.reconnecting.load(Ordering::Relaxed) {
        return Ok("restarted");
    }
    let owner = stored_owner(&service.home);
    // File-backed credentials give us a stable ownership revision. Token
    // refreshes do not change it; login/logout do. Do not launch an npm shim
    // and a new CLI process for every session's five-second poll.
    if signed_in && owner == *service.owner.lock().unwrap()
        && service.home.join("auth.json").is_file()
    {
        return Ok("unchanged");
    }
    let mut status = build_command(&service.resolved);
    status.args(["login", "status"]);
    if let Some(cwd) = &service.options.cwd {
        status.current_dir(cwd);
    }
    if let Some(env) = &service.options.env {
        status.envs(env);
    }
    let result = command_output(status, Duration::from_secs(5), "login status")?;
    let actual_signed_in = match result.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => return Ok("unchanged"),
    };
    if owner == *service.owner.lock().unwrap() && signed_in == actual_signed_in {
        return Ok("unchanged");
    }
    let mut client = ControlClient::new(service)?;
    let mut cursor = serde_json::Value::Null;
    let mut seen = std::collections::HashSet::new();
    loop {
        let page = client.rpc(
            "thread/loaded/list",
            serde_json::json!({"limit":100,"cursor":cursor}),
        )?;
        for id in page["data"]
            .as_array()
            .ok_or("Invalid loaded thread list")?
        {
            let thread = client.rpc(
                "thread/read",
                serde_json::json!({"threadId":id,"includeTurns":false}),
            )?;
            if thread["thread"]["status"]["type"] != "idle" {
                return Ok("deferred");
            }
            let terminals = client.rpc(
                "thread/backgroundTerminals/list",
                serde_json::json!({"threadId":id,"limit":1}),
            )?;
            if !can_reload(&thread, &terminals) {
                return Ok("deferred");
            }
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        if !seen.insert(cursor.to_string()) || seen.len() > 100 {
            return Ok("deferred");
        }
    }
    // Do not restart for a transient half-written login file or a newer account
    // notification that arrived while the idle check was in flight.
    if stored_owner(&service.home) != owner {
        return Ok("deferred");
    }
    if owner == *service.owner.lock().unwrap() && signed_in == actual_signed_in {
        return Ok("unchanged");
    }
    before_restart();
    service.reconnecting.store(true, Ordering::Relaxed);
    let output = daemon_command(
        &service.resolved,
        &service.options,
        "restart",
        Duration::from_secs(30),
    )
    .inspect_err(|_| {
        service.reconnecting.store(false, Ordering::Relaxed);
    })?;
    if !output.status.success() {
        service.reconnecting.store(false, Ordering::Relaxed);
        return Err(
            "Could not reload the shared Codex service after the CLI account changed.".into(),
        );
    }
    service.acknowledge();
    Ok("restarted")
}

/// Use a separate proxy when the UI connection cannot deliver an interrupt.
/// Only the root and children recorded by that connection are addressed.
pub fn interrupt_threads(service: &Service, threads: &[(String, Option<String>)]) -> Result<(), String> {
    let mut client = ControlClient::new(service)?;
    let mut errors = Vec::new();
    for (thread, known_turn) in threads {
        // Goals persist in the daemon and can immediately restart a cancelled
        // turn, including after the UI reconnects. Pause only an active goal.
        if let Ok(goal) = client.rpc("thread/goal/get", serde_json::json!({"threadId":thread})) {
            if goal["goal"]["status"] == "active" {
                if let Err(error) = client.rpc("thread/goal/set", serde_json::json!({"threadId":thread,"status":"paused"})) {
                    errors.push(error);
                }
            }
        }
        // Empty provisional and ephemeral threads do not have persisted turn
        // pages. Their live thread status is enough to prove there is no turn
        // to interrupt. For active threads, resolve the current id separately.
        let metadata = client.rpc("thread/read", serde_json::json!({"threadId":thread,"includeTurns":false}));
        let turn = match metadata {
            Ok(metadata) if metadata["thread"]["status"]["type"] == "idle" => None,
            Ok(metadata) => {
                let active = metadata["thread"]["activeTurnId"].as_str().map(str::to_owned);
                if active.is_some() { active } else {
                    match client.rpc("thread/turns/list", serde_json::json!({"threadId":thread,"limit":1,"sortDirection":"desc","itemsView":"summary"})) {
                        Ok(page) => page["data"].as_array().and_then(|turns| turns.first())
                            .filter(|turn| turn["status"] == "inProgress")
                            .and_then(|turn| turn["id"].as_str()).map(str::to_owned),
                        Err(error) => {
                            if known_turn.is_none() { errors.push(error); }
                            known_turn.clone()
                        }
                    }
                }
            }
            Err(error) => {
                if known_turn.is_none() { errors.push(error); }
                known_turn.clone()
            }
        };
        if let Some(turn) = turn {
            if let Err(error) = client.rpc("turn/interrupt", serde_json::json!({"threadId":thread,"turnId":turn})) {
                errors.push(error);
            }
        }
        if let Err(error) = client.rpc("thread/backgroundTerminals/clean", serde_json::json!({"threadId":thread})) {
            errors.push(error);
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("\n")) }
}

struct ControlClient {
    connection: Connection,
    done: mpsc::Sender<()>,
    next_id: u32,
}
impl ControlClient {
    fn new(service: &Service) -> Result<Self, String> {
        let connection = proxy_connection(&service.resolved, &service.options, 8 * 1024 * 1024)?;
        let (done, wait) = mpsc::channel();
        let pid = connection.child.id();
        std::thread::spawn(move || {
            if wait.recv_timeout(Duration::from_secs(10)).is_err() {
                kill_tree(pid);
            }
        });
        let mut client = Self {
            connection,
            done,
            next_id: 1,
        };
        client.rpc("initialize", serde_json::json!({"clientInfo":{"name":"duckweed_auth_sync","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
        send(
            &mut client.connection.writer,
            "{\"method\":\"initialized\"}",
        )?;
        Ok(client)
    }
    fn rpc(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        send(
            &mut self.connection.writer,
            &serde_json::json!({"id":id,"method":method,"params":params}).to_string(),
        )?;
        loop {
            match self
                .connection
                .reader
                .read()
                .map_err(|error| error.to_string())?
            {
                Message::Text(text) => {
                    let frame: serde_json::Value =
                        serde_json::from_str(&text).map_err(|error| error.to_string())?;
                    if frame["id"] != id {
                        continue;
                    }
                    if frame.get("error").is_some() {
                        return Err(format!(
                            "Codex request {method} failed: {}", frame["error"]["message"].as_str().unwrap_or("unknown error")
                        ));
                    }
                    return Ok(frame["result"].clone());
                }
                Message::Ping(_) => self
                    .connection
                    .reader
                    .flush()
                    .map_err(|error| error.to_string())?,
                Message::Close(_) => return Err("Codex account check disconnected.".into()),
                _ => {}
            }
        }
    }
}
impl Drop for ControlClient {
    fn drop(&mut self) {
        let _ = self.done.send(());
        kill_tree(self.connection.child.id());
        let _ = self.connection.child.wait();
    }
}

/// Process-level overrides belong to a private server. Do not silently discard
/// a wrapper, profile, provider, environment credential or configuration flag.
fn eligible(options: &AgentSpawnOptions) -> bool {
    let name = Path::new(&options.program)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    name.eq_ignore_ascii_case("codex")
        && options.args == ["app-server"]
        && options
            .env
            .as_ref()
            .is_none_or(|env| env.keys().all(|key| key == "CODEX_HOME"))
        && [
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OPENAI_IDENTITY_TOKEN_FILE",
            "OPENAI_WORKLOAD_IDENTITY",
        ]
        .iter()
        .all(|name| std::env::var_os(name).is_none())
}

fn daemon_command(
    resolved: &Path,
    options: &AgentSpawnOptions,
    action: &str,
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = build_command(resolved);
    command.args(["app-server", "daemon", action]);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        command.envs(env);
    }
    command_output(command, timeout, action)
}

fn command_output(
    mut command: std::process::Command,
    timeout: Duration,
    action: &str,
) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let (done, wait) = mpsc::channel();
    let watchdog = match std::thread::Builder::new()
        .name("codex-command-timeout".into())
        .spawn(move || {
            if matches!(wait.recv_timeout(timeout), Err(mpsc::RecvTimeoutError::Timeout)) {
                kill_tree(pid);
                true
            } else {
                false
            }
        }) {
        Ok(watchdog) => watchdog,
        Err(error) => {
            kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    // Drain both pipes while the process runs. Waiting for exit first can
    // deadlock a command as soon as either OS pipe buffer fills. The watchdog
    // supplies the deadline without repeatedly polling the process handle.
    let output = child.wait_with_output();
    let _ = done.send(());
    if watchdog.join().unwrap_or(false) {
        return Err(format!("Codex {action} timed out."));
    }
    output.map_err(|error| error.to_string())
}

/// Old Codex builds keep their stdio server. Supported builds use the same
/// daemon as the native CLI, including its credential store and account events.
pub fn connect(
    resolved: &Path,
    options: &AgentSpawnOptions,
    limit: usize,
) -> Result<Option<Connection>, String> {
    if !eligible(options) {
        return Ok(None);
    }
    // `daemon version` fails when no service is running. Detect support with
    // help instead, then use the idempotent start command for both states.
    let supported = daemon_command(resolved, options, "--help", Duration::from_secs(5))?;
    if !supported.status.success() {
        return Ok(None);
    }
    let started = daemon_command(resolved, options, "start", Duration::from_secs(30))?;
    if !started.status.success() {
        return Err(format!(
            "Could not start the shared Codex service: {}",
            String::from_utf8_lossy(&started.stderr).trim()
        ));
    }
    proxy_connection(resolved, options, limit).map(Some)
}

fn proxy_connection(
    resolved: &Path,
    options: &AgentSpawnOptions,
    limit: usize,
) -> Result<Connection, String> {
    let mut command = build_command(resolved);
    command.args(["app-server", "proxy"]);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        command.envs(env);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = Arc::new(Mutex::new(
        child.stdin.take().ok_or("Codex proxy has no stdin")?,
    ));
    let stream = ProxyReader {
        stdout: child.stdout.take().ok_or("Codex proxy has no stdout")?,
        stdin: stdin.clone(),
    };
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(limit);
    config.max_frame_size = Some(limit);
    // Pipes cannot have a read timeout. Kill only our proxy if the HTTP upgrade
    // stalls, leaving the user's daemon and other clients untouched.
    let (done, wait) = mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || {
        if wait.recv_timeout(Duration::from_secs(5)).is_err() {
            kill_tree(pid);
        }
    });
    let upgrade = tungstenite::client::client_with_config("ws://localhost/", stream, Some(config));
    let _ = done.send(());
    match upgrade {
        Ok((reader, _)) => Ok(Connection {
            child,
            reader,
            service: service(resolved, options),
            writer: WebSocket::from_raw_socket(ProxyWriter(stdin), Role::Client, Some(config)),
        }),
        Err(error) => {
            kill_tree(child.id());
            let _ = child.wait();
            Err(format!(
                "Could not connect to the shared Codex service: {error}"
            ))
        }
    }
}

pub fn send(writer: &mut WebSocket<ProxyWriter>, line: &str) -> Result<(), String> {
    writer
        .send(Message::Text(line.to_owned().into()))
        .map_err(|error| error.to_string())
}

/// A response too large for the webview must still settle its request, or the
/// caller waits forever. Server requests and notifications have no waiting
/// caller on our side, so they are only dropped.
pub fn oversized_reply(line: &str, limit: usize) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Envelope {
        id: Option<serde_json::Value>,
        method: Option<serde::de::IgnoredAny>,
    }
    let envelope: Envelope = serde_json::from_str(line).ok()?;
    if envelope.method.is_some() {
        return None;
    }
    let id = envelope.id?;
    Some(
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32603,
                "message": format!(
                    "Codex sent a {} byte response, over Duckweed's {} byte limit.",
                    line.len(),
                    limit
                ),
            },
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An isolated child process for command capture and timeout tests.
    #[test]
    #[ignore]
    fn command_output_helper() {
        let Some(mode) = std::env::var_os("DUCKWEED_COMMAND_OUTPUT_HELPER") else {
            return;
        };
        if mode == "timeout" {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        std::io::stdout().write_all(&vec![0xff; 256 * 1024]).unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stderr().write_all(&vec![0xfe; 256 * 1024]).unwrap();
        std::io::stderr().flush().unwrap();
    }

    fn output_helper_command(mode: &str) -> std::process::Command {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "codex_transport::tests::command_output_helper", "--ignored", "--nocapture"])
            .env("DUCKWEED_COMMAND_OUTPUT_HELPER", mode);
        command
    }

    #[test]
    fn command_capture_drains_both_pipes_before_the_child_exits() {
        let output = command_output(output_helper_command("output"), Duration::from_secs(5), "fixture").unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.iter().filter(|byte| **byte == 0xff).count(), 256 * 1024);
        assert_eq!(output.stderr.iter().filter(|byte| **byte == 0xfe).count(), 256 * 1024);
    }

    #[test]
    fn command_capture_keeps_its_timeout_and_reaps_the_child() {
        let started = std::time::Instant::now();
        let result = command_output(output_helper_command("timeout"), Duration::from_millis(100), "fixture");
        assert_eq!(result.unwrap_err(), "Codex fixture timed out.");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn account_rotation_and_native_renewal_have_different_revisions() {
        use serde_json::json;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"sub":"user-1","email":"user@example.com"}"#);
        let mut auth = json!({"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1","id_token":format!("header.{payload}.signature"),"access_token":"old","refresh_token":"old"}});
        let first = owner_digest(&auth, None);
        auth["tokens"]["access_token"] = json!("rotated");
        auth["tokens"]["refresh_token"] = json!("rotated");
        assert_eq!(first, owner_digest(&auth, None));
        assert_ne!(
            first,
            owner_digest(&auth, Some(std::time::SystemTime::now()))
        );
        auth["tokens"]["account_id"] = json!("workspace-2");
        assert_ne!(first, owner_digest(&auth, None));
    }

    #[test]
    fn unchanged_file_account_does_not_launch_another_cli() {
        let home = std::env::temp_dir().join(format!("dw-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        std::fs::write(home.join("auth.json"), r#"{"auth_mode":"apikey","OPENAI_API_KEY":"test-only-key"}"#).unwrap();
        let options = AgentSpawnOptions {
            program: "missing-codex-binary".into(),
            args: vec!["app-server".into()],
            cwd: None,
            env: Some(std::collections::HashMap::from([("CODEX_HOME".into(), home.to_string_lossy().into_owned())])),
        };
        let connection = service(Path::new("missing-codex-binary"), &options);
        for _ in 0..3 {
            assert_eq!(synchronize(&connection, true, || panic!("unchanged account restarted")).unwrap(), "unchanged");
        }
        std::fs::remove_file(home.join("auth.json")).unwrap();
        std::fs::remove_dir(home).unwrap();
    }

    #[test]
    fn oversized_responses_settle_their_request_and_other_frames_are_dropped() {
        let reply = oversized_reply(r#"{"id":6,"result":{"marketplaces":[]}}"#, 8).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["id"], 6);
        assert_eq!(reply["error"]["code"], -32603);
        assert!(reply.get("result").is_none());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &oversized_reply(r#"{"id":"duckweed-x","result":{}}"#, 8).unwrap()
            )
            .unwrap()["id"],
            "duckweed-x"
        );
        assert!(oversized_reply(r#"{"id":3,"method":"item/permissions/requestApproval","params":{}}"#, 8).is_none());
        assert!(oversized_reply(r#"{"method":"item/agentMessage/delta","params":{}}"#, 8).is_none());
        assert!(oversized_reply("not json", 8).is_none());
    }

    #[test]
    fn shared_reload_waits_for_other_clients_and_background_servers() {
        use serde_json::json;
        let idle = json!({"thread":{"status":{"type":"idle"}}});
        let empty = json!({"data":[]});
        assert!(can_reload(&idle, &empty));
        assert!(!can_reload(
            &json!({"thread":{"status":{"type":"active"}}}),
            &empty
        ));
        assert!(!can_reload(&idle, &json!({"data":[{"osPid":123}]})));
        assert!(!can_reload(&idle, &json!({})));
        assert!(!can_reload(&json!({}), &empty));
    }

    #[test]
    fn process_overrides_and_wrappers_keep_their_own_server() {
        let mut options = AgentSpawnOptions {
            program: "omx".into(),
            args: vec!["app-server".into()],
            cwd: None,
            env: None,
        };
        assert!(!eligible(&options));
        options.program = "codex".into();
        options.args.insert(0, "--profile=work".into());
        assert!(!eligible(&options));
        options.args = vec!["app-server".into()];
        options.env = Some([("CODEX_ACCESS_TOKEN".into(), "test".into())].into());
        assert!(!eligible(&options));
    }

    /// Real service, two clients, and an isolated credential store. This must
    /// never sign the developer out or send an inference request.
    #[test]
    fn shared_clients_observe_login_and_logout() {
        use crate::agent_proc::resolve_program;
        use serde_json::{json, Value};
        let Some(resolved) = resolve_program("codex") else {
            eprintln!("Codex integration skipped: CLI not installed");
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "dw-auth-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("config.toml"),
            "cli_auth_credentials_store = \"file\"\n",
        )
        .unwrap();
        let options = AgentSpawnOptions {
            program: "codex".into(),
            args: vec!["app-server".into()],
            cwd: Some(root.to_string_lossy().into()),
            env: Some([("CODEX_HOME".into(), root.to_string_lossy().into())].into()),
        };
        struct Cleanup<'a> {
            resolved: &'a Path,
            options: &'a AgentSpawnOptions,
            root: std::path::PathBuf,
            proxies: Vec<u32>,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                for pid in &self.proxies {
                    kill_tree(*pid);
                }
                let _ =
                    daemon_command(self.resolved, self.options, "stop", Duration::from_secs(10));
                // The managed Windows daemon can leave its update loop behind.
                // Stop only executables inside the home created by this test.
                #[cfg(windows)]
                {
                    let mut command = std::process::Command::new("powershell");
                    command.args(["-NoProfile", "-NonInteractive", "-Command",
                        "$testRoot = [IO.Path]::GetFullPath($env:DUCKWEED_TEST_CODEX_HOME).TrimEnd('\\') + '\\'; Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Replace('\\\\?\\', '').StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"])
                        .env("DUCKWEED_TEST_CODEX_HOME", &self.root)
                        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                    hide_console(&mut command);
                    let _ = command.status();
                }
                // This exact directory was created by this test under TEMP.
                if self.root.starts_with(std::env::temp_dir())
                    && self
                        .root
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("dw-auth-")
                {
                    let _ = std::fs::remove_dir_all(&self.root);
                }
            }
        }
        let mut cleanup = Cleanup {
            resolved: &resolved,
            options: &options,
            root: root.clone(),
            proxies: vec![],
        };
        if !eligible(&options) {
            eprintln!("Codex integration skipped: environment credentials override the daemon");
            return;
        }
        let Some(mut a) = connect(&resolved, &options, 8 * 1024 * 1024).unwrap() else {
            eprintln!("Codex integration skipped: CLI does not support a daemon");
            return;
        };
        cleanup.proxies.push(a.child.id());
        let mut b = proxy_connection(&resolved, &options, 8 * 1024 * 1024).unwrap();
        cleanup.proxies.push(b.child.id());
        let (done, wait) = mpsc::channel();
        let pids = cleanup.proxies.clone();
        std::thread::spawn(move || {
            if wait.recv_timeout(Duration::from_secs(15)).is_err() {
                for pid in pids {
                    kill_tree(pid);
                }
            }
        });
        fn rpc(connection: &mut Connection, id: u32, method: &str, params: Value) -> Value {
            send(
                &mut connection.writer,
                &json!({"id": id, "method": method, "params": params}).to_string(),
            )
            .unwrap();
            loop {
                if let Message::Text(text) = connection.reader.read().unwrap() {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    if frame["id"] == id {
                        assert!(
                            frame.get("error").is_none(),
                            "Codex rejected {method}: {:?}",
                            frame["error"]
                        );
                        return frame["result"].clone();
                    }
                }
            }
        }
        for connection in [&mut a, &mut b] {
            rpc(
                connection,
                1,
                "initialize",
                json!({"clientInfo":{"name":"duckweed_auth_test","version":"0.1.0"}}),
            );
            send(&mut connection.writer, "{\"method\":\"initialized\"}").unwrap();
        }
        rpc(
            &mut a,
            2,
            "account/login/start",
            json!({"type":"apiKey","apiKey":"duckweed-local-test-placeholder"}),
        );
        assert_eq!(
            rpc(&mut b, 2, "account/read", json!({"refreshToken":false}))["account"]["type"],
            "apiKey"
        );
        assert!(root.join("auth.json").exists());
        rpc(&mut b, 3, "account/logout", json!({}));
        assert!(rpc(&mut a, 3, "account/read", json!({"refreshToken":false}))["account"].is_null());
        assert!(!root.join("auth.json").exists());
        a.service.acknowledge();
        // Native CLI commands must update a service that was already running.
        let native_login = || {
            let mut login = build_command(&resolved);
            login
                .args(["login", "--with-api-key"])
                .env("CODEX_HOME", &root)
                .current_dir(&root)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            hide_console(&mut login);
            let mut login = login.spawn().unwrap();
            login
                .stdin
                .take()
                .unwrap()
                .write_all(b"duckweed-local-test-placeholder\n")
                .unwrap();
            assert!(login.wait().unwrap().success());
        };
        native_login();
        assert_eq!(synchronize(&a.service, false, || {}).unwrap(), "restarted");
        let mut fresh = ControlClient::new(&a.service).unwrap();
        assert_eq!(
            fresh
                .rpc("account/read", json!({"refreshToken":false}))
                .unwrap()["account"]["type"],
            "apiKey"
        );
        fresh.connection.service.acknowledge();
        // A native re-login with the same key must also reload stale auth.
        native_login();
        assert_eq!(
            synchronize(&fresh.connection.service, true, || {}).unwrap(),
            "restarted"
        );
        fresh = ControlClient::new(&fresh.connection.service).unwrap();
        assert_eq!(
            fresh
                .rpc("account/read", json!({"refreshToken":false}))
                .unwrap()["account"]["type"],
            "apiKey"
        );
        // Duckweed opens a provisional blank thread before its first prompt.
        // It must not prevent synchronization of a later native logout.
        let provisional = fresh
            .rpc("thread/start", json!({"cwd":root,"ephemeral":true}))
            .unwrap();
        let ours = provisional["thread"]["id"].as_str().unwrap().to_owned();
        let foreign = fresh.rpc("thread/start", json!({"cwd":root,"ephemeral":true})).unwrap();
        let foreign = foreign["thread"]["id"].as_str().unwrap();
        // Exercise the emergency control connection against the installed CLI,
        // without any inference or touching the developer's real CODEX_HOME.
        interrupt_threads(&fresh.connection.service, &[(ours.clone(), None)]).unwrap();
        assert_eq!(fresh.rpc("thread/read", json!({"threadId":ours,"includeTurns":false})).unwrap()["thread"]["status"]["type"], "idle");
        assert_eq!(fresh.rpc("thread/read", json!({"threadId":foreign,"includeTurns":false})).unwrap()["thread"]["status"]["type"], "idle");
        let mut logout = build_command(&resolved);
        logout
            .arg("logout")
            .env("CODEX_HOME", &root)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut logout);
        assert!(logout.status().unwrap().success());
        assert_eq!(
            synchronize(&fresh.connection.service, true, || {}).unwrap(),
            "restarted"
        );
        let mut signed_out = ControlClient::new(&fresh.connection.service).unwrap();
        assert!(signed_out
            .rpc("account/read", json!({"refreshToken":false}))
            .unwrap()["account"]
            .is_null());
        let _ = done.send(());
    }
}
