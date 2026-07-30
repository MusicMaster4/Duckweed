//! Discover listening servers launched from Duckweed and share them publicly.
//!
//! Ownership is derived from process ancestry. A PID must descend from a live
//! PTY shell or headless agent before it can be listed, stopped, or tunneled.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::agent_proc::AgentProcManager;
use crate::process_tree::{self, ProcessInfo};
use crate::pty::PtyManager;

#[derive(Clone, Debug)]
struct Listener {
    address: String,
    port: u16,
    pid: u32,
}

#[derive(Clone, Debug)]
struct Owner {
    id: String,
    kind: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct ForwardInfo {
    pub id: String,
    pub target_pid: u32,
    pub target_port: u16,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PortInfo {
    pub pid: u32,
    pub port: u16,
    pub address: String,
    pub process: String,
    pub owner_id: String,
    pub owner_kind: String,
    pub forward: Option<ForwardInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PortSnapshot {
    pub ports: Vec<PortInfo>,
    pub scanned_at: u64,
}

struct ForwardRecord {
    info: ForwardInfo,
    child: Mutex<Child>,
    proxy: OriginProxy,
}

struct OriginProxy {
    stop: Arc<AtomicBool>,
    connections: ActiveConnections,
}

struct ActiveConnection {
    client: TcpStream,
    target: Option<TcpStream>,
}

type ActiveConnections = Arc<Mutex<HashMap<u64, ActiveConnection>>>;
const TUNNEL_READY_PATH: &str = "/.well-known/duckweed-tunnel-ready";

#[derive(Default)]
struct PortInner {
    forwards: Mutex<HashMap<String, ForwardRecord>>,
    start_lock: Mutex<()>,
}

#[derive(Clone, Default)]
pub struct PortManager {
    inner: Arc<PortInner>,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl PortManager {
    fn forwards(&self) -> Vec<ForwardInfo> {
        self.inner
            .forwards
            .lock()
            .unwrap()
            .values()
            .map(|record| record.info.clone())
            .collect()
    }

    fn stop_for_target(&self, pid: u32) {
        let ids: Vec<String> = self
            .inner
            .forwards
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, record)| record.info.target_pid == pid)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    fn reconcile(&self, active: &HashSet<(u32, u16)>) {
        let stale: Vec<String> = self
            .inner
            .forwards
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, record)| {
                !active.contains(&(record.info.target_pid, record.info.target_port))
                    || tunnel_finished(record)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            let _ = self.stop(&id);
        }
    }

    pub fn start(
        &self,
        pid: u32,
        target_port: u16,
        target_address: &str,
        tools_dir: &Path,
    ) -> Result<ForwardInfo, String> {
        let _start_guard = self.inner.start_lock.lock().map_err(err)?;
        if let Some(existing) = self
            .forwards()
            .into_iter()
            .find(|forward| forward.target_pid == pid && forward.target_port == target_port)
        {
            return Ok(existing);
        }

        let (proxy, proxy_port) = start_origin_proxy(target_address, target_port)?;
        let (child, url) = match start_public_tunnel(proxy_port, tools_dir) {
            Ok(tunnel) => tunnel,
            Err(error) => {
                proxy.stop();
                return Err(error);
            }
        };
        let id = format!("tunnel-{pid}-{target_port}");
        let info = ForwardInfo {
            id: id.clone(),
            target_pid: pid,
            target_port,
            url,
        };

        self.inner.forwards.lock().unwrap().insert(
            id,
            ForwardRecord {
                info: info.clone(),
                child: Mutex::new(child),
                proxy,
            },
        );
        Ok(info)
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        if let Some(record) = self.inner.forwards.lock().unwrap().remove(id) {
            stop_tunnel(&record);
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self
            .inner
            .forwards
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
}

impl OriginProxy {
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut connections) = self.connections.lock() {
            for (_, connection) in connections.drain() {
                let _ = connection.client.shutdown(Shutdown::Both);
                if let Some(target) = connection.target {
                    let _ = target.shutdown(Shutdown::Both);
                }
            }
        }
    }
}

fn start_origin_proxy(
    target_address: &str,
    target_port: u16,
) -> Result<(OriginProxy, u16), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("could not prepare public sharing: {error}"))?;
    listener.set_nonblocking(true).map_err(err)?;
    let proxy_port = listener.local_addr().map_err(err)?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let connections = ActiveConnections::default();
    let thread_stop = Arc::clone(&stop);
    let thread_connections = Arc::clone(&connections);
    let addresses = origin_addresses(target_address);
    let host_header = format!("localhost:{target_port}");
    std::thread::Builder::new()
        .name(format!("public-origin-{proxy_port}"))
        .spawn(move || {
            origin_proxy_loop(
                listener,
                target_port,
                addresses,
                host_header,
                thread_stop,
                thread_connections,
            )
        })
        .map_err(err)?;
    Ok((OriginProxy { stop, connections }, proxy_port))
}

