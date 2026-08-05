// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_activity;
mod agent_proc;
mod agent_sessions;
mod fs;
mod git;
mod launch;
mod power;
mod ports;
mod process_tree;
mod project;
mod pty;
mod shell_integration;
mod shells;
mod sound;
mod terminal_shell_integration;
mod usage;
mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};

use agent_activity::AgentActivityManager;
use agent_proc::{
    AgentAvailability, AgentFrame, AgentProcManager, AgentSpawnOptions, AgentStarted,
};
use agent_sessions::{AgentSessionSummary, AgentTranscriptItem};
use fs::{DirEntry, FileContent, SearchGeneration, SearchProject, SearchResponse, WorkspacePath};
use git::{Branches, Diff, DiffStats, FileDiff};
use launch::{LaunchIntent, PendingLaunch};
use ports::{ForwardInfo, PortManager, PortSnapshot};
use project::ProjectInfo;
use pty::{PtyManager, SpawnResult};
use shells::ShellInfo;
use sound::SoundPlayer;
use usage::{pricing, Query, Snapshot, UsageState};
use watch::ProjectWatchManager;

#[derive(Default)]
struct DurableSettings(Mutex<()>);

const COMMAND_HISTORY_KEY: &str = "duckweed:command-history:v1";

const DURABLE_SETTING_KEYS: [&str; 10] = [
    "duckweed:state:v1",
    "duckweed:usage:v1",
    // Ghost-text unlearning table — must match frontend DURABLE_KEYS or restore
    // aborts when seeding WebView feedback into app-data and never reaches history.
    "duckweed:suggest-feedback:v1",
    "duckweed:checklist:v1",
    "duckweed:agent-preferences:v1",
    "duckweed:layouts:v1",
    "duckweed:prompt-templates:v1",
    "duckweed:wellbeing:v1",
    // 70% pool cooldown history (greetings, ASCII, preparing, pulse patterns).
    "duckweed:cooldown-pools:v1",
    COMMAND_HISTORY_KEY,
];

/// Keep the stored list bounded; oldest entries drop first.
const MAX_HISTORY_ENTRIES: usize = 500;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct HistoryEntry {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    at: i64,
}

fn parse_history(raw: &str) -> Vec<HistoryEntry> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// Union of the stored history and an incoming snapshot, oldest first.
///
/// Ghost-text history has several writers — a second window, or an installed
/// build and a dev build, which use different WebView origins and therefore
/// different localStorage. Replacing the file with whichever snapshot saved
/// last would drop the other writer's commands, so entries are merged instead;
/// the same command in the same directory collapses to its newest timestamp,
/// which keeps re-saving an unchanged list idempotent.
fn merge_history(stored: &str, incoming: &str) -> String {
    let mut merged: Vec<HistoryEntry> = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();

    for entry in parse_history(stored).into_iter().chain(parse_history(incoming)) {
        if entry.command.trim().is_empty() {
            continue;
        }
        let key = (entry.command.clone(), entry.cwd.clone().unwrap_or_default());
        match index.get(&key) {
            Some(&at) if merged[at].at > entry.at => {}
            Some(&at) => merged[at] = entry,
            None => {
                index.insert(key, merged.len());
                merged.push(entry);
            }
        }
    }

    merged.sort_by_key(|entry| entry.at);
    if merged.len() > MAX_HISTORY_ENTRIES {
        merged.drain(..merged.len() - MAX_HISTORY_ENTRIES);
    }
    serde_json::to_string(&merged).unwrap_or_else(|_| incoming.to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("durable-settings.json"))
        .map_err(|error| error.to_string())
}

fn read_settings(path: &Path) -> HashMap<String, String> {
    let parse = |candidate: &Path| {
        std::fs::read_to_string(candidate)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
    };
    parse(path)
        .or_else(|| parse(&path.with_extension("json.bak")))
        .unwrap_or_default()
}

#[tauri::command]
fn settings_load(
    app: AppHandle,
    state: State<'_, DurableSettings>,
) -> Result<HashMap<String, String>, String> {
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    Ok(read_settings(&settings_path(&app)?))
}

