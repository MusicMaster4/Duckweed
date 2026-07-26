//! Directory listings for the tools panel's project explorer.
//!
//! Reading a folder is one syscall per entry; the only interesting part is which
//! entries git ignores, so the explorer can dim generated folders the way an
//! editor's sidebar does.

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    /// Absolute path, so the caller never has to re-join anything.
    pub path: String,
    pub is_dir: bool,
    /// git ignores this entry — shown dimmed and italic, but still listed.
    pub ignored: bool,
}

/// Names of `dir` that git ignores. Anything unexpected (no git, no repo, a
/// spawn failure) means "nothing is ignored" — a listing is worth more than a
/// perfect one.
fn ignored_names(dir: &Path, names: &[String]) -> HashSet<String> {
    if names.is_empty() {
        return HashSet::new();
    }

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["check-ignore", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(mut child) = cmd.spawn() else {
        return HashSet::new();
    };
    // Feeding the names through stdin rather than argv: a folder can hold tens
    // of thousands of entries, well past the command-line length limit.
    if let Some(mut stdin) = child.stdin.take() {
        for name in names {
            if writeln!(stdin, "{name}").is_err() {
                break;
            }
        }
    }
    let Ok(out) = child.wait_with_output() else {
        return HashSet::new();
    };
    // Exit code 1 just means nothing matched; stdout is empty and that is fine.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// One level of `path`: folders first, then files, each run sorted by name.
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(path);
    let read = std::fs::read_dir(dir).map_err(|e| format!("could not read `{path}`: {e}"))?;

    let mut found: Vec<(String, bool)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // `path().is_dir()` follows symlinks, which is what the tree wants: a
        // link to a folder should open like the folder it points at.
        found.push((name, entry.path().is_dir()));
    }

    let names: Vec<String> = found.iter().map(|(name, _)| name.clone()).collect();
    let ignored = ignored_names(dir, &names);

    let mut entries: Vec<DirEntry> = found
        .into_iter()
        .map(|(name, is_dir)| DirEntry {
            path: dir.join(&name).to_string_lossy().to_string(),
            // git never reports `.git` itself, but it is every bit as generated
            // as the folders that are ignored by name.
            ignored: name == ".git" || ignored.contains(&name),
            name,
            is_dir,
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