fn origin_proxy_loop(
    listener: TcpListener,
    target_port: u16,
    addresses: Vec<String>,
    host_header: String,
    stop: Arc<AtomicBool>,
    connections: ActiveConnections,
) {
    let mut next_id = 0_u64;
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((client, _)) => {
                let Ok(tracked_client) = client.try_clone() else {
                    let _ = client.shutdown(Shutdown::Both);
                    continue;
                };
                let id = next_id;
                next_id = next_id.wrapping_add(1);
                connections.lock().unwrap().insert(
                    id,
                    ActiveConnection {
                        client: tracked_client,
                        target: None,
                    },
                );
                let connection_stop = Arc::clone(&stop);
                let connection_list = Arc::clone(&connections);
                let connection_addresses = addresses.clone();
                let connection_host = host_header.clone();
                std::thread::spawn(move || {
                    proxy_http_connection(
                        client,
                        target_port,
                        &connection_addresses,
                        &connection_host,
                        id,
                        connection_stop,
                        connection_list,
                    )
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(_) => break,
        }
    }
}

fn proxy_http_connection(
    mut client: TcpStream,
    target_port: u16,
    addresses: &[String],
    host_header: &str,
    id: u64,
    stop: Arc<AtomicBool>,
    connections: ActiveConnections,
) {
    let (head, trailing) = match read_request_head(&mut client) {
        Ok(request) => request,
        Err(_) => {
            remove_connection(&connections, id);
            let _ = client.shutdown(Shutdown::Both);
            return;
        }
    };
    if is_tunnel_readiness_request(&head) {
        let _ = client.write_all(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        remove_connection(&connections, id);
        let _ = client.shutdown(Shutdown::Write);
        return;
    }
    let target = addresses
        .iter()
        .find_map(|address| TcpStream::connect((address.as_str(), target_port)).ok());
    let Some(mut target) = target else {
        remove_connection(&connections, id);
        let _ = client.shutdown(Shutdown::Both);
        return;
    };
    let Ok(tracked_target) = target.try_clone() else {
        remove_connection(&connections, id);
        return;
    };
    if let Some(connection) = connections.lock().unwrap().get_mut(&id) {
        connection.target = Some(tracked_target);
    }

    let result = rewrite_request_head(&head, host_header).and_then(|rewritten| {
        target.write_all(&rewritten)?;
        target.write_all(&trailing)
    });
    if result.is_err() || stop.load(Ordering::Acquire) {
        remove_connection(&connections, id);
        let _ = client.shutdown(Shutdown::Both);
        let _ = target.shutdown(Shutdown::Both);
        return;
    }

    proxy_both_directions(client, target);
    remove_connection(&connections, id);
}

fn is_tunnel_readiness_request(head: &[u8]) -> bool {
    std::str::from_utf8(head)
        .ok()
        .and_then(|raw| raw.lines().next())
        .and_then(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?, parts.next()?))
        })
        .is_some_and(|(method, path)| method == "GET" && path == TUNNEL_READY_PATH)
}

fn read_request_head(stream: &mut TcpStream) -> io::Result<(Vec<u8>, Vec<u8>)> {
    const MAX_HEAD: usize = 64 * 1024;
    let mut received = Vec::new();
    let mut chunk = [0_u8; 2048];
    loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before the HTTP request",
            ));
        }
        received.extend_from_slice(&chunk[..count]);
        if let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") {
            let trailing = received.split_off(end + 4);
            return Ok((received, trailing));
        }
        if received.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP request headers are too large",
            ));
        }
    }
}

