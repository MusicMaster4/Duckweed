//! Directory listings and simple file read/write for the tools panel.
//!
//! Reading a folder is one syscall per entry; the only interesting part is which
//! entries git ignores, so the explorer can dim generated folders the way an
//! editor's sidebar does. File open goes through the same surface so the
//! explorer can show a file in a popup without shelling out.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use ignore::{DirEntry as WalkEntry, WalkBuilder, WalkState};
use regex::RegexBuilder;
use serde::Deserialize;
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

/// Hard bounds keep a broad query from flooding the webview or reading a
/// generated multi-megabyte artifact into memory.
const MAX_SEARCH_RESULTS: usize = 10_000;
const MAX_SEARCH_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SEARCH_PREVIEW_CONTEXT_CHARS: usize = 120;
const SEARCH_PREVIEW_ELLIPSIS: &str = "...";

#[derive(Deserialize, Clone, Debug)]
pub struct SearchProject {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SearchMatch {
    pub project_path: String,
    pub project_name: String,
    pub path: String,
    pub relative: String,
    /// One-based line number for display and editor navigation.
    pub line: usize,
    /// Zero-based UTF-16 column, matching textarea selection semantics.
    pub column: usize,
    /// Zero-based UTF-16 column within the bounded `line_text` preview.
    pub preview_column: usize,
    pub match_length: usize,
    /// Bounded source-line preview around the match.
    pub line_text: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchResponse {
    pub matches: Vec<SearchMatch>,
    pub files_scanned: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

/// Newer searches supersede older walks. `fetch_max` is important because an
/// older IPC task may reach the blocking pool after the request that replaced it.
#[derive(Default, Clone)]
pub struct SearchGeneration(Arc<AtomicU64>);

impl SearchGeneration {
    pub fn cancel_before(&self, generation: u64) {
        self.0.fetch_max(generation, Ordering::Relaxed);
    }

    fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::Relaxed) == generation
    }
}

fn searchable_entry(entry: &WalkEntry) -> bool {
    let Some(kind) = entry.file_type() else {
        return false;
    };
    kind.is_file()
}

/// Keep search result previews small even when one source line is enormous.
/// The match itself stays intact so the browser can highlight it and use its
/// UTF-16 length for editor navigation.
fn bounded_search_preview(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    let prefix_start = line[..start]
        .char_indices()
        .rev()
        .nth(MAX_SEARCH_PREVIEW_CONTEXT_CHARS.saturating_sub(1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let suffix_end = line[end..]
        .char_indices()
        .nth(MAX_SEARCH_PREVIEW_CONTEXT_CHARS)
        .map(|(index, _)| end + index)
        .unwrap_or(line.len());
    let has_prefix = prefix_start > 0;
    let has_suffix = suffix_end < line.len();

    let mut preview = String::with_capacity(
        line[prefix_start..suffix_end].len()
            + if has_prefix {
                SEARCH_PREVIEW_ELLIPSIS.len()
            } else {
                0
            }
            + if has_suffix {
                SEARCH_PREVIEW_ELLIPSIS.len()
            } else {
                0
            },
    );
    if has_prefix {
        preview.push_str(SEARCH_PREVIEW_ELLIPSIS);
    }
    preview.push_str(&line[prefix_start..start]);
    let column = preview.encode_utf16().count();
    preview.push_str(&line[start..end]);
    let match_length = line[start..end].encode_utf16().count();
    preview.push_str(&line[end..suffix_end]);
    if has_suffix {
        preview.push_str(SEARCH_PREVIEW_ELLIPSIS);
    }

    (preview, column, match_length)
}

/// Search literal text across every open project using parallel, gitignore-aware
/// directory walks. Results carry UTF-16 columns so the browser can select the
/// exact match without rescanning every preceding character in the file.
pub fn search_projects(
    projects: Vec<SearchProject>,
    query: String,
    generation: u64,
    current: Arc<SearchGeneration>,
) -> Result<SearchResponse, String> {
    current.cancel_before(generation);
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(SearchResponse {
            matches: Vec::new(),
            files_scanned: 0,
            truncated: false,
            cancelled: false,
        });
    }

    let matcher = Arc::new(
        RegexBuilder::new(&regex::escape(&query))
            .case_insensitive(true)
            .unicode(true)
            .build()
            .map_err(|error| format!("invalid search: {error}"))?,
    );
    let matches = Arc::new(Mutex::new(Vec::<SearchMatch>::new()));
    let files_scanned = Arc::new(AtomicU64::new(0));
    let truncated = Arc::new(AtomicU64::new(0));

    // Duplicate folders can be open in multiple tabs. Search each on-disk root
    // once, preferring the first visible name supplied by the frontend.
    let mut unique = HashMap::<String, String>::new();
    for project in projects {
        unique.entry(project.path).or_insert(project.name);
    }

    for (project_path, project_name) in unique {
        if !current.is_current(generation) || truncated.load(Ordering::Relaxed) != 0 {
            break;
        }
        let root = Path::new(&project_path);
        if !root.is_dir() {
            continue;
        }

        let mut builder = WalkBuilder::new(root);
        builder
            .hidden(false)
            .follow_links(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let name = entry.file_name().to_string_lossy();
                !SKIP_WORKSPACE_DIRS
                    .iter()
                    .any(|skipped| name.eq_ignore_ascii_case(skipped))
            });

        let root = root.to_path_buf();
        let project_path_for_match = project_path.clone();
        let project_name_for_match = project_name.clone();
        let matcher_for_walk = matcher.clone();
        let matches_for_walk = matches.clone();
        let files_for_walk = files_scanned.clone();
        let truncated_for_walk = truncated.clone();
        let current_for_walk = current.clone();

        builder.build_parallel().run(|| {
            let root = root.clone();
            let project_path = project_path_for_match.clone();
            let project_name = project_name_for_match.clone();
            let matcher = matcher_for_walk.clone();
            let matches = matches_for_walk.clone();
            let files_scanned = files_for_walk.clone();
            let truncated = truncated_for_walk.clone();
            let current = current_for_walk.clone();

            Box::new(move |entry| {
                if !current.is_current(generation) || truncated.load(Ordering::Relaxed) != 0 {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !searchable_entry(&entry) {
                    return WalkState::Continue;
                }
                let Ok(meta) = entry.metadata() else {
                    return WalkState::Continue;
                };
                if meta.len() > MAX_SEARCH_FILE_BYTES {
                    return WalkState::Continue;
                }
                let Ok(bytes) = std::fs::read(entry.path()) else {
                    return WalkState::Continue;
                };
                if bytes.contains(&0) {
                    return WalkState::Continue;
                }
                let Ok(text) = String::from_utf8(bytes) else {
                    return WalkState::Continue;
                };
                files_scanned.fetch_add(1, Ordering::Relaxed);

                let relative = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let path = entry.path().to_string_lossy().to_string();
                for (line_index, line_with_newline) in text.split_inclusive('\n').enumerate() {
                    let line_text = line_with_newline.trim_end_matches(['\r', '\n']);
                    for found in matcher.find_iter(line_text) {
                        let column = line_text[..found.start()].encode_utf16().count();
                        let (preview, preview_column, match_length) =
                            bounded_search_preview(line_text, found.start(), found.end());
                        let mut guard = matches
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if guard.len() >= MAX_SEARCH_RESULTS {
                            truncated.store(1, Ordering::Relaxed);
                            return WalkState::Quit;
                        }
                        guard.push(SearchMatch {
                            project_path: project_path.clone(),
                            project_name: project_name.clone(),
                            path: path.clone(),
                            relative: relative.clone(),
                            line: line_index + 1,
                            column,
                            preview_column,
                            match_length,
                            line_text: preview,
                        });
                    }
                }
                WalkState::Continue
            })
        });
    }

    let cancelled = !current.is_current(generation);
    let mut found = matches
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    found.sort_by(|a, b| {
        a.project_name
            .to_lowercase()
            .cmp(&b.project_name.to_lowercase())
            .then_with(|| a.relative.to_lowercase().cmp(&b.relative.to_lowercase()))
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| a.column.cmp(&b.column))
    });
    Ok(SearchResponse {
        matches: found,
        files_scanned: files_scanned.load(Ordering::Relaxed) as usize,
        truncated: truncated.load(Ordering::Relaxed) != 0,
        cancelled,
    })
}

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

const MAX_DROPPED_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// Read a dropped image without exposing an unbounded binary-file IPC endpoint.
pub fn read_dropped_image(path: &str) -> Result<Vec<u8>, String> {
    let file = Path::new(path);
    let meta = std::fs::metadata(file).map_err(|e| format!("could not open `{path}`: {e}"))?;
    if meta.is_dir() {
        return Err(format!("`{path}` is a folder"));
    }
    if meta.len() > MAX_DROPPED_IMAGE_BYTES {
        return Err("Images must be 5 MB or smaller.".into());
    }
    std::fs::read(file).map_err(|e| format!("could not read `{path}`: {e}"))
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

/// Resolve an agent-requested file against a workspace after following every
/// symlink/junction in the existing portion of the path. A lexical prefix is
/// not sufficient here: `workspace/link/file` may actually live outside the
/// workspace when `link` is a filesystem link.
fn workspace_file_path(workspace: &str, requested: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|e| format!("could not open workspace `{workspace}`: {e}"))?;
    let requested_path = Path::new(requested);
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        root.join(requested_path)
    };

