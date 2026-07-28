//! Discover listening servers launched from Duckweed and share them on the LAN.
//!
//! Ownership is derived from process ancestry. A PID must descend from a live
//! PTY shell or headless agent before it can be listed, stopped, or forwarded.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub public_port: u16,
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
    stop: Arc<AtomicBool>,
    connections: ActiveConnections,
}

struct ActiveConnection {
    client: TcpStream,
    target: Option<TcpStream>,
}

type ActiveConnections = Arc<Mutex<HashMap<u64, ActiveConnection>>>;

#[derive(Default)]
struct PortInner {
    forwards: Mutex<HashMap<String, ForwardRecord>>,
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
    ) -> Result<ForwardInfo, String> {
        if let Some(existing) = self
            .forwards()
            .into_iter()
            .find(|forward| forward.target_pid == pid && forward.target_port == target_port)
        {
            return Ok(existing);
        }

        let listener = TcpListener::bind(("0.0.0.0", 0))
            .map_err(|error| format!("could not open a network port: {error}"))?;
        listener.set_nonblocking(true).map_err(err)?;
        let public_port = listener.local_addr().map_err(err)?.port();
        let ip = local_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
        let id = format!("forward-{pid}-{target_port}");
        let info = ForwardInfo {
            id: id.clone(),
            target_pid: pid,
            target_port,
            public_port,
            url: format!("http://{ip}:{public_port}"),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let connections = ActiveConnections::default();
        let thread_stop = Arc::clone(&stop);
        let thread_connections = Arc::clone(&connections);
        let target_addresses = forward_target_addresses(target_address);

        std::thread::Builder::new()
            .name(format!("port-forward-{public_port}"))
            .spawn(move || {
                forward_loop(
                    listener,
                    target_port,
                    target_addresses,
                    thread_stop,
                    thread_connections,
                )
            })
            .map_err(err)?;

        self.inner.forwards.lock().unwrap().insert(
            id,
            ForwardRecord {
                info: info.clone(),
                stop,
                connections,
            },
        );
        Ok(info)
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        if let Some(record) = self.inner.forwards.lock().unwrap().remove(id) {
            record.stop.store(true, Ordering::Release);
            let mut connections = record.connections.lock().unwrap();
            for (_, connection) in connections.drain() {
                shutdown_connection(&connection);
            }
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

fn forward_loop(
    listener: TcpListener,
    target_port: u16,
    target_addresses: Vec<String>,
    stop: Arc<AtomicBool>,
    connections: ActiveConnections,
) {
    let mut next_connection_id = 0_u64;
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((client, _)) => {
                if stop.load(Ordering::Acquire) {
                    let _ = client.shutdown(Shutdown::Both);
                    break;
                }
                let Ok(tracked_client) = client.try_clone() else {
                    let _ = client.shutdown(Shutdown::Both);
                    continue;
                };
                let connection_id = next_connection_id;
                next_connection_id = next_connection_id.wrapping_add(1);
                connections.lock().unwrap().insert(
                    connection_id,
                    ActiveConnection {
                        client: tracked_client,
                        target: None,
                    },
                );
                let connection_stop = Arc::clone(&stop);
                let connection_list = Arc::clone(&connections);
                let connection_targets = target_addresses.clone();
                std::thread::spawn(move || {
                    forward_connection(
                        client,
                        target_port,
                        &connection_targets,
                        connection_id,
                        connection_stop,
                        connection_list,
                    );
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(_) => break,
        }
    }
}

fn forward_connection(
    client: TcpStream,
    target_port: u16,
    target_addresses: &[String],
    connection_id: u64,
    stop: Arc<AtomicBool>,
    connections: ActiveConnections,
) {
    if stop.load(Ordering::Acquire) {
        remove_connection(&connections, connection_id);
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    let target = target_addresses
        .iter()
        .find_map(|address| TcpStream::connect((address.as_str(), target_port)).ok());
    let Some(target) = target else {
        remove_connection(&connections, connection_id);
        let _ = client.shutdown(Shutdown::Both);
        return;
    };
    let Ok(tracked_target) = target.try_clone() else {
        remove_connection(&connections, connection_id);
        let _ = client.shutdown(Shutdown::Both);
        let _ = target.shutdown(Shutdown::Both);
        return;
    };

    let registered = {
        let mut active = connections.lock().unwrap();
        if stop.load(Ordering::Acquire) {
            active.remove(&connection_id);
            false
        } else if let Some(connection) = active.get_mut(&connection_id) {
            connection.target = Some(tracked_target);
            true
        } else {
            false
        }
    };
    if !registered {
        let _ = client.shutdown(Shutdown::Both);
        let _ = target.shutdown(Shutdown::Both);
        return;
    }

    proxy_connection(client, target);
    remove_connection(&connections, connection_id);
}

fn remove_connection(connections: &ActiveConnections, connection_id: u64) {
    connections.lock().unwrap().remove(&connection_id);
}

fn shutdown_connection(connection: &ActiveConnection) {
    let _ = connection.client.shutdown(Shutdown::Both);
    if let Some(target) = &connection.target {
        let _ = target.shutdown(Shutdown::Both);
    }
}

fn forward_target_addresses(address: &str) -> Vec<String> {
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

fn proxy_connection(client: TcpStream, target: TcpStream) {
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

fn local_lan_ip() -> Option<String> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() => Some(ip.to_string()),
        _ => None,
    }
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
        roots.push((
            pid,
            Owner {
                id,
                kind: "agent",
            },
        ));
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
    listeners.retain(|listener| owners.contains_key(&listener.pid));

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
    manager.start(pid, port, &target.address)
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
        let raw =
            "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=321,fd=21))";
        let ports = parse_linux_ss(raw);
        assert_eq!(ports.len(), 1);
        assert_eq!((ports[0].port, ports[0].pid), (3000, 321));
    }

    #[test]
    fn forwarding_proxies_both_directions() {
        use std::io::{Read, Write};

        let source = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let target_port = source.local_addr().unwrap().port();
        let source_thread = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let mut request = [0_u8; 4];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"ping");
            stream.write_all(b"pong").unwrap();
        });

        let manager = PortManager::default();
        let forward = manager.start(123, target_port, "127.0.0.1").unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", forward.public_port)).unwrap();
        client.write_all(b"ping").unwrap();
        let mut response = [0_u8; 4];
        client.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"pong");

        manager.stop_all();
        source_thread.join().unwrap();
    }

    #[test]
    fn forwarding_uses_explicit_listener_addresses_and_maps_wildcards() {
        assert_eq!(
            forward_target_addresses("192.168.1.20"),
            vec!["192.168.1.20"]
        );
        assert_eq!(forward_target_addresses("0.0.0.0"), vec!["127.0.0.1"]);
        assert_eq!(forward_target_addresses("::"), vec!["::1"]);
        assert_eq!(forward_target_addresses("*"), vec!["127.0.0.1", "::1"]);
    }

    #[test]
    fn stopping_a_forward_disconnects_active_clients() {
        use std::io::Read;
        use std::sync::mpsc;

        let source = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let target_port = source.local_addr().unwrap().port();
        let (accepted_tx, accepted_rx) = mpsc::channel();
        let source_thread = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            accepted_tx.send(()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut byte = [0_u8; 1];
            match stream.read(&mut byte) {
                Ok(0) => {}
                Ok(_) => panic!("the target received data after the forward stopped"),
                Err(error) => assert!(!matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                )),
            }
        });

        let manager = PortManager::default();
        let forward = manager.start(123, target_port, "127.0.0.1").unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", forward.public_port)).unwrap();
        accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        manager.stop(&forward.id).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut byte = [0_u8; 1];
        match client.read(&mut byte) {
            Ok(0) => {}
            Ok(_) => panic!("the client received data after the forward stopped"),
            Err(error) => assert!(!matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            )),
        }

        source_thread.join().unwrap();
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
        assert_eq!(owners.get(&12).map(|owner| owner.id.as_str()), Some("term-1"));
        assert!(!owners.contains_key(&90));
    }
}
