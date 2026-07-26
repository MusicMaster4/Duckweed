//! Discovery of the shells we can spawn on this machine.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    /// Stable key used by the frontend.
    pub id: String,
    /// Human readable name shown in the UI.
    pub label: String,
    /// Absolute path (or bare name resolvable through PATH) of the executable.
    pub program: String,
    /// Extra arguments needed to get an interactive login shell.
    pub args: Vec<String>,
}

/// Look a bare executable name up in `PATH`, honouring `PATHEXT` on Windows.
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };

    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            if ext.is_empty() {
                continue;
            }
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn push_if_exists(out: &mut Vec<ShellInfo>, id: &str, label: &str, path: &Path, args: &[&str]) {
    if path.is_file() {
        out.push(ShellInfo {
            id: id.to_string(),
            label: label.to_string(),
            program: path.to_string_lossy().to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        });
    }
}

fn push_if_in_path(out: &mut Vec<ShellInfo>, id: &str, label: &str, exe: &str, args: &[&str]) {
    if let Some(path) = find_in_path(exe) {
        push_if_exists(out, id, label, &path, args);
    }
}

#[cfg(windows)]
fn discover_shells() -> Vec<ShellInfo> {
    let mut out = Vec::new();

    push_if_in_path(&mut out, "pwsh", "PowerShell 7", "pwsh", &["-NoLogo"]);
    push_if_in_path(
        &mut out,
        "powershell",
        "Windows PowerShell",
        "powershell",
        &["-NoLogo"],
    );
    push_if_in_path(&mut out, "cmd", "Command Prompt", "cmd", &[]);

    // Git Bash ships a mintty-free bash we can drive through ConPTY.
    for base in [
        std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into()),
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into()),
    ] {
        let candidate = Path::new(&base).join("Git").join("bin").join("bash.exe");
        if candidate.is_file() && !out.iter().any(|s| s.id == "git-bash") {
            push_if_exists(&mut out, "git-bash", "Git Bash", &candidate, &["-i", "-l"]);
        }
    }

    push_if_in_path(&mut out, "wsl", "WSL", "wsl", &[]);
    push_if_in_path(&mut out, "nu", "Nushell", "nu", &[]);

    out
}

#[cfg(not(windows))]
fn discover_shells() -> Vec<ShellInfo> {
    let mut out = Vec::new();

    // The user's configured login shell always comes first.
    if let Ok(sh) = std::env::var("SHELL") {
        let p = PathBuf::from(&sh);
        if p.is_file() {
            let label = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| sh.clone());
            out.push(ShellInfo {
                id: "default".into(),
                label: format!("{label} (default)"),
                program: sh,
                args: vec!["-l".into()],
            });
        }
    }

    for (id, label, exe) in [
        ("zsh", "Zsh", "zsh"),
        ("bash", "Bash", "bash"),
        ("fish", "Fish", "fish"),
        ("nu", "Nushell", "nu"),
        ("sh", "sh", "sh"),
    ] {
        if let Some(path) = find_in_path(exe) {
            if out.iter().any(|s| s.program == path.to_string_lossy()) {
                continue;
            }
            push_if_exists(&mut out, id, label, &path, &["-l"]);
        }
    }

    out
}

/// Installed shells are stable for the lifetime of the app. Keep one catalog
/// instead of walking every PATH directory again whenever a pane starts.
///
/// Apart from avoiding filesystem traffic on the PTY hot path, this also makes
/// several panes opened together share the same result. A newly installed
/// shell becomes available after Duckweed restarts, just like a PATH change.
pub fn available_shells() -> Vec<ShellInfo> {
    static SHELLS: OnceLock<Vec<ShellInfo>> = OnceLock::new();
    SHELLS.get_or_init(discover_shells).clone()
}

/// The shell we spawn when the frontend does not ask for anything specific.
pub fn default_shell() -> ShellInfo {
    if let Some(first) = available_shells().into_iter().next() {
        return first;
    }

    // Last-resort fallbacks so we always have something to spawn.
    #[cfg(windows)]
    {
        ShellInfo {
            id: "cmd".into(),
            label: "Command Prompt".into(),
            program: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            args: vec![],
        }
    }
    #[cfg(not(windows))]
    {
        ShellInfo {
            id: "sh".into(),
            label: "sh".into(),
            program: "/bin/sh".into(),
            args: vec!["-l".into()],
        }
    }
}

/// Resolve a shell id coming from the UI back into something spawnable.
pub fn resolve_shell(id: Option<&str>) -> ShellInfo {
    match id {
        None => default_shell(),
        Some(id) => available_shells()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap_or_else(default_shell),
    }
}
