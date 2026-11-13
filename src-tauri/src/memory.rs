//! How much memory the operating system can still hand out.
//!
//! Windows refuses allocations once the commit charge reaches its limit, even
//! while physical RAM is free. Renderers then die as "out of memory", agents
//! stall on startup and Rust aborts on a failed allocation. Recording the
//! headroom is what tells that apart from a leak inside Duckweed.

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemory {
    pub commit_limit_bytes: u64,
    pub commit_available_bytes: u64,
    pub physical_total_bytes: u64,
    pub physical_available_bytes: u64,
    /// New processes and large allocations are likely to fail.
    pub low: bool,
}

#[cfg(any(windows, test))]
const LOW_COMMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Below 2 GB, or 4% of the limit on machines where that is larger.
#[cfg(any(windows, test))]
fn is_low(commit_limit: u64, commit_available: u64) -> bool {
    commit_available < LOW_COMMIT_BYTES.max(commit_limit / 25)
}

#[cfg(windows)]
pub fn status() -> Option<SystemMemory> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    Some(SystemMemory {
        commit_limit_bytes: status.ullTotalPageFile,
        commit_available_bytes: status.ullAvailPageFile,
        physical_total_bytes: status.ullTotalPhys,
        physical_available_bytes: status.ullAvailPhys,
        low: is_low(status.ullTotalPageFile, status.ullAvailPageFile),
    })
}

#[cfg(not(windows))]
pub fn status() -> Option<SystemMemory> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn low_commit_is_absolute_on_small_machines_and_relative_on_large_ones() {
        assert!(is_low(16 * GB, GB));
        assert!(!is_low(16 * GB, 3 * GB));
        assert!(is_low(86 * GB, 3 * GB));
        assert!(!is_low(86 * GB, 4 * GB));
    }

    #[cfg(windows)]
    #[test]
    fn reports_the_running_system() {
        let memory = status().unwrap();
        assert!(memory.commit_limit_bytes >= memory.commit_available_bytes);
        assert!(memory.physical_total_bytes > 0);
    }
}