    // Existing targets can be canonicalized directly. New files use their
    // canonical parent, which also catches a parent symlink or junction that
    // escapes the workspace.
    let resolved = match std::fs::symlink_metadata(&candidate) {
        Ok(_) => std::fs::canonicalize(&candidate)
            .map_err(|e| format!("could not resolve `{}`: {e}", candidate.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = candidate
                .parent()
                .ok_or_else(|| format!("`{}` has no parent folder", candidate.display()))?;
            let name = candidate
                .file_name()
                .ok_or_else(|| format!("`{}` is not a file path", candidate.display()))?;
            std::fs::canonicalize(parent)
                .map_err(|e| format!("could not resolve folder `{}`: {e}", parent.display()))?
                .join(name)
        }
        Err(error) => {
            return Err(format!(
                "could not inspect `{}`: {error}",
                candidate.display()
            ));
        }
    };

    if resolved != root && !resolved.starts_with(&root) {
        return Err("Path outside workspace.".into());
    }
    Ok(resolved)
}

/// Read text on behalf of an agent, confined to its launched workspace.
pub fn read_workspace_file(workspace: &str, path: &str) -> Result<FileContent, String> {
    let resolved = workspace_file_path(workspace, path)?;
    read_file(&resolved.to_string_lossy())
}

/// Write text on behalf of an agent, confined to its launched workspace.
pub fn write_workspace_file(workspace: &str, path: &str, content: String) -> Result<(), String> {
    let resolved = workspace_file_path(workspace, path)?;
    write_file(&resolved.to_string_lossy(), content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("duckweed-{label}-{unique}"))
    }