#[tauri::command]
fn settings_save(
    app: AppHandle,
    state: State<'_, DurableSettings>,
    key: String,
    value: String,
    replace: Option<bool>,
) -> Result<(), String> {
    if !DURABLE_SETTING_KEYS.contains(&key.as_str()) {
        return Err("unsupported settings key".into());
    }
    // Reject corrupt payloads before they can replace the last good copy.
    serde_json::from_str::<serde_json::Value>(&value).map_err(|error| error.to_string())?;

    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    let path = settings_path(&app)?;
    let mut settings = read_settings(&path);

    // History accumulates across windows, builds and updates; everything else
    // is a single-writer snapshot that simply replaces the stored copy.
    let value = if key == COMMAND_HISTORY_KEY && !replace.unwrap_or(false) {
        merge_history(settings.get(&key).map(String::as_str).unwrap_or("[]"), &value)
    } else {
        value
    };

    settings.insert(key, value);
    let raw = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("settings path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    std::fs::write(&temporary, raw).map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::copy(&path, &backup).map_err(|error| error.to_string())?;
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

async fn blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_shells() -> Result<Vec<ShellInfo>, String> {
    blocking(|| Ok(shells::available_shells())).await
}

#[tauri::command]
fn home_dir() -> String {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    home
}

#[tauri::command]
async fn project_info(path: String) -> Result<ProjectInfo, String> {
    blocking(move || project::info(&path)).await
}

/// One level of a folder, for the tools panel's project explorer.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || fs::list_dir(&path)).await
}

/// Read a file as text for the project explorer's popup editor.
#[tauri::command]
async fn read_file(path: String) -> Result<FileContent, String> {
    blocking(move || fs::read_file(&path)).await
}

/// Read a small local image dropped from the OS into the agent composer.
#[tauri::command]
async fn read_dropped_image(path: String) -> Result<Vec<u8>, String> {
    blocking(move || fs::read_dropped_image(&path)).await
}

/// Save the popup editor's buffer back to disk.
#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    blocking(move || fs::write_file(&path, content)).await
}

/// Local and remote branches of the repo `path` sits in.
#[tauri::command]
async fn git_branches(path: String) -> Result<Branches, String> {
    blocking(move || git::branches(&path)).await
}

#[tauri::command]
async fn git_checkout(path: String, branch: String) -> Result<(), String> {
    blocking(move || git::checkout(&path, &branch)).await
}

/// Counts for the status-bar chip: changed files, lines added, lines removed.
#[tauri::command]
async fn git_diff_stats(path: String) -> Result<DiffStats, String> {
    blocking(move || git::diff_stats(&path)).await
}

/// Every uncommitted change, hunk by hunk, for the changes panel.
#[tauri::command]
async fn git_diff(path: String) -> Result<Diff, String> {
    blocking(move || git::diff(&path)).await
}

/// One file with all of its unmodified lines, for expanding a collapsed run.
#[tauri::command]
async fn git_file_diff(path: String, file: String) -> Result<FileDiff, String> {
    blocking(move || git::file_diff(&path, &file)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    on_data: Channel<Vec<u8>>,
    id: String,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnResult, String> {
    let manager = manager.inner().clone();
    blocking(move || pty::spawn(&app, &manager, on_data, id, cwd, shell, cols, rows, env)).await
}

/// `data` is the raw keystroke text from xterm.js.
#[tauri::command]
fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    manager.write(&id, data.as_bytes())
}

#[tauri::command]
fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id)
}

/// Whether the shell for `id` currently has a child process running.
#[tauri::command]
fn pty_is_busy(manager: State<'_, PtyManager>, id: String) -> bool {
    manager.is_busy(&id)
}

/// Whether any of the listed sessions has a child process running.
#[tauri::command]
fn pty_any_busy(manager: State<'_, PtyManager>, ids: Vec<String>) -> bool {
    manager.any_busy(&ids)
}

/// TCP listeners opened by processes launched from a Duckweed pane or agent.
#[tauri::command]
async fn ports_list(
    ptys: State<'_, PtyManager>,
    agents: State<'_, AgentProcManager>,
    ports: State<'_, PortManager>,
) -> Result<PortSnapshot, String> {
    let ptys = ptys.inner().clone();
    let agents = agents.inner().clone();
    let ports = ports.inner().clone();
    blocking(move || Ok(ports::snapshot(&ptys, &agents, &ports))).await
}