fn rewrite_request_head(head: &[u8], host: &str) -> io::Result<Vec<u8>> {
    let raw = std::str::from_utf8(head)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP request headers"))?;
    let upgrade = raw.lines().any(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("upgrade"))
            .is_some()
    });
    let mut output = String::new();
    let mut wrote_host = false;
    let mut wrote_connection = false;
    for line in raw.trim_end_matches("\r\n\r\n").split("\r\n") {
        if let Some((name, _)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                output.push_str(&format!("Host: {host}\r\n"));
                wrote_host = true;
                continue;
            }
            if name.eq_ignore_ascii_case("connection") && !upgrade {
                output.push_str("Connection: close\r\n");
                wrote_connection = true;
                continue;
            }
        }
        output.push_str(line);
        output.push_str("\r\n");
    }
    if !wrote_host {
        output.push_str(&format!("Host: {host}\r\n"));
    }
    if !upgrade && !wrote_connection {
        output.push_str("Connection: close\r\n");
    }
    output.push_str("\r\n");
    Ok(output.into_bytes())
}

fn proxy_both_directions(client: TcpStream, target: TcpStream) {
    let Ok(mut client_reader) = client.try_clone() else {
        return;
    };
    let Ok(mut target_writer) = target.try_clone() else {
        return;
    };
    let upstream = std::thread::spawn(move || {
        let _ = io::copy(&mut client_reader, &mut target_writer);
    });
    let mut target_reader = target;
    let mut client_writer = client;
    let _ = io::copy(&mut target_reader, &mut client_writer);
    let _ = client_writer.shutdown(Shutdown::Both);
    let _ = upstream.join();
}

fn remove_connection(connections: &ActiveConnections, id: u64) {
    connections.lock().unwrap().remove(&id);
}

fn origin_addresses(address: &str) -> Vec<String> {
    let address = address.trim_matches(['[', ']']);
    if address == "*" {
        return vec!["127.0.0.1".to_string(), "::1".to_string()];
    }
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) if ip.is_unspecified() => vec!["127.0.0.1".to_string()],
        Ok(IpAddr::V6(ip)) if ip.is_unspecified() => vec!["::1".to_string()],
        _ => vec![address.to_string()],
    }
}

fn tunnel_finished(record: &ForwardRecord) -> bool {
    record
        .child
        .lock()
        .map(|mut child| child.try_wait().ok().flatten().is_some())
        .unwrap_or(true)
}