    #[test]
    fn workspace_file_access_rejects_paths_outside_the_canonical_root() {
        let root = temporary_root("workspace-file-root");
        let outside = temporary_root("workspace-file-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, "secret").unwrap();

        assert_eq!(
            read_workspace_file(&root.to_string_lossy(), &outside_file.to_string_lossy())
                .unwrap_err(),
            "Path outside workspace."
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_file_access_rejects_a_symlink_that_escapes_the_root() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("workspace-link-root");
        let outside = temporary_root("workspace-link-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, root.join("link")).unwrap();

        assert_eq!(
            read_workspace_file(&root.to_string_lossy(), "link/secret.txt").unwrap_err(),
            "Path outside workspace."
        );
        assert_eq!(
            write_workspace_file(
                &root.to_string_lossy(),
                "link/new.txt",
                "overwritten".into(),
            )
            .unwrap_err(),
            "Path outside workspace."
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

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

    #[test]
    fn project_search_finds_literal_text_and_reports_utf16_positions() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("duckweed-project-search-{unique}"));
        let src = root.join("src");
        let dependencies = root.join("node_modules").join("package");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dependencies).unwrap();
        std::fs::write(src.join("app.ts"), "first\n😀 Needle here\n").unwrap();
        std::fs::write(dependencies.join("index.js"), "needle").unwrap();

        let current = Arc::new(SearchGeneration::default());
        let response = search_projects(
            vec![SearchProject {
                path: root.to_string_lossy().to_string(),
                name: "Test app".into(),
            }],
            "needle".into(),
            1,
            current,
        )
        .unwrap();

        assert!(!response.cancelled);
        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].relative, "src/app.ts");
        assert_eq!(response.matches[0].line, 2);
        assert_eq!(response.matches[0].column, 3);
        assert_eq!(response.matches[0].preview_column, 3);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_preview_bounds_context_while_preserving_the_match_offset() {
        let prefix = "x".repeat(MAX_SEARCH_PREVIEW_CONTEXT_CHARS + 20);
        let suffix = "z".repeat(MAX_SEARCH_PREVIEW_CONTEXT_CHARS + 20);
        let line = format!("{prefix}needle{suffix}");
        let start = prefix.len();
        let (preview, preview_column, match_length) =
            bounded_search_preview(&line, start, start + "needle".len());

        assert_eq!(
            preview,
            format!(
                "...{}needle{}...",
                "x".repeat(MAX_SEARCH_PREVIEW_CONTEXT_CHARS),
                "z".repeat(MAX_SEARCH_PREVIEW_CONTEXT_CHARS),
            )
        );
        assert_eq!(
            preview_column,
            SEARCH_PREVIEW_ELLIPSIS.len() + MAX_SEARCH_PREVIEW_CONTEXT_CHARS
        );
        assert_eq!(match_length, "needle".encode_utf16().count());
        assert_eq!(
            line[..start].encode_utf16().count(),
            MAX_SEARCH_PREVIEW_CONTEXT_CHARS + 20
        );
    }
}