/// Stop the process that owns a listener, after rechecking its Duckweed ancestry.
#[tauri::command]
async fn port_close(
    ptys: State<'_, PtyManager>,
    agents: State<'_, AgentProcManager>,
    ports: State<'_, PortManager>,
    pid: u32,
    port: u16,
) -> Result<(), String> {
    let ptys = ptys.inner().clone();
    let agents = agents.inner().clone();
    let ports = ports.inner().clone();
    blocking(move || ports::close(pid, port, &ptys, &agents, &ports)).await
}

/// Expose one owned local HTTP listener through a temporary public tunnel.
#[tauri::command]
async fn port_forward(
    app: AppHandle,
    ptys: State<'_, PtyManager>,
    agents: State<'_, AgentProcManager>,
    ports: State<'_, PortManager>,
    pid: u32,
    port: u16,
) -> Result<ForwardInfo, String> {
    let ptys = ptys.inner().clone();
    let agents = agents.inner().clone();
    let ports = ports.inner().clone();
    let tools_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("tools");
    blocking(move || ports::forward(pid, port, &ptys, &agents, &ports, &tools_dir)).await
}

#[tauri::command]
fn port_forward_stop(ports: State<'_, PortManager>, id: String) -> Result<(), String> {
    ports.stop(&id)
}

#[tauri::command]
fn agent_watch(manager: State<'_, AgentActivityManager>, id: String, agent: String, cwd: String) {
    manager.watch(id, agent, cwd);
}

#[tauri::command]
fn agent_unwatch(manager: State<'_, AgentActivityManager>, id: String) {
    manager.unwatch(&id);
}

/// Past conversations `agent` recorded for `cwd`, so the custom UI can offer
/// to resume one. Reads the CLI's own session store — no agent is started.
#[tauri::command]
async fn agent_sessions_list(
    agent: String,
    cwd: String,
) -> Result<Vec<AgentSessionSummary>, String> {
    blocking(move || agent_sessions::list(&agent, &cwd)).await
}

/// Visible turns for agents whose resume protocol does not replay history.
#[tauri::command]
async fn agent_session_transcript(
    agent: String,
    cwd: String,
    session_id: String,
) -> Result<Vec<AgentTranscriptItem>, String> {
    blocking(move || agent_sessions::transcript(&agent, &cwd, &session_id)).await
}

/// Which headless agent CLIs this machine has, so the custom UI only takes
/// over commands it can actually drive.
#[tauri::command]
async fn agent_proc_probe(names: Vec<String>) -> Result<Vec<AgentAvailability>, String> {
    blocking(move || Ok(agent_proc::probe(names))).await
}

/// Launch a coding agent in its line-delimited JSON mode.
#[tauri::command]
async fn agent_proc_start(
    manager: State<'_, AgentProcManager>,
    on_frame: Channel<AgentFrame>,
    id: String,
    options: AgentSpawnOptions,
) -> Result<AgentStarted, String> {
    let manager = manager.inner().clone();
    blocking(move || agent_proc::start(&manager, on_frame, id, options)).await
}

/// One protocol message to the agent's stdin.
#[tauri::command]
fn agent_proc_send(
    manager: State<'_, AgentProcManager>,
    id: String,
    line: String,
) -> Result<(), String> {
    manager.send(&id, &line)
}

/// Signal end-of-input without killing the agent.
#[tauri::command]
fn agent_proc_close_stdin(manager: State<'_, AgentProcManager>, id: String) -> Result<(), String> {
    manager.close_stdin(&id)
}

#[tauri::command]
fn agent_proc_stop(manager: State<'_, AgentProcManager>, id: String) -> Result<(), String> {
    manager.stop(&id)
}

fn home_path() -> PathBuf {
    PathBuf::from(home_dir())
}

/// Where the usage index and the user's price overrides live.
fn usage_paths(app: &AppHandle) -> (PathBuf, PathBuf) {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("duckweed"));
    (
        base.join("usage-index.json"),
        base.join("usage-pricing.json"),
    )
}

