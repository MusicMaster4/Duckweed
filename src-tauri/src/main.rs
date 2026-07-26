// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs;
mod git;
mod process_tree;
mod project;
mod pty;
mod shells;

use std::collections::HashMap;

use tauri::{AppHandle, Manager, State};

use fs::DirEntry;
use git::{Branches, Diff, DiffStats, FileDiff};
use project::ProjectInfo;
use pty::{PtyManager, SpawnResult};
use shells::ShellInfo;

#[tauri::command]
fn list_shells() -> Vec<ShellInfo> {
    shells::available_shells()
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
fn project_info(path: String) -> Result<ProjectInfo, String> {
    project::info(&path)
}

/// One level of a folder, for the tools panel's project explorer.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    fs::list_dir(&path)
}

/// Local and remote branches of the repo `path` sits in.
#[tauri::command]
fn git_branches(path: String) -> Result<Branches, String> {
    git::branches(&path)
}

#[tauri::command]
fn git_checkout(path: String, branch: String) -> Result<(), String> {
    git::checkout(&path, &branch)
}

/// Counts for the status-bar chip: changed files, lines added, lines removed.
#[tauri::command]
fn git_diff_stats(path: String) -> Result<DiffStats, String> {
    git::diff_stats(&path)
}

/// Every uncommitted change, hunk by hunk, for the changes panel.
#[tauri::command]
fn git_diff(path: String) -> Result<Diff, String> {
    git::diff(&path)
}

/// One file with all of its unmodified lines, for expanding a collapsed run.
#[tauri::command]
fn git_file_diff(path: String, file: String) -> Result<FileDiff, String> {
    git::file_diff(&path, &file)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnResult, String> {
    pty::spawn(&app, &manager, id, cwd, shell, cols, rows, env)
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
        .setup(|app| {
            if let (Some(window), Some(icon)) = (
                app.get_webview_window("main"),
                app.default_window_icon().cloned(),
            ) {
                window.set_icon(icon)?;
            }
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_shells,
            home_dir,
            project_info,
            list_dir,
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
