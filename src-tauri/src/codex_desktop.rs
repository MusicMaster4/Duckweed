//! Browser and Computer Use access for Duckweed's Codex threads.
//!
//! The official ChatGPT desktop app owns the local browser access host: a named
//! pipe that signs `browser/access` answers with a per-launch Ed25519 key. The
//! bundled `node_repl` and `cua_repl` MCP servers only reach that host when
//! three variables are in their environment. The desktop app passes them to its
//! own app-server process and to each of its threads. Duckweed talks to the
//! CLI's shared daemon, which never had them, so every browser call failed with
//! "The browser access host is unavailable".
//!
//! Duckweed reads the values from the running desktop app and sends them as
//! per-thread MCP configuration, the same shape the desktop app uses for its
//! own threads. The host still makes the access decision for this ChatGPT
//! account; nothing here signs, grants or bypasses anything.

// Only Windows desktop builds publish the host through process variables.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const ACCESS_PIPE: &str = "BROWSER_USE_ACCESS_PIPE_PATH";
const ACCESS_EXECUTOR: &str = "BROWSER_USE_ACCESS_EXECUTOR_ID";
const ACCESS_IDENTITY: &str = "BROWSER_USE_ACCESS_VERIFYING_IDENTITY";
const APP_TOOLS_PIPE: &str = "CODEX_APP_TOOLS_PIPE_PATH";
const DESKTOP_EXECUTABLES: [&str; 2] = ["ChatGPT.exe", "Codex.exe"];
const COMPUTER_USE_PLUGIN: &str = "unified-computer-use@openai-bundled";

/// Thread configuration that connects one provider thread to the desktop host.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DesktopBridge {
    /// Changes whenever the desktop app restarts with a new pipe or key.
    pub fingerprint: String,
    /// `thread/start`, `thread/resume` and `thread/fork` config overrides.
    pub config: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
struct DesktopHost {
    /// The desktop app's per-launch id, the first element of every executor id.
    instance: String,
    pipe: String,
    identity: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Principal {
    account_id: String,
    user_id: String,
}

pub fn bridge(codex_home: Option<&str>) -> Option<DesktopBridge> {
    let home = codex_home
        .filter(|home| !home.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(crate::home_dir()).join(".codex"));
    let host = find_host()?;
    let principal = read_principal(&home)?;
    let user_config = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let cua_repl = if table_disabled(&user_config, &format!("plugins.\"{COMPUTER_USE_PLUGIN}\"")) {
        None
    } else {
        cua_repl_definition(&home)
    };
    build(&host, &principal, defines_table(&user_config, "mcp_servers.node_repl"), cua_repl)
}

fn build(
    host: &DesktopHost,
    principal: &Principal,
    has_node_repl: bool,
    cua_repl: Option<Value>,
) -> Option<DesktopBridge> {
    // Same shape as the desktop app's own executor ids. Its host only grants
    // access when this matches the account signed in to the desktop app.
    let executor = serde_json::to_string(&[&host.instance, &principal.account_id, &principal.user_id]).ok()?;
    let access = [
        (ACCESS_EXECUTOR, executor.as_str()),
        (ACCESS_PIPE, host.pipe.as_str()),
        (ACCESS_IDENTITY, host.identity.as_str()),
    ];
    let mut config = Map::new();
    // A leaf override for an undefined server would create an invalid entry
    // without a command and make the whole thread fail to start.
    if has_node_repl {
        for (key, value) in access {
            config.insert(format!("mcp_servers.node_repl.env.{key}"), Value::String(value.into()));
        }
    }
    // Plugin servers take their variables from the app-server process, which
    // Duckweed does not own. A thread-level server with the same name takes
    // precedence, which is also how the desktop app configures daemon threads.
    if let Some(Value::Object(mut server)) = cua_repl {
        let env = server.entry("env").or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(env) = env {
            for (key, value) in access {
                env.insert(key.into(), Value::String(value.into()));
            }
            config.insert("mcp_servers.cua_repl".into(), Value::Object(server));
        }
    }
    if config.is_empty() {
        return None;
    }
    Some(DesktopBridge { fingerprint: format!("{}|{}|{}", host.instance, host.pipe, host.identity), config })
}

fn host_from_env(env: &HashMap<String, String>) -> Option<DesktopHost> {
    let value = |key: &str| env.get(key).map(|value| value.trim()).filter(|value| !value.is_empty());
    let pipe = value(APP_TOOLS_PIPE).or_else(|| value(ACCESS_PIPE))?;
    if !pipe.starts_with(r"\\.\pipe\") && !pipe.starts_with('/') {
        return None;
    }
    let identity = value(ACCESS_IDENTITY)?;
    let executor: Vec<String> = serde_json::from_str(value(ACCESS_EXECUTOR)?).ok()?;
    let instance = executor.first().filter(|id| !id.is_empty())?;
    Some(DesktopHost { instance: instance.clone(), pipe: pipe.into(), identity: identity.into() })
}

fn read_principal(home: &Path) -> Option<Principal> {
    let auth: Value = serde_json::from_str(&std::fs::read_to_string(home.join("auth.json")).ok()?).ok()?;
    let tokens = auth.get("tokens")?;
    ["id_token", "access_token"]
        .iter()
        .filter_map(|name| tokens.get(*name).and_then(Value::as_str))
        .find_map(principal_from_jwt)
}

fn principal_from_jwt(token: &str) -> Option<Principal> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let auth = claims.get("https://api.openai.com/auth")?;
    let text = |key: &str| auth.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
    Some(Principal {
        account_id: text("chatgpt_account_id")?.into(),
        user_id: text("user_id").or_else(|| text("chatgpt_user_id"))?.into(),
    })
}