/// Token and cost totals across every installed coding agent.
///
/// The first call builds the index and can take a while — it reads every
/// transcript on disk — so progress arrives on the `usage:progress` event.
/// Later calls only re-read files that changed.
#[tauri::command]
async fn usage_scan(
    app: AppHandle,
    state: State<'_, UsageState>,
    query: Query,
) -> Result<Snapshot, String> {
    let (index_path, pricing_path) = usage_paths(&app);
    let state = state.inner().clone();
    blocking(move || {
        if query.refresh {
            usage::quota::refresh_grok_credit_snapshot(&home_path());
        }
        let overrides = pricing::load_overrides(&pricing_path);
        let emit = |done: u32, total: u32| {
            let _ = app.emit("usage:progress", (done, total));
        };
        usage::scan(&home_path(), &index_path, &overrides, &state, &query, &emit)
    })
    .await
}

/// The price overrides the user has saved, plus the models we ship rates for.
#[tauri::command]
async fn usage_pricing(app: AppHandle) -> Result<(Vec<String>, pricing::Overrides), String> {
    let (_, pricing_path) = usage_paths(&app);
    blocking(move || {
        Ok((
            pricing::known_models(),
            pricing::load_overrides(&pricing_path),
        ))
    })
    .await
}

/// Replace the saved price overrides.
#[tauri::command]
async fn usage_set_pricing(app: AppHandle, overrides: pricing::Overrides) -> Result<(), String> {
    let (_, pricing_path) = usage_paths(&app);
    blocking(move || pricing::save_overrides(&pricing_path, &overrides)).await
}

/// Reveal the initially hidden window only after React has painted its shell.
#[tauri::command]
fn frontend_ready(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Open an http(s) URL in the user's default browser.
///
/// Used for Ctrl/Cmd-click on terminal links. Only http and https are allowed —
/// anything else would let the terminal shell out to arbitrary schemes.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open_external_url(&url)
}

/// Suspend or shut the machine down for the power watch.
///
/// Runs on a blocking task: a Windows sleep does not return until the machine
/// wakes, and holding the IPC thread there would freeze the window that is
/// about to be suspended.
#[tauri::command]
async fn power_action(action: String) -> Result<(), String> {
    let action = power::Action::parse(&action)?;
    blocking(move || power::run(action)).await
}

/// Play one completion cue from this process.
///
/// Playing it in the WebView instead would file the sound under "Microsoft Edge
/// WebView2" in the Windows volume mixer, because that runtime process owns any
/// audio the WebView starts. Errors are the frontend's cue to fall back to its
/// own player, so a machine this cannot open a device on still gets sound.
#[tauri::command]
async fn play_completion_sound(player: State<'_, SoundPlayer>) -> Result<(), String> {
    let player = player.inner().clone();
    blocking(move || player.play()).await
}

/// Validate and hand `url` to the OS default handler.
fn open_external_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !is_safe_http_url(url) {
        return Err("only http(s) URLs can be opened".into());
    }
    open_in_browser(url)
}

