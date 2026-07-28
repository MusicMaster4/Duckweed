//! Detect whether a shell still has child processes running.
//!
//! Used to warn before closing a pane/tab/window when a command is mid-flight.
//! Direct children of the shell PID are enough: nested process trees still show
//! up as at least one direct child of the shell.

use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// True when `pid` currently has one or more direct child processes.
#[cfg(test)]
pub fn has_child_processes(pid: u32) -> bool {
    parents_with_children(&[pid]).contains(&pid)
}

/// Return the requested parent PIDs that currently own at least one child.
///
/// Busy state is sampled for every terminal at once. This matters on Windows,
/// where taking the process snapshot is most of the cost; one monitor tick must
/// not take one system-wide snapshot per pane.
pub fn parents_with_children(pids: &[u32]) -> HashSet<u32> {
    let wanted: HashSet<u32> = pids.iter().copied().filter(|pid| *pid != 0).collect();
    if wanted.is_empty() {
        return HashSet::new();
    }
    platform_parents_with_children(&wanted)
}

/// One process-table snapshot for features that need full descendant ownership.
///
/// Keeping this beside the busy probe means Ports can attribute listeners to a
/// Duckweed terminal or agent without adding another process-table dependency.
pub fn process_snapshot() -> Vec<ProcessInfo> {
    platform_process_snapshot()
}

#[cfg(windows)]
fn platform_parents_with_children(wanted: &HashSet<u32>) -> HashSet<u32> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return HashSet::new();
        }

        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

        let mut found = HashSet::new();
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if wanted.contains(&entry.th32ParentProcessID) {
                    found.insert(entry.th32ParentProcessID);
                    if found.len() == wanted.len() {
                        break;
                    }
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

#[cfg(windows)]
fn platform_process_snapshot() -> Vec<ProcessInfo> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Vec::new();
        }

        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut processes = Vec::new();
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                processes.push(ProcessInfo {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..end]),
                });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        processes
    }
}

/// Linux: walk `/proc` and look for processes whose parent is `pid`.
#[cfg(all(unix, not(target_os = "macos")))]
fn platform_parents_with_children(wanted: &HashSet<u32>) -> HashSet<u32> {
    let mut found = HashSet::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return found;
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
        if let Some(ppid) = parse_ppid(&stat) {
            if wanted.contains(&ppid) {
                found.insert(ppid);
                if found.len() == wanted.len() {
                    break;
                }
            }
        }
    }
    found
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_process_snapshot() -> Vec<ProcessInfo> {
    let mut processes = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return processes;
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(ppid) = parse_ppid(&stat) else {
            continue;
        };
        let process_name = stat
            .find('(')
            .zip(stat.rfind(')'))
            .and_then(|(start, end)| stat.get(start + 1..end))
            .unwrap_or("")
            .to_string();
        processes.push(ProcessInfo {
            pid,
            ppid,
            name: process_name,
        });
    }
    processes
}

/// macOS has no `/proc`; one `ps` call is still cheaper than one `pgrep` per PTY.
#[cfg(target_os = "macos")]
fn platform_parents_with_children(wanted: &HashSet<u32>) -> HashSet<u32> {
    std::process::Command::new("ps")
        .args(["-Ao", "ppid="])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .filter(|pid| wanted.contains(pid))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn platform_process_snapshot() -> Vec<ProcessInfo> {
    let Some(output) = std::process::Command::new("ps")
        .args(["-Ao", "pid=,ppid=,comm="])
        .output()
        .ok()
        .filter(|out| out.status.success())
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            let name = fields.collect::<Vec<_>>().join(" ");
            Some(ProcessInfo { pid, ppid, name })
        })
        .collect()
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
    #[test]
    fn empty_pid_set_is_empty() {
        assert!(super::parents_with_children(&[]).is_empty());
        assert!(!super::has_child_processes(0));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn parse_ppid_handles_spaces_in_comm() {
        let line = "123 (my process) S 456 789 0 0";
        assert_eq!(super::parse_ppid(line), Some(456));
    }
}