/// The desktop app rewrites the active plugin version's definition at startup,
/// so the newest one carries the current runtime paths and native pipe names.
fn cua_repl_definition(home: &Path) -> Option<Value> {
    let root = home.join("plugins").join("cache").join("openai-bundled").join("unified-computer-use");
    let newest = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(".mcp.json"))
        .filter_map(|path| Some((std::fs::metadata(&path).ok()?.modified().ok()?, path)))
        .max_by_key(|(modified, _)| *modified)?
        .1;
    let definition: Value = serde_json::from_str(&std::fs::read_to_string(newest).ok()?).ok()?;
    let server = definition.get("mcpServers")?.get("cua_repl")?.clone();
    let enabled = server.get("enabled").and_then(Value::as_bool) != Some(false);
    (enabled && server.get("command").and_then(Value::as_str).is_some()).then_some(server)
}

/// Minimal TOML header scan. Duckweed only needs to know whether a table exists
/// or is explicitly disabled; it never rewrites the user's configuration.
fn table_lines<'a>(toml: &'a str, table: &str) -> Option<Vec<&'a str>> {
    let header = format!("[{table}]");
    let mut lines = toml.lines().map(str::trim);
    lines.find(|line| *line == header)?;
    Some(lines.take_while(|line| !line.starts_with('[')).collect())
}

fn defines_table(toml: &str, table: &str) -> bool {
    table_lines(toml, table).is_some()
}

fn table_disabled(toml: &str, table: &str) -> bool {
    table_lines(toml, table).is_some_and(|lines| {
        lines.iter().any(|line| {
            let mut parts = line.splitn(2, '=').map(str::trim);
            parts.next() == Some("enabled") && parts.next().is_some_and(|value| value.starts_with("false"))
        })
    })
}

#[cfg(windows)]
fn find_host() -> Option<DesktopHost> {
    let processes = crate::process_tree::process_snapshot();
    let is_desktop = |name: &str| DESKTOP_EXECUTABLES.iter().any(|exe| exe.eq_ignore_ascii_case(name));
    let desktop: Vec<_> = processes.iter().filter(|process| is_desktop(&process.name)).collect();
    let pids: std::collections::HashSet<u32> = desktop.iter().map(|process| process.pid).collect();
    // The browser process owns the variables. Its children are tried last.
    let mut ordered: Vec<_> = desktop.iter().filter(|process| !pids.contains(&process.ppid)).collect();
    ordered.extend(desktop.iter().filter(|process| pids.contains(&process.ppid)));
    ordered
        .into_iter()
        .filter_map(|process| windows_env::read(process.pid))
        .filter_map(|env| host_from_env(&env))
        .find(|host| windows_env::pipe_exists(&host.pipe))
}

#[cfg(not(windows))]
fn find_host() -> Option<DesktopHost> {
    None
}

