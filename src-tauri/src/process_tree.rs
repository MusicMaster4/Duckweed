//! Detect whether a shell still has child processes running.
//!
//! Used to warn before closing a pane/tab/window when a command is mid-flight.
//! Direct children of the shell PID are enough: nested process trees still show
//! up as at least one direct child of the shell.

/// True when `pid` currently has one or more direct child processes.
pub fn has_child_processes(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    platform_has_children(pid)
}

#[cfg(windows)]
fn platform_has_children(pid: u32) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

        let mut found = false;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == pid {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        found
    }
}

/// Linux: walk `/proc` and look for processes whose parent is `pid`.
#[cfg(all(unix, not(target_os = "macos")))]
fn platform_has_children(pid: u32) -> bool {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if parse_ppid(&stat) == Some(pid) {
            return true;
        }
    }
    false
}

/// macOS has no `/proc`; fall back to `pgrep -P`.
#[cfg(target_os = "macos")]
fn platform_has_children(pid: u32) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .map(|out| out.status.success() && !out.stdout.is_empty())
        .unwrap_or(false)
}

/// Parse the parent pid from a Linux `/proc/<pid>/stat` line.
/// Format: `pid (comm) state ppid ...` — `comm` may contain spaces and parens.
#[cfg(all(unix, not(target_os = "macos")))]
fn parse_ppid(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    let after = stat.get(close + 2..)?;
    // after: "state ppid ..."
    let mut parts = after.split_whitespace();
    let _state = parts.next()?;
    parts.next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn parse_ppid_handles_spaces_in_comm() {
        let line = "123 (my process) S 456 789 0 0";
        assert_eq!(super::parse_ppid(line), Some(456));
    }
}