/// True for plain `http://` / `https://` URLs with no control characters.
fn is_safe_http_url(url: &str) -> bool {
    if url.is_empty() || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    // ShellExecute returns a HINSTANCE cast to a pointer; values ≤ 32 are errors.
    let operation = wide("open");
    let file = wide(url);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };
    if (result as isize) <= 32 {
        return Err(format!("could not open URL (code {})", result as isize));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("could not open URL: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("could not open URL: {error}"))?;
    Ok(())
}

/// Cold-start folder request from Explorer / the CLI, consumed once.
#[tauri::command]
fn take_launch_intent(pending: State<'_, PendingLaunch>) -> Option<LaunchIntent> {
    pending.0.lock().ok().and_then(|mut guard| guard.take())
}

/// Whether Explorer shows each Duckweed folder right-click verb.
///
/// `None` on non-Windows platforms where the setting does not apply.
#[tauri::command]
fn shell_integration_status() -> Option<shell_integration::ShellIntegrationStatus> {
    #[cfg(windows)]
    {
        // First launch enables "new tab" only; "new window" stays opt-in.
        match shell_integration::ensure_defaults() {
            Ok(status) => Some(status),
            Err(_) => Some(shell_integration::status()),
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Add or remove one Explorer verb (`"tab"` or `"window"`).
#[tauri::command]
fn shell_integration_set(
    verb: String,
    enabled: bool,
) -> Result<shell_integration::ShellIntegrationStatus, String> {
    let verb = match verb.as_str() {
        "tab" => shell_integration::ShellVerb::Tab,
        "window" => shell_integration::ShellVerb::Window,
        other => return Err(format!("unknown shell verb: {other}")),
    };
    shell_integration::set_verb(verb, enabled)
}

#[tauri::command]
fn watch_project(
    manager: State<'_, ProjectWatchManager>,
    path: Option<String>,
) -> Result<(), String> {
    manager.set(path)
}

#[tauri::command]
fn workspace_paths(path: String) -> Result<Vec<WorkspacePath>, String> {
    fs::workspace_paths(&path)
}

#[tauri::command]
async fn project_search(
    manager: State<'_, SearchGeneration>,
    projects: Vec<SearchProject>,
    query: String,
    generation: u64,
) -> Result<SearchResponse, String> {
    let current = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::search_projects(projects, query, generation, std::sync::Arc::new(current))
    })
    .await
    .map_err(|error| format!("search task failed: {error}"))?
}

#[tauri::command]
fn project_search_cancel(manager: State<'_, SearchGeneration>, generation: u64) {
    manager.cancel_before(generation);
}

#[cfg(not(debug_assertions))]
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(not(debug_assertions))]
fn emit_launch_intent(app: &AppHandle, intent: LaunchIntent) {
    let _ = app.emit("launch-intent", intent);
    focus_main_window(app);
}

/// Give the dev binary its own WebView2 profile so it can run beside an
/// installed Duckweed. Both use identifier `dev.slop.duckweed`; sharing one
/// user-data folder makes the second process exit immediately on Windows.
#[cfg(all(windows, debug_assertions))]
fn isolate_dev_webview_profile() {
    let dir = std::env::temp_dir().join("duckweed-dev-webview");
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!("duckweed: could not create dev webview profile dir: {error}");
        return;
    }
    // Official WebView2 env var — must be set before the runtime is created.
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
}

