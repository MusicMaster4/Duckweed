//! Windows Explorer context-menu entries for opening a folder in Duckweed.
//!
//! Mirrors Warp's per-user (`HKCU`) shell verbs so no administrator rights are
//! required. Tab and window are independent:
//!
//! - **Open Duckweed in new tab** — on by default
//! - **Open Duckweed in new window** — opt-in
//!
//! Registered for both a selected folder (`Directory`) and empty space inside
//! a folder (`Directory\Background`).

use serde::Serialize;

#[cfg(windows)]
use std::path::PathBuf;

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::RegKey;

const TAB_KEY: &str = "DuckweedTab";
const WINDOW_KEY: &str = "DuckweedWindow";
const TAB_LABEL: &str = "Open Duckweed in new tab";
const WINDOW_LABEL: &str = "Open Duckweed in new window";

/// Which Explorer verb is being toggled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellVerb {
    Tab,
    Window,
}

/// Independent on/off state for each Explorer menu entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ShellIntegrationStatus {
    pub tab: bool,
    pub window: bool,
}

impl ShellVerb {
    fn key(self) -> &'static str {
        match self {
            Self::Tab => TAB_KEY,
            Self::Window => WINDOW_KEY,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Tab => TAB_LABEL,
            Self::Window => WINDOW_LABEL,
        }
    }

    fn action(self) -> &'static str {
        match self {
            Self::Tab => "new_tab",
            Self::Window => "new_window",
        }
    }
}

/// Whether each Explorer context-menu verb is present for this user.
#[cfg(windows)]
pub fn status() -> ShellIntegrationStatus {
    ShellIntegrationStatus {
        tab: verb_installed(ShellVerb::Tab),
        window: verb_installed(ShellVerb::Window),
    }
}

#[cfg(not(windows))]
pub fn status() -> ShellIntegrationStatus {
    ShellIntegrationStatus {
        tab: false,
        window: false,
    }
}

/// First-run defaults: tab on, window off. Skipped once the user has toggled
/// either option (or defaults were already applied).
#[cfg(windows)]
pub fn ensure_defaults() -> Result<ShellIntegrationStatus, String> {
    if defaults_applied() {
        return Ok(status());
    }
    install_verb(ShellVerb::Tab)?;
    // Window stays off unless the user opts in.
    mark_defaults_applied()?;
    Ok(status())
}

#[cfg(not(windows))]
pub fn ensure_defaults() -> Result<ShellIntegrationStatus, String> {
    Ok(status())
}

/// Install or remove a single verb and remember that the user chose.
#[cfg(windows)]
pub fn set_verb(verb: ShellVerb, enabled: bool) -> Result<ShellIntegrationStatus, String> {
    if enabled {
        install_verb(verb)?;
    } else {
        remove_verb(verb)?;
    }
    mark_defaults_applied()?;
    Ok(status())
}

#[cfg(not(windows))]
pub fn set_verb(_verb: ShellVerb, _enabled: bool) -> Result<ShellIntegrationStatus, String> {
    Err("Explorer context menus are only available on Windows".into())
}

#[cfg(windows)]
fn verb_installed(verb: ShellVerb) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(format!(r"Software\Classes\Directory\shell\{}", verb.key()))
        .is_ok()
}

#[cfg(windows)]
fn install_verb(verb: ShellVerb) -> Result<(), String> {
    let exe = current_exe()?;
    let icon = icon_value(&exe);
    let exe_quoted = quote_path(&exe);
    let action = verb.action();
    let label = verb.label();
    let key = verb.key();

    write_verb(
        r"Software\Classes\Directory\shell",
        key,
        label,
        &icon,
        &format!(r#"{exe_quoted} "duckweed://action/{action}?path=%1""#),
    )?;
    // Background verbs use %V (the folder being viewed) rather than %1.
    write_verb(
        r"Software\Classes\Directory\Background\shell",
        key,
        label,
        &icon,
        &format!(r#"{exe_quoted} "duckweed://action/{action}?path=%V""#),
    )?;
    Ok(())
}

#[cfg(windows)]
fn remove_verb(verb: ShellVerb) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for root in [
        r"Software\Classes\Directory\shell",
        r"Software\Classes\Directory\Background\shell",
    ] {
        let path = format!(r"{root}\{}", verb.key());
        match hkcu.delete_subkey_all(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to remove {path}: {error}")),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn write_verb(
    parent: &str,
    name: &str,
    label: &str,
    icon: &str,
    command: &str,
) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let shell = hkcu
        .create_subkey(parent)
        .map_err(|error| format!("failed to open {parent}: {error}"))?
        .0;
    let key = shell
        .create_subkey(name)
        .map_err(|error| format!("failed to create {parent}\\{name}: {error}"))?
        .0;
    key.set_value("", &label)
        .map_err(|error| format!("failed to set label: {error}"))?;
    key.set_value("Icon", &icon)
        .map_err(|error| format!("failed to set icon: {error}"))?;
    let cmd = key
        .create_subkey("command")
        .map_err(|error| format!("failed to create command key: {error}"))?
        .0;
    cmd.set_value("", &command)
        .map_err(|error| format!("failed to set command: {error}"))?;
    Ok(())
}

/// HKCU flag so defaults are only applied once (user can then turn tab off).
#[cfg(windows)]
const PREFS_KEY: &str = r"Software\dev.slop.duckweed\ExplorerIntegration";

#[cfg(windows)]
fn defaults_applied() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(PREFS_KEY)
        .ok()
        .and_then(|key| key.get_value::<u32, _>("DefaultsApplied").ok())
        .is_some_and(|value| value != 0)
}

#[cfg(windows)]
fn mark_defaults_applied() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .create_subkey(PREFS_KEY)
        .map_err(|error| format!("failed to open prefs key: {error}"))?
        .0;
    key.set_value("DefaultsApplied", &1u32)
        .map_err(|error| format!("failed to mark defaults: {error}"))
}

#[cfg(windows)]
fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| error.to_string())
}

#[cfg(windows)]
fn icon_value(exe: &std::path::Path) -> String {
    // Prefer a sibling icon.ico when the app is installed next to one; fall
    // back to the first icon embedded in the executable.
    let sibling = exe.with_file_name("icon.ico");
    if sibling.is_file() {
        sibling.to_string_lossy().into_owned()
    } else {
        format!("{},0", exe.to_string_lossy())
    }
}

#[cfg(windows)]
fn quote_path(path: &std::path::Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}