#[cfg(windows)]
mod windows_env {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        IsWow64Process, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: isize,
        peb_base_address: usize,
        affinity_mask: usize,
        base_priority: isize,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process: HANDLE,
            class: u32,
            information: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }

    // Stable x64 layout offsets: PEB.ProcessParameters and
    // RTL_USER_PROCESS_PARAMETERS.Environment / EnvironmentSize.
    const PEB_PROCESS_PARAMETERS: usize = 0x20;
    const PARAMETERS_ENVIRONMENT: usize = 0x80;
    const PARAMETERS_ENVIRONMENT_SIZE: usize = 0x3f0;
    const MAX_ENVIRONMENT_BYTES: usize = 4 * 1024 * 1024;

    struct Process(HANDLE);

    impl Drop for Process {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Process {
        fn read<T: Copy>(&self, address: usize) -> Option<T> {
            let mut value = std::mem::MaybeUninit::<T>::uninit();
            let mut read = 0usize;
            let ok = unsafe {
                ReadProcessMemory(self.0, address as *const c_void, value.as_mut_ptr().cast(), size_of::<T>(), &mut read)
            };
            (ok != 0 && read == size_of::<T>()).then(|| unsafe { value.assume_init() })
        }

        fn read_bytes(&self, address: usize, length: usize) -> Option<Vec<u8>> {
            let mut buffer = vec![0u8; length];
            let mut read = 0usize;
            let ok = unsafe {
                ReadProcessMemory(self.0, address as *const c_void, buffer.as_mut_ptr().cast(), length, &mut read)
            };
            if ok == 0 && read == 0 {
                return None;
            }
            buffer.truncate(read);
            Some(buffer)
        }
    }

    /// Environment block of a same-user 64-bit process.
    pub fn read(pid: u32) -> Option<HashMap<String, String>> {
        if cfg!(not(target_pointer_width = "64")) {
            return None;
        }
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let process = Process(handle);
        let mut wow64 = 0;
        if unsafe { IsWow64Process(process.0, &mut wow64) } == 0 || wow64 != 0 {
            return None;
        }
        let mut info = std::mem::MaybeUninit::<ProcessBasicInformation>::zeroed();
        let mut returned = 0u32;
        let status = unsafe {
            NtQueryInformationProcess(
                process.0,
                0,
                info.as_mut_ptr().cast(),
                size_of::<ProcessBasicInformation>() as u32,
                &mut returned,
            )
        };
        if status < 0 {
            return None;
        }
        let peb = unsafe { info.assume_init() }.peb_base_address;
        let parameters: usize = process.read(peb.checked_add(PEB_PROCESS_PARAMETERS)?)?;
        let environment: usize = process.read(parameters.checked_add(PARAMETERS_ENVIRONMENT)?)?;
        let size: usize = process.read(parameters.checked_add(PARAMETERS_ENVIRONMENT_SIZE)?)?;
        if parameters == 0 || environment == 0 {
            return None;
        }
        let length = if size == 0 || size > MAX_ENVIRONMENT_BYTES { 64 * 1024 } else { size };
        Some(parse_block(&process.read_bytes(environment, length)?))
    }

    pub(super) fn parse_block(bytes: &[u8]) -> HashMap<String, String> {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let mut env = HashMap::new();
        for entry in units.split(|unit| *unit == 0) {
            if entry.is_empty() {
                break;
            }
            let entry = String::from_utf16_lossy(entry);
            // Drive-cwd entries such as `=C:=C:\path` have an empty name.
            if let Some((name, value)) = entry.get(1..).and_then(|rest| rest.split_once('=')) {
                let name = format!("{}{}", &entry[..1], name);
                env.insert(name, value.to_string());
            }
        }
        env
    }

    /// Enumerate without connecting: opening the pipe would consume a server
    /// instance and log a rejected client in the desktop app.
    pub fn pipe_exists(pipe: &str) -> bool {
        let wide: Vec<u16> = pipe.encode_utf16().chain(std::iter::once(0)).collect();
        let mut data = std::mem::MaybeUninit::<WIN32_FIND_DATAW>::zeroed();
        let handle = unsafe { FindFirstFileW(wide.as_ptr(), data.as_mut_ptr()) };
        if handle == INVALID_HANDLE_VALUE {
            return false;
        }
        unsafe { FindClose(handle) };
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host() -> DesktopHost {
        DesktopHost {
            instance: "instance-1".into(),
            pipe: r"\\.\pipe\codex-app-tools-1".into(),
            identity: "MCowBQYDK2VwAyEA".into(),
        }
    }

    fn principal() -> Principal {
        Principal { account_id: "account-1".into(), user_id: "user-1".into() }
    }

    #[test]
    fn desktop_env_yields_its_instance_pipe_and_key() {
        let env: HashMap<String, String> = [
            (ACCESS_EXECUTOR, r#"["instance-1","native-browser-plugin"]"#),
            (APP_TOOLS_PIPE, r"\\.\pipe\codex-app-tools-1"),
            (ACCESS_PIPE, r"\\.\pipe\codex-app-tools-1"),
            (ACCESS_IDENTITY, "MCowBQYDK2VwAyEA"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        assert_eq!(host_from_env(&env), Some(host()));

        let mut missing_key = env.clone();
        missing_key.remove(ACCESS_IDENTITY);
        assert_eq!(host_from_env(&missing_key), None);
        let mut bad_executor = env;
        bad_executor.insert(ACCESS_EXECUTOR.into(), "native-browser-plugin".into());
        assert_eq!(host_from_env(&bad_executor), None);
    }

    #[test]
    fn executor_matches_the_desktop_shape_for_this_account() {
        let cua = json!({ "command": "node.exe", "args": ["cua-repl.mjs"], "env": { "SKY_CUA_NATIVE_PIPE": "1" }, "env_vars": ["BROWSER_USE_ACCESS_PIPE_PATH"] });
        let bridge = build(&host(), &principal(), true, Some(cua)).unwrap();
        let executor = r#"["instance-1","account-1","user-1"]"#;
        assert_eq!(bridge.config["mcp_servers.node_repl.env.BROWSER_USE_ACCESS_EXECUTOR_ID"], executor);
        assert_eq!(bridge.config["mcp_servers.node_repl.env.BROWSER_USE_ACCESS_PIPE_PATH"], r"\\.\pipe\codex-app-tools-1");
        assert_eq!(bridge.config["mcp_servers.node_repl.env.BROWSER_USE_ACCESS_VERIFYING_IDENTITY"], "MCowBQYDK2VwAyEA");
        let cua = &bridge.config["mcp_servers.cua_repl"];
        assert_eq!(cua["command"], "node.exe");
        assert_eq!(cua["env"]["SKY_CUA_NATIVE_PIPE"], "1");
        assert_eq!(cua["env"][ACCESS_EXECUTOR], executor);
        assert_eq!(cua["env"][ACCESS_PIPE], r"\\.\pipe\codex-app-tools-1");
        assert_eq!(bridge.fingerprint, r"instance-1|\\.\pipe\codex-app-tools-1|MCowBQYDK2VwAyEA");
    }

    #[test]
    fn undefined_servers_are_never_created_by_leaf_overrides() {
        assert_eq!(build(&host(), &principal(), false, None), None);
        let only_cua = build(&host(), &principal(), false, Some(json!({ "command": "node.exe" }))).unwrap();
        assert_eq!(only_cua.config.keys().collect::<Vec<_>>(), vec!["mcp_servers.cua_repl"]);
    }

    #[test]
    fn jwt_claims_identify_the_chatgpt_account() {
        use base64::Engine;
        let claims = json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "account-1", "chatgpt_user_id": "user-1" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        assert_eq!(principal_from_jwt(&format!("header.{payload}.sig")), Some(principal()));
        assert_eq!(principal_from_jwt("not-a-token"), None);
    }

    #[test]
    fn config_scan_finds_tables_and_explicit_disables() {
        let toml = "[mcp_servers.node_repl]\ncommand = 'node_repl.exe'\n\n[plugins.\"unified-computer-use@openai-bundled\"]\nenabled = false\n";
        assert!(defines_table(toml, "mcp_servers.node_repl"));
        assert!(!defines_table(toml, "mcp_servers.cua_repl"));
        assert!(table_disabled(toml, "plugins.\"unified-computer-use@openai-bundled\""));
        assert!(!table_disabled("[plugins.\"unified-computer-use@openai-bundled\"]\nenabled = true\n", "plugins.\"unified-computer-use@openai-bundled\""));
    }

    #[cfg(windows)]
    #[test]
    fn environment_blocks_keep_values_with_equals_signs() {
        let block: Vec<u8> = "=C:=C:\\work\0A=1\0B=x=y\0\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let env = windows_env::parse_block(&block);
        assert_eq!(env["A"], "1");
        assert_eq!(env["B"], "x=y");
        assert_eq!(env["=C:"], "C:\\work");
    }

    #[cfg(windows)]
    #[test]
    fn reads_this_process_environment() {
        let env = windows_env::read(std::process::id()).unwrap();
        assert!(env.contains_key("PATH") || env.contains_key("Path"));
    }

    /// Run with `--ignored` while the ChatGPT desktop app is open.
    #[test]
    #[ignore]
    fn live_desktop_bridge() {
        let bridge = bridge(None).expect("desktop bridge");
        println!("{}", serde_json::to_string_pretty(&bridge).unwrap());
    }
}