fn main() {
    // Packaged Unix GUI apps start outside a login shell. Repair PATH before
    // shell and agent discovery so Homebrew and user-installed CLIs stay visible.
    #[cfg(unix)]
    if let Err(error) = fix_path_env::fix() {
        eprintln!("duckweed: could not import the login-shell PATH: {error}");
    }

    #[cfg(all(windows, debug_assertions))]
    isolate_dev_webview_profile();

    let args: Vec<String> = std::env::args().collect();
    let startup_intent = launch::parse_args(&args);

    let window_state_flags = tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
        | tauri_plugin_window_state::StateFlags::FULLSCREEN;

    let builder = tauri::Builder::default();

    // Single-instance is release-only and must register first so a second
    // Explorer click hands its argv to the running app. Debug/dev builds skip
    // it so `bun run app` can run next to an installed Duckweed while coding.
    // In release, "new window" still bypasses the plugin so Explorer can open
    // a real second process.
    #[cfg(all(
        any(target_os = "macos", windows, target_os = "linux"),
        not(debug_assertions)
    ))]
    let builder = {
        let force_new_window = launch::wants_new_window(&args);
        if !force_new_window {
            builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                if let Some(intent) = launch::parse_args(&argv) {
                    emit_launch_intent(app, intent);
                } else {
                    focus_main_window(app);
                }
            }))
        } else {
            builder
        }
    };

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Register this before setup so it receives the initial window-ready
        // event and the final app-exit event.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .build(),
        )
        .manage(PtyManager::default())
        .manage(AgentActivityManager::default())
        .manage(AgentProcManager::default())
        .manage(PortManager::default())
        .manage(ProjectWatchManager::default())
        .manage(UsageState::default())
        .manage(DurableSettings::default())
        .manage(SearchGeneration::default())
        .manage(SoundPlayer::default())
        .manage(PendingLaunch(Mutex::new(startup_intent)))
        .setup(|app| {
            if let (Some(window), Some(icon)) = (
                app.get_webview_window("main"),
                app.default_window_icon().cloned(),
            ) {
                window.set_icon(icon)?;
            }
            pty::start_busy_monitor(app.handle().clone())?;
            agent_activity::start_monitor(app.handle().clone())?;
            watch::start_monitor(app.handle().clone())?;
            // Heal context-menu entries left pointing at a development binary.
            shell_integration::repair_enabled_verbs();
            // Register "Open Duckweed in new tab" on first Windows run.
            let _ = shell_integration::ensure_defaults();
            // After an in-place update the exe icon can change while Explorer
            // still shows the previous one; notify once per product version.
            shell_integration::refresh_icons_if_needed(&app.package_info().version.to_string());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_shells,
            home_dir,
            project_info,
            list_dir,
            workspace_paths,
            project_search,
            project_search_cancel,
            read_file,
            read_dropped_image,
            write_file,
            git_branches,
            git_checkout,
            git_diff_stats,
            git_diff,
            git_file_diff,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_is_busy,
            pty_any_busy,
            ports_list,
            port_close,
            port_forward,
            port_forward_stop,
            agent_watch,
            agent_unwatch,
            agent_sessions_list,
            agent_session_transcript,
            agent_proc_probe,
            agent_proc_start,
            agent_proc_send,
            agent_proc_close_stdin,
            agent_proc_stop,
            frontend_ready,
            open_url,
            play_completion_sound,
            power_action,
            take_launch_intent,
            shell_integration_status,
            shell_integration_set,
            watch_project,
            usage_scan,
            usage_pricing,
            usage_set_pricing,
            settings_load,
            settings_save,
        ])
        .on_window_event(|window, event| {
            // Make sure we never leave orphaned shells behind.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.app_handle().try_state::<PtyManager>() {
                    manager.kill_all();
                }
                if let Some(manager) = window.app_handle().try_state::<AgentProcManager>() {
                    manager.stop_all();
                }
                if let Some(manager) = window.app_handle().try_state::<PortManager>() {
                    manager.stop_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running duckweed");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands(raw: &str) -> Vec<String> {
        parse_history(raw).into_iter().map(|e| e.command).collect()
    }

    #[test]
    fn merge_keeps_commands_a_stale_snapshot_never_saw() {
        let stored = r#"[{"command":"cargo build","cwd":"/a","at":1}]"#;
        let incoming = r#"[{"command":"npm test","cwd":"/a","at":2}]"#;
        assert_eq!(commands(&merge_history(stored, incoming)), ["cargo build", "npm test"]);
    }

    #[test]
    fn merge_is_idempotent_and_ordered_by_recency() {
        let stored = r#"[{"command":"ls","cwd":"/a","at":5},{"command":"pwd","cwd":"/a","at":1}]"#;
        let once = merge_history(stored, stored);
        assert_eq!(commands(&once), ["pwd", "ls"]);
        assert_eq!(commands(&merge_history(&once, stored)), ["pwd", "ls"]);
    }

    #[test]
    fn merge_bumps_recency_but_keeps_other_directories() {
        let stored = r#"[{"command":"ls","cwd":"/a","at":1}]"#;
        let incoming = r#"[{"command":"ls","cwd":"/a","at":9},{"command":"ls","cwd":"/b","at":4}]"#;
        let merged = parse_history(&merge_history(stored, incoming));
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].cwd.as_deref(), Some("/b"));
        assert_eq!(merged[1].at, 9);
    }

    #[test]
    fn merge_caps_the_stored_list_at_the_newest_entries() {
        let entries: Vec<String> = (0..MAX_HISTORY_ENTRIES + 20)
            .map(|i| format!(r#"{{"command":"c{i}","cwd":null,"at":{i}}}"#))
            .collect();
        let merged = parse_history(&merge_history("[]", &format!("[{}]", entries.join(","))));
        assert_eq!(merged.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(merged[0].command, "c20");
    }

    #[test]
    fn merge_survives_a_corrupt_stored_copy() {
        let incoming = r#"[{"command":"ls","cwd":null,"at":1}]"#;
        assert_eq!(commands(&merge_history("not json", incoming)), ["ls"]);
    }

    #[test]
    fn only_http_urls_are_openable() {
        assert!(is_safe_http_url("https://example.com/path?q=1"));
        assert!(is_safe_http_url("http://localhost:3000"));
        assert!(is_safe_http_url("HTTPS://Example.COM"));
        assert!(!is_safe_http_url("file:///etc/passwd"));
        assert!(!is_safe_http_url("javascript:alert(1)"));
        assert!(!is_safe_http_url("https://example.com/a b"));
        assert!(!is_safe_http_url("https://example.com/\n"));
        assert!(!is_safe_http_url(""));
    }
}