fn stop_tunnel(record: &ForwardRecord) {
    if let Ok(mut child) = record.child.lock() {
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    record.proxy.stop();
}

fn start_public_tunnel(proxy_port: u16, tools_dir: &Path) -> Result<(Child, String), String> {
    let mut failures = Vec::new();
    if let Some(cloudflared) = find_tunnel_executable("cloudflared", tools_dir) {
        match start_cloudflare_tunnel(cloudflared, proxy_port) {
            Ok(tunnel) => return Ok(tunnel),
            Err(error) => failures.push(format!("Cloudflare: {error}")),
        }
    }
    if let Some(ngrok) = find_tunnel_executable("ngrok", tools_dir) {
        match start_ngrok_tunnel(ngrok, proxy_port) {
            Ok(tunnel) => return Ok(tunnel),
            Err(error) => failures.push(format!("ngrok: {error}")),
        }
    }
    if executable_on_path("ssh").is_some() {
        match start_ssh_tunnel(proxy_port, tools_dir) {
            Ok(tunnel) => return Ok(tunnel),
            Err(error) => failures.push(format!("SSH: {error}")),
        }
    }
    if failures.is_empty() {
        Err("Public sharing requires cloudflared or OpenSSH".to_string())
    } else {
        Err(format!(
            "No public tunnel passed the connection check. {}",
            failures.join(" ")
        ))
    }
}

fn start_ngrok_tunnel(ngrok: PathBuf, proxy_port: u16) -> Result<(Child, String), String> {
    let origin = format!("http://127.0.0.1:{proxy_port}");
    let mut command = Command::new(ngrok);
    command.args(["http", &origin, "--log", "stdout", "--log-format", "json"]);
    let (mut child, lines) = spawn_tunnel_process(command)?;
    match wait_for_tunnel_url(&mut child, lines) {
        Ok(url) => match wait_for_reachable_public_url(&url) {
            Ok(()) => Ok((child, url)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        },
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn start_cloudflare_tunnel(
    cloudflared: PathBuf,
    proxy_port: u16,
) -> Result<(Child, String), String> {
    let origin = format!("http://127.0.0.1:{proxy_port}");
    let mut command = Command::new(cloudflared);
    // HTTP/2 works over TCP 443 and is more reliable on networks that block
    // the UDP traffic used by QUIC.
    command.args([
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--url",
        &origin,
    ]);
    let (mut child, lines) = spawn_tunnel_process(command)?;
    // The public URL is followed by an end-to-end HTTP readiness check, so
    // there is no need to depend on cloudflared's changing connection-log
    // wording before proceeding.
    match wait_for_tunnel_url(&mut child, lines) {
        Ok(url) => match wait_for_reachable_public_url(&url) {
            Ok(()) => Ok((child, url)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        },
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn wait_for_reachable_public_url(url: &str) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(err)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut last_error = "the public address was not reachable".to_string();
    let readiness_url = format!("{}{}", url.trim_end_matches('/'), TUNNEL_READY_PATH);

    while std::time::Instant::now() < deadline {
        match client
            .get(&readiness_url)
            .header(
                reqwest::header::USER_AGENT,
                "Duckweed tunnel readiness check",
            )
            // Free ngrok endpoints otherwise return their browser interstitial
            // instead of forwarding this readiness request to Duckweed.
            .header("ngrok-skip-browser-warning", "duckweed")
            .send()
        {
            Ok(response) if response.status() == reqwest::StatusCode::NO_CONTENT => return Ok(()),
            Ok(response) => {
                last_error = format!(
                    "the tunnel readiness check returned HTTP {}",
                    response.status()
                );
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    Err(format!(
        "the public address could not reach the local server: {last_error}"
    ))
}

fn start_ssh_tunnel(proxy_port: u16, tools_dir: &Path) -> Result<(Child, String), String> {
    let ssh = executable_on_path("ssh").ok_or_else(|| "OpenSSH is not installed".to_string())?;
    std::fs::create_dir_all(tools_dir).map_err(err)?;
    let known_hosts = tools_dir.join("public-tunnel-known-hosts");
    let known_hosts_option = format!("UserKnownHostsFile={}", known_hosts.display());
    let reverse = format!("80:127.0.0.1:{proxy_port}");
    let mut command = Command::new(ssh);
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        &known_hosts_option,
        "-R",
        &reverse,
        "nokey@localhost.run",
    ]);
    let (mut child, lines) = spawn_tunnel_process(command)?;
    match wait_for_tunnel_url(&mut child, lines) {
        Ok(url) => match wait_for_reachable_public_url(&url) {
            Ok(()) => Ok((child, url)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        },
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn spawn_tunnel_process(mut command: Command) -> Result<(Child, mpsc::Receiver<String>), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_if_windows(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start the tunnel helper: {error}"))?;
    let (sender, lines) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        drain_tunnel_output(stdout, sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        drain_tunnel_output(stderr, sender);
    }
    Ok((child, lines))
}

fn drain_tunnel_output(reader: impl Read + Send + 'static, sender: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
}

fn wait_for_tunnel_url(child: &mut Child, lines: mpsc::Receiver<String>) -> Result<String, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(35);
    let mut public_url = None;
    let mut recent = Vec::new();

    while std::time::Instant::now() < deadline {
        match lines.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if public_url.is_none() {
                    public_url = extract_public_url(&line);
                }
                if recent.len() == 12 {
                    recent.remove(0);
                }
                recent.push(line);
                if let Some(url) = public_url.as_ref() {
                    return Ok(url.clone());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }

        if let Some(status) = child.try_wait().map_err(err)? {
            let detail = recent_helper_error(&recent).unwrap_or_else(|| {
                "the tunnel helper exited before returning an address".to_string()
            });
            return Err(format!("public sharing stopped ({status}): {detail}"));
        }
    }

    if let Some(url) = public_url {
        return Ok(url);
    }
    Err("timed out while creating the public address; check your internet connection".to_string())
}

fn extract_public_url(line: &str) -> Option<String> {
    line.match_indices("https://").find_map(|(start, _)| {
        let candidate: String = line[start..]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '/' | '.' | '-'))
            .collect();
        let host = candidate.strip_prefix("https://")?;
        let reserved = matches!(
            host,
            "admin.localhost.run" | "docs.localhost.run" | "www.localhost.run" | "localhost.run"
        );
        let valid_provider = host.ends_with(".trycloudflare.com")
            || host.ends_with(".pinggy.link")
            || host.ends_with(".ngrok-free.app")
            || host.ends_with(".ngrok.app")
            || host.ends_with(".ngrok-free.dev")
            || host.ends_with(".lhr.life")
            || (host.ends_with(".localhost.run") && !reserved);
        (valid_provider
            && host
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-')))
        .then_some(candidate)
    })
}

fn compact_helper_error(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .or_else(|| value.get("err"))
                .and_then(|message| message.as_str())
                .map(|message| message.chars().take(240).collect())
        })
        .unwrap_or_else(|| line.chars().take(240).collect())
}

fn recent_helper_error(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .rev()
        .filter(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
        .map(|line| compact_helper_error(line))
        .find(|line| !line.trim().is_empty())
        .or_else(|| {
            lines
                .iter()
                .rev()
                .map(|line| compact_helper_error(line))
                .find(|line| {
                    let line = line.trim();
                    !line.is_empty() && line != "ERROR:"
                })
        })
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |candidate| dir.join(candidate)))
        .find(|candidate| candidate.is_file())
}

fn find_tunnel_executable(name: &str, tools_dir: &Path) -> Option<PathBuf> {
    let executable_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let managed = tools_dir.join(&executable_name);
    if managed.is_file() {
        return Some(managed);
    }
    if let Some(executable) = executable_on_path(name) {
        return Some(executable);
    }

    #[cfg(windows)]
    {
        if name == "cloudflared" {
            if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                let local_app_data = PathBuf::from(local_app_data);
                let link = local_app_data
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(&executable_name);
                if link.is_file() {
                    return Some(link);
                }

                let packages = local_app_data
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Packages");
                if let Ok(entries) = std::fs::read_dir(packages) {
                    for package in entries.flatten() {
                        if !package
                            .file_name()
                            .to_string_lossy()
                            .starts_with("Cloudflare.cloudflared_")
                        {
                            continue;
                        }
                        let executable = package.path().join(&executable_name);
                        if executable.is_file() {
                            return Some(executable);
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .into_iter()
            .map(|directory| Path::new(directory).join(&executable_name))
            .find(|candidate| candidate.is_file())
    }

    #[cfg(windows)]
    None
}

fn hide_console_if_windows(command: &mut Command) {
    #[cfg(windows)]
    hide_console(command);
}

fn owner_map(
    processes: &[ProcessInfo],
    terminals: &PtyManager,
    agents: &AgentProcManager,
) -> HashMap<u32, Owner> {
    let mut roots = Vec::new();
    for (id, pid) in terminals.root_processes() {
        roots.push((
            pid,
            Owner {
                id,
                kind: "terminal",
            },
        ));
    }
    for (id, pid) in agents.root_processes() {
        roots.push((pid, Owner { id, kind: "agent" }));
    }
    owner_map_from_roots(processes, roots)
}

fn owner_map_from_roots(
    processes: &[ProcessInfo],
    roots: impl IntoIterator<Item = (u32, Owner)>,
) -> HashMap<u32, Owner> {
    let mut owners: HashMap<u32, Owner> = roots.into_iter().collect();

    // Process snapshots are not guaranteed to be parent-first. Repeated passes
    // propagate each known root through the full descendant tree.
    loop {
        let mut changed = false;
        for process in processes {
            if owners.contains_key(&process.pid) {
                continue;
            }
            if let Some(owner) = owners.get(&process.ppid).cloned() {
                owners.insert(process.pid, owner);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    owners
}

/// Some interactive CLIs open loopback listeners for their own IPC. Those
/// sockets belong to the terminal process tree, but they are not local servers
/// the user can open or share from the Ports tool.
fn is_internal_cli_listener(process_name: &str) -> bool {
    let executable = Path::new(process_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(process_name)
        .to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);

    matches!(
        executable,
        "agy" | "antigravity" | "antigravity-cli" | "cli-proxy-api"
    )
}

pub fn snapshot(
    terminals: &PtyManager,
    agents: &AgentProcManager,
    manager: &PortManager,
) -> PortSnapshot {
    let processes = process_tree::process_snapshot();
    let owners = owner_map(&processes, terminals, agents);
    let names: HashMap<u32, String> = processes
        .into_iter()
        .map(|process| (process.pid, process.name))
        .collect();
    let mut listeners = platform_listeners();
    listeners.retain(|listener| {
        owners.contains_key(&listener.pid)
            && !names
                .get(&listener.pid)
                .is_some_and(|name| is_internal_cli_listener(name))
    });

    let mut seen = HashSet::new();
    listeners.retain(|listener| seen.insert((listener.pid, listener.port)));
    listeners.sort_by_key(|listener| (listener.port, listener.pid));

    let active: HashSet<(u32, u16)> = listeners
        .iter()
        .map(|listener| (listener.pid, listener.port))
        .collect();
    manager.reconcile(&active);
    let forwards = manager.forwards();

    let ports = listeners
        .into_iter()
        .filter_map(|listener| {
            let owner = owners.get(&listener.pid)?;
            let forward = forwards
                .iter()
                .find(|forward| {
                    forward.target_pid == listener.pid && forward.target_port == listener.port
                })
                .cloned();
            Some(PortInfo {
                pid: listener.pid,
                port: listener.port,
                address: listener.address,
                process: names
                    .get(&listener.pid)
                    .cloned()
                    .unwrap_or_else(|| "process".to_string()),
                owner_id: owner.id.clone(),
                owner_kind: owner.kind.to_string(),
                forward,
            })
        })
        .collect();

    PortSnapshot {
        ports,
        scanned_at: now_ms(),
    }
}

pub fn close(
    pid: u32,
    port: u16,
    terminals: &PtyManager,
    agents: &AgentProcManager,
    manager: &PortManager,
) -> Result<(), String> {
    let current = snapshot(terminals, agents, manager);
    if !current
        .ports
        .iter()
        .any(|entry| entry.pid == pid && entry.port == port)
    {
        return Err("that port is no longer owned by a Duckweed process".to_string());
    }
    manager.stop_for_target(pid);
    kill_process_tree(pid)
}

pub fn forward(
    pid: u32,
    port: u16,
    terminals: &PtyManager,
    agents: &AgentProcManager,
    manager: &PortManager,
    tools_dir: &Path,
) -> Result<ForwardInfo, String> {
    let current = snapshot(terminals, agents, manager);
    if !current
        .ports
        .iter()
        .any(|entry| entry.pid == pid && entry.port == port)
    {
        return Err("that port is no longer owned by a Duckweed process".to_string());
    }
    let target = current
        .ports
        .iter()
        .find(|entry| entry.pid == pid && entry.port == port)
        .ok_or_else(|| "that port is no longer owned by a Duckweed process".to_string())?;
    manager.start(pid, port, &target.address, tools_dir)
}

fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console(&mut command);
        let output = command.output().map_err(err)?;
        if output.status.success() {
            return Ok(());
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    #[cfg(unix)]
    {
        let output = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(err)?;
        if output.status.success() {
            return Ok(());
        }
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(windows)]
fn platform_listeners() -> Vec<Listener> {
    let mut command = Command::new("netstat");
    command.args(["-ano", "-p", "tcp"]);
    hide_console(&mut command);
    command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_windows_netstat(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_listeners() -> Vec<Listener> {
    Command::new("ss")
        .args(["-ltnpH"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_linux_ss(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn platform_listeners() -> Vec<Listener> {
    Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_macos_lsof(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

fn parse_endpoint(endpoint: &str) -> Option<(String, u16)> {
    let split = endpoint.rfind(':')?;
    let address = endpoint.get(..split)?.trim_matches(['[', ']']).to_string();
    let port = endpoint.get(split + 1..)?.parse().ok()?;
    Some((address, port))
}

#[cfg(any(windows, test))]
fn parse_windows_netstat(raw: &str) -> Vec<Listener> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("TCP") {
                return None;
            }
            // Windows localizes some netstat state labels. A TCP listener still
            // has a wildcard remote endpoint on port zero in every locale.
            let (_, remote_port) = parse_endpoint(fields[2])?;
            if remote_port != 0 {
                return None;
            }
            let (address, port) = parse_endpoint(fields[1])?;
            let pid = fields[4].parse().ok()?;
            Some(Listener { address, port, pid })
        })
        .collect()
}

#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn parse_linux_ss(raw: &str) -> Vec<Listener> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let endpoint = fields.get(3).or_else(|| fields.get(4))?;
            let pid_start = line.find("pid=")? + 4;
            let pid_end = line[pid_start..]
                .find(|ch: char| !ch.is_ascii_digit())
                .map(|offset| pid_start + offset)
                .unwrap_or(line.len());
            let pid = line.get(pid_start..pid_end)?.parse().ok()?;
            let (address, port) = parse_endpoint(endpoint)?;
            Some(Listener { address, port, pid })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn parse_macos_lsof(raw: &str) -> Vec<Listener> {
    let mut pid = None;
    let mut listeners = Vec::new();
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let (Some(owner), Some(endpoint)) = (pid, line.strip_prefix('n')) {
            if let Some((address, port)) = parse_endpoint(endpoint) {
                listeners.push(Listener {
                    address,
                    port,
                    pid: owner,
                });
            }
        }
    }
    listeners
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_windows_ipv4_and_ipv6_listeners() {
        let raw = "  TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    42\n\
                   TCP    [::]:5173         [::]:0       LISTENING    99\n\
                   TCP    127.0.0.1:4000    1.2.3.4:20   ESTABLISHED  42";
        let ports = parse_windows_netstat(raw);
        assert_eq!(ports.len(), 2);
        assert_eq!((ports[0].port, ports[0].pid), (3000, 42));
        assert_eq!((ports[1].port, ports[1].pid), (5173, 99));
    }

    #[test]
    fn parses_linux_ss_listener() {
        let raw = "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=321,fd=21))";
        let ports = parse_linux_ss(raw);
        assert_eq!(ports.len(), 1);
        assert_eq!((ports[0].port, ports[0].pid), (3000, 321));
    }

    #[test]
    fn tunneling_uses_explicit_listener_addresses_and_maps_wildcards() {
        assert_eq!(origin_addresses("192.168.1.20"), vec!["192.168.1.20"]);
        assert_eq!(origin_addresses("0.0.0.0"), vec!["127.0.0.1"]);
        assert_eq!(origin_addresses("::"), vec!["::1"]);
        assert_eq!(origin_addresses("*"), vec!["127.0.0.1", "::1"]);
    }

    #[test]
    fn public_proxy_rewrites_hosts_and_closes_regular_http_connections() {
        let request = b"GET / HTTP/1.1\r\nHost: random.lhr.life\r\nAccept: */*\r\n\r\n";
        let rewritten =
            String::from_utf8(rewrite_request_head(request, "localhost:5173").unwrap()).unwrap();
        assert!(rewritten.contains("\r\nHost: localhost:5173\r\n"));
        assert!(rewritten.contains("\r\nConnection: close\r\n"));
        assert!(!rewritten.contains("random.lhr.life"));
    }

    #[test]
    fn public_proxy_preserves_websocket_upgrades() {
        let request = b"GET /socket HTTP/1.1\r\nHost: random.lhr.life\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
        let rewritten =
            String::from_utf8(rewrite_request_head(request, "localhost:3000").unwrap()).unwrap();
        assert!(rewritten.contains("\r\nHost: localhost:3000\r\n"));
        assert!(rewritten.contains("\r\nConnection: Upgrade\r\n"));
        assert!(!rewritten.contains("Connection: close"));
    }

    #[test]
    fn recognizes_only_the_internal_tunnel_readiness_request() {
        assert!(is_tunnel_readiness_request(
            b"GET /.well-known/duckweed-tunnel-ready HTTP/1.1\r\nHost: public.example\r\n\r\n"
        ));
        assert!(!is_tunnel_readiness_request(
            b"POST /.well-known/duckweed-tunnel-ready HTTP/1.1\r\nHost: public.example\r\n\r\n"
        ));
        assert!(!is_tunnel_readiness_request(
            b"GET / HTTP/1.1\r\nHost: public.example\r\n\r\n"
        ));
    }

    #[test]
    fn extracts_only_valid_localhost_run_addresses() {
        assert_eq!(
            extract_public_url("Your tunnel is https://tiny-river.lhr.life"),
            Some("https://tiny-river.lhr.life".to_string())
        );
        assert_eq!(
            extract_public_url("docs: https://admin.localhost.run tunnel: https://abc123.lhr.life"),
            Some("https://abc123.lhr.life".to_string())
        );
        assert_eq!(
            extract_public_url("https://random-name.localhost.run is ready"),
            Some("https://random-name.localhost.run".to_string())
        );
        assert_eq!(
            extract_public_url("https://small-cloud-pond.trycloudflare.com is ready"),
            Some("https://small-cloud-pond.trycloudflare.com".to_string())
        );
        assert_eq!(
            extract_public_url("https://example.com should not be accepted"),
            None
        );
        assert_eq!(extract_public_url("https://admin.localhost.run"), None);
    }

    #[test]
    fn extracts_a_readable_tunnel_helper_error() {
        assert_eq!(
            compact_helper_error(r#"{"level":"error","message":"connection refused"}"#),
            "connection refused"
        );
        assert_eq!(
            recent_helper_error(&[
                r#"{"lvl":"eror","err":"authentication failed"}"#.to_string(),
                "ERROR:".to_string(),
            ]),
            Some("authentication failed".to_string())
        );
    }

    #[test]
    fn origin_proxy_forwards_http_and_rewrites_the_host() {
        use std::io::{Read, Write};
        use std::sync::mpsc;

        let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let (request_tx, request_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = origin.accept().unwrap();
            let mut bytes = [0_u8; 4096];
            let count = stream.read(&mut bytes).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&bytes[..count]).to_string())
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nduckweed-tunnel",
                )
                .unwrap();
        });

        let (proxy, proxy_port) = start_origin_proxy("127.0.0.1", origin_port).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: public.example\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        proxy.stop();
        server.join().unwrap();

        let request = request_rx.recv().unwrap();
        assert!(request.contains("\r\nHost: localhost:"));
        assert!(request.contains("\r\nConnection: close\r\n"));
        assert!(response.ends_with("duckweed-tunnel"));
    }

    #[test]
    fn origin_proxy_does_not_forward_empty_tunnel_probes() {
        let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        origin.set_nonblocking(true).unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let (proxy, proxy_port) = start_origin_proxy("127.0.0.1", origin_port).unwrap();
        let probe = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
        drop(probe);
        std::thread::sleep(Duration::from_millis(250));

        let accepted = origin.accept();
        proxy.stop();
        assert!(
            matches!(accepted, Err(error) if error.kind() == io::ErrorKind::WouldBlock),
            "an empty provider probe reached the project server"
        );
    }

    #[test]
    #[ignore = "requires cloudflared and internet access"]
    fn cloudflare_tunnel_is_reachable_end_to_end() {
        let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = origin.accept().unwrap();
            let mut bytes = [0_u8; 4096];
            let _ = stream.read(&mut bytes).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nduckweed-public",
                )
                .unwrap();
        });

        let tools = std::env::temp_dir().join("duckweed-missing-tools");
        let cloudflared =
            find_tunnel_executable("cloudflared", &tools).expect("cloudflared is installed");
        let (proxy, proxy_port) = start_origin_proxy("127.0.0.1", origin_port).unwrap();
        let origin_url = format!("http://127.0.0.1:{proxy_port}");
        let mut command = Command::new(cloudflared);
        command.args([
            "tunnel",
            "--no-autoupdate",
            "--protocol",
            "http2",
            "--url",
            &origin_url,
        ]);
        let (mut child, lines) = spawn_tunnel_process(command).unwrap();
        let url = wait_for_tunnel_url(&mut child, lines).unwrap();
        let readiness_url = format!("{url}{TUNNEL_READY_PATH}");
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let response = match client.get(&readiness_url).send() {
            Ok(response) => response,
            Err(error) => {
                eprintln!("request error: {error:?}");
                let mut source = std::error::Error::source(&error);
                while let Some(error) = source {
                    eprintln!("caused by: {error:?}");
                    source = error.source();
                }
                let _ = child.kill();
                let _ = child.wait();
                proxy.stop();
                panic!("readiness request failed");
            }
        };
        assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
        let response = reqwest::blocking::get(&url).unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().unwrap(), "duckweed-public");

        let _ = child.kill();
        let _ = child.wait();
        proxy.stop();
        server.join().unwrap();
    }

    #[test]
    fn ownership_reaches_nested_children_in_any_snapshot_order() {
        let processes = vec![
            ProcessInfo {
                pid: 12,
                ppid: 11,
                name: "node".into(),
            },
            ProcessInfo {
                pid: 11,
                ppid: 10,
                name: "npm".into(),
            },
            ProcessInfo {
                pid: 90,
                ppid: 1,
                name: "unrelated".into(),
            },
        ];
        let owners = owner_map_from_roots(
            &processes,
            [(
                10,
                Owner {
                    id: "term-1".into(),
                    kind: "terminal",
                },
            )],
        );
        assert_eq!(
            owners.get(&12).map(|owner| owner.id.as_str()),
            Some("term-1")
        );
        assert!(!owners.contains_key(&90));
    }

    #[test]
    fn hides_antigravity_cli_internal_listeners() {
        assert!(is_internal_cli_listener("agy.exe"));
        assert!(is_internal_cli_listener("AGY.EXE"));
        assert!(is_internal_cli_listener("antigravity"));
        assert!(is_internal_cli_listener("antigravity-cli"));
        assert!(is_internal_cli_listener("cli-proxy-api.exe"));
        assert!(!is_internal_cli_listener("node.exe"));
        assert!(!is_internal_cli_listener("python"));
    }
}
