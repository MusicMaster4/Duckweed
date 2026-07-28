//! Directory listings and simple file read/write for the tools panel.
//!
//! Reading a folder is one syscall per entry; the only interesting part is which
//! entries git ignores, so the explorer can dim generated folders the way an
//! editor's sidebar does. File open goes through the same surface so the
//! explorer can show a file in a popup without shelling out.

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

/// Soft cap for the in-app file viewer. Past this the UI still reports size
/// and refuses to load — a multi-megabyte lockfile is not worth painting.
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    /// Absolute path, so the caller never has to re-join anything.
    pub path: String,
    pub is_dir: bool,
    /// git ignores this entry — shown dimmed and italic, but still listed.
    pub ignored: bool,
}

/// One file that can be mentioned from an agent composer.
#[derive(Serialize, Clone, Debug)]
pub struct WorkspacePath {
    pub name: String,
    /// Absolute path used for the row tooltip and drag/drop parity.
    pub path: String,
    /// Project-relative path inserted after `@`.
    pub relative: String,
}

/// Enough for very large repositories while keeping one IPC payload bounded.
const MAX_WORKSPACE_PATHS: usize = 50_000;

/// Generated dependency trees are neither useful mention targets nor safe to walk.
const SKIP_WORKSPACE_DIRS: [&str; 10] = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "__pycache__",
];

/// Build the file index used by `@` completion.
///
/// The frontend caches this per working directory and performs every keystroke
/// search locally. A bounded breadth-first walk keeps shallow project files
/// available even when a generated tree is unexpectedly large.
pub fn workspace_paths(path: &str) -> Result<Vec<WorkspacePath>, String> {
    let root = Path::new(path);
    if !root.is_dir() {
        return Err(format!("`{path}` is not a directory"));
    }

    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut files = Vec::new();

    while let Some(dir) = queue.pop_front() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !SKIP_WORKSPACE_DIRS
                    .iter()
                    .any(|skipped| name.eq_ignore_ascii_case(skipped))
                {
                    queue.push_back(entry_path);
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }

            let relative = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            files.push(WorkspacePath {
                name,
                path: entry_path.to_string_lossy().to_string(),
                relative,
            });
            if files.len() >= MAX_WORKSPACE_PATHS {
                break;
            }
        }
        if files.len() >= MAX_WORKSPACE_PATHS {
            break;
        }
    }

    files.sort_by(|a, b| a.relative.to_lowercase().cmp(&b.relative.to_lowercase()));
    Ok(files)
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

/// What the file editor needs to render a path: either UTF-8 text, or a reason
/// the popup should stay read-only (binary / too large).
#[derive(Serialize, Clone, Debug)]
pub struct FileContent {
    pub path: String,
    /// Empty when `binary` or `too_large` is set.
    pub content: String,
    pub binary: bool,
    pub too_large: bool,
    /// Bytes on disk.
    pub size: u64,
}

/// Read `path` as text for the project explorer's file popup.
pub fn read_file(path: &str) -> Result<FileContent, String> {
    let file = Path::new(path);
    let meta = std::fs::metadata(file).map_err(|e| format!("could not open `{path}`: {e}"))?;
    if meta.is_dir() {
        return Err(format!("`{path}` is a folder"));
    }
    let size = meta.len();
    if size > MAX_EDIT_BYTES {
        return Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            binary: false,
            too_large: true,
            size,
        });
    }

    let bytes = std::fs::read(file).map_err(|e| format!("could not read `{path}`: {e}"))?;
    // A null byte is enough to treat the file as binary — same rule editors use
    // for "don't dump this into a text field".
    if bytes.contains(&0) {
        return Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            binary: true,
            too_large: false,
            size,
        });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent {
            path: path.to_string(),
            content,
            binary: false,
            too_large: false,
            size,
        }),
        Err(_) => Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            binary: true,
            too_large: false,
            size,
        }),
    }
}

/// Overwrite `path` with UTF-8 `content`. Creates the file if it is missing;
/// never creates parent folders — the explorer only opens paths that already exist.
pub fn write_file(path: &str, content: String) -> Result<(), String> {
    let file = Path::new(path);
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("folder does not exist: {}", parent.display()));
        }
    }
    std::fs::write(file, content.as_bytes()).map_err(|e| format!("could not write `{path}`: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_index_returns_relative_files_and_skips_dependencies() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("duckweed-workspace-index-{unique}"));
        let src = root.join("src");
        let dependencies = root.join("node_modules").join("package");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dependencies).unwrap();
        std::fs::write(src.join("app.ts"), "export {};").unwrap();
        std::fs::write(root.join("README.md"), "# Test").unwrap();
        std::fs::write(dependencies.join("index.js"), "").unwrap();

        let indexed = workspace_paths(&root.to_string_lossy()).unwrap();
        let relative: Vec<&str> = indexed
            .iter()
            .map(|entry| entry.relative.as_str())
            .collect();
        assert_eq!(relative, ["README.md", "src/app.ts"]);
        assert!(indexed
            .iter()
            .all(|entry| Path::new(&entry.path).is_absolute()));

        std::fs::remove_dir_all(root).unwrap();
    }
}
