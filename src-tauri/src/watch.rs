//! Debounced filesystem notifications for the project shown in the active tab.
//!
//! The shell can change the working tree at any time. Watching the project makes
//! branch/diff chrome event-driven without polling Git while the app is idle.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

const QUIET_FOR: Duration = Duration::from_millis(300);
const MONITOR_TICK: Duration = Duration::from_millis(100);

#[derive(Clone)]
struct Dirty {
    pending: Arc<AtomicBool>,
    last: Arc<Mutex<Instant>>,
}

impl Default for Dirty {
    fn default() -> Self {
        Self {
            pending: Arc::new(AtomicBool::new(false)),
            last: Arc::new(Mutex::new(Instant::now())),
        }
    }
}

#[derive(Default)]
pub struct ProjectWatchManager {
    watcher: Mutex<Option<RecommendedWatcher>>,
    path: Mutex<Option<String>>,
    dirty: Dirty,
}

impl ProjectWatchManager {
    pub fn set(&self, path: Option<String>) -> Result<(), String> {
        let mut current = self.path.lock().unwrap();
        if *current == path {
            return Ok(());
        }

        *self.watcher.lock().unwrap() = None;
        *current = path.clone();
        self.dirty.pending.store(false, Ordering::Release);

        let Some(path) = path else {
            return Ok(());
        };
        if !Path::new(&path).is_dir() {
            return Err(format!("`{path}` is not a directory"));
        }

        let dirty = self.dirty.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else {
                    return;
                };
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                *dirty.last.lock().unwrap() = Instant::now();
                dirty.pending.store(true, Ordering::Release);
            })
            .map_err(|error| error.to_string())?;
        watcher
            .watch(Path::new(&path), RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        *self.watcher.lock().unwrap() = Some(watcher);
        Ok(())
    }

    fn take_due(&self) -> Option<String> {
        if !self.dirty.pending.load(Ordering::Acquire) {
            return None;
        }
        if self.dirty.last.lock().unwrap().elapsed() < QUIET_FOR {
            return None;
        }
        if !self.dirty.pending.swap(false, Ordering::AcqRel) {
            return None;
        }
        self.path.lock().unwrap().clone()
    }
}

pub fn start_monitor(app: AppHandle) -> Result<(), String> {
    std::thread::Builder::new()
        .name("project-watch-monitor".into())
        .spawn(move || loop {
            std::thread::sleep(MONITOR_TICK);
            if app.get_webview_window("main").is_none() {
                break;
            }
            let Some(manager) = app.try_state::<ProjectWatchManager>() else {
                continue;
            };
            if let Some(path) = manager.take_due() {
                if app.emit("project:changed", path).is_err() {
                    break;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}
