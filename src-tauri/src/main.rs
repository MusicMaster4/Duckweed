// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod pty;
mod shells;

use std::collections::HashMap;

use tauri::{AppHandle, Manager, State};

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PtyManager::default())
        .setup(|app| {
            if let (Some(window), Some(icon)) = (
                app.get_webview_window("main"),
                app.default_window_icon().cloned(),
            ) {
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_shells,
            home_dir,
            project_info,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
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
