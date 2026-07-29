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
//!
//! Also notifies Explorer when the app icon embedded in the exe changes, so
//! desktop / Start / taskbar shortcuts pick up a new icon after an update
//! without requiring a reinstall or manual icon-cache clear.

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
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

/// Re-write enabled verbs with the executable that Explorer should launch.
///
/// Development builds used to register `target\debug\duckweed.exe`. That
/// binary depends on the Vite development server, so launching it later from
/// Explorer opens a console and leaves the app window blank. Running either an
/// installed or development build now repairs those stale entries.
#[cfg(windows)]
pub fn repair_enabled_verbs() {
    for verb in [ShellVerb::Tab, ShellVerb::Window] {
        if verb_installed(verb) {
            let _ = install_verb(verb);
        }
    }
}

#[cfg(not(windows))]
pub fn repair_enabled_verbs() {}

/// After an update, Windows often keeps showing the previous app icon.
/// Call once per product version so Explorer reloads the icon from the exe.
#[cfg(windows)]
pub fn refresh_icons_if_needed(version: &str) {
    if version.is_empty() {
        return;
    }
    if icon_refresh_version().as_deref() == Some(version) {
        return;
    }
    // Re-write Icon registry values for any installed verbs so they still
    // point at the installed binary (and index 0 of its icon resource).
    repair_enabled_verbs();
    notify_shell_icons_changed();
    let _ = store_icon_refresh_version(version);
}

#[cfg(not(windows))]
pub fn refresh_icons_if_needed(_version: &str) {}

#[cfg(windows)]
fn notify_shell_icons_changed() {
    use windows_sys::Win32::UI::Shell::{
        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_FLUSHNOWAIT, SHCNF_IDLIST,
        SHCNF_PATHW,
    };

    unsafe {
        if let Ok(exe) = registration_exe() {
            let wide: Vec<u16> = exe
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            SHChangeNotify(
                SHCNE_UPDATEITEM as i32,
                (SHCNF_PATHW | SHCNF_FLUSHNOWAIT) as u32,
                wide.as_ptr().cast(),
                std::ptr::null(),
            );
        }
        // Broad association refresh — picks up shortcut / shell-extension icons.
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST as u32,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

#[cfg(windows)]
fn icon_refresh_version() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(PREFS_KEY)
        .ok()
        .and_then(|key| key.get_value::<String, _>("IconRefreshVersion").ok())
}

#[cfg(windows)]
fn store_icon_refresh_version(version: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .create_subkey(PREFS_KEY)
        .map_err(|error| format!("failed to open prefs key: {error}"))?
        .0;
    key.set_value("IconRefreshVersion", &version)
        .map_err(|error| format!("failed to store icon refresh version: {error}"))
}

#[cfg(windows)]
fn verb_installed(verb: ShellVerb) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(format!(r"Software\Classes\Directory\shell\{}", verb.key()))
        .is_ok()
}

#[cfg(windows)]
fn install_verb(verb: ShellVerb) -> Result<(), String> {
    let exe = registration_exe()?;
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

/// Release builds register themselves. A development build must target the
/// installed app because its own executable cannot run without the dev server.
#[cfg(windows)]
fn registration_exe() -> Result<PathBuf, String> {
    choose_registration_exe(current_exe()?, installed_exe(), cfg!(debug_assertions))
}

#[cfg(windows)]
fn choose_registration_exe(
    current: PathBuf,
    installed: Option<PathBuf>,
    debug: bool,
) -> Result<PathBuf, String> {
    if !debug {
        return Ok(current);
    }
    installed.ok_or_else(|| {
        "Install Duckweed before enabling its Windows Explorer context menu".to_string()
    })
}

/// Resolve the NSIS installation independently of the development checkout.
/// The uninstall entry covers custom install locations; LOCALAPPDATA is the
/// normal current-user fallback.
#[cfg(windows)]
fn installed_exe() -> Option<PathBuf> {
    const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Duckweed";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(UNINSTALL_KEY) {
        if let Ok(raw) = key.get_value::<String, _>("InstallLocation") {
            let candidate = PathBuf::from(raw.trim().trim_matches('"')).join("duckweed.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if let Ok(raw) = key.get_value::<String, _>("DisplayIcon") {
            let candidate = PathBuf::from(raw.trim().trim_matches('"'));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("Duckweed").join("duckweed.exe"))
        .filter(|candidate| candidate.is_file())
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn release_build_registers_the_running_executable() {
        let current = PathBuf::from(r"C:\Duckweed\duckweed.exe");
        let installed = PathBuf::from(r"D:\Installed\duckweed.exe");
        assert_eq!(
            choose_registration_exe(current.clone(), Some(installed), false).unwrap(),
            current
        );
    }

    #[test]
    fn debug_build_registers_the_installed_executable() {
        let current = PathBuf::from(r"H:\repo\target\debug\duckweed.exe");
        let installed = PathBuf::from(r"C:\Users\me\AppData\Local\Duckweed\duckweed.exe");
        assert_eq!(
            choose_registration_exe(current, Some(installed.clone()), true).unwrap(),
            installed
        );
    }

    #[test]
    fn debug_build_never_registers_itself_without_an_install() {
        let current = PathBuf::from(r"H:\repo\target\debug\duckweed.exe");
        assert!(choose_registration_exe(current, None, true).is_err());
    }
}
