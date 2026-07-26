// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs;
mod git;
mod process_tree;
mod project;
mod pty;
mod shells;
mod watch;

use std::collections::HashMap;

use tauri::{ipc::Channel, AppHandle, Manager, State};

use fs::{DirEntry, FileContent};
use git::{Branches, Diff, DiffStats, FileDiff};
use project::ProjectInfo;
use pty::{PtyManager, SpawnResult};
use shells::ShellInfo;
use watch::ProjectWatchManager;

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

/// Reveal the initially hidden window only after React has painted its shell.
#[tauri::command]
fn frontend_ready(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn watch_project(
    manager: State<'_, ProjectWatchManager>,
    path: Option<String>,
) -> Result<(), String> {
    manager.set(path)
}

fn main() {
    let window_state_flags = tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
        | tauri_plugin_window_state::StateFlags::FULLSCREEN;

    tauri::Builder::default()
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
        .manage(ProjectWatchManager::default())
        .setup(|app| {
            if let (Some(window), Some(icon)) = (
                app.get_webview_window("main"),
                app.default_window_icon().cloned(),
            ) {
                window.set_icon(icon)?;
            }
            pty::start_busy_monitor(app.handle().clone())?;
            watch::start_monitor(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_shells,
            home_dir,
            project_info,
            list_dir,
            read_file,
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
            frontend_ready,
            watch_project,
        ])
        .on_window_event(|window, event| {
            // Make sure we never leave orphaned shells behind.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.app_handle().try_state::<PtyManager>() {
                    manager.kill_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running duckweed");
}
