//! Branches, and the diff of what is not committed yet.
//!
//! Reading `HEAD` (see `project.rs`) is enough to *show* a branch, but listing,
//! checking out and diffing are real git operations — so these shell out, and
//! report git's own stderr when it refuses (dirty tree, unknown branch, no repo).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Branches {
    /// Branch `HEAD` points at, or `None` when it is detached.
    pub current: Option<String>,
    pub local: Vec<String>,
    /// `origin/feature` names that have no local branch yet.
    pub remote: Vec<String>,
}

/// Run git in `dir`, returning stdout — or git's own message as the error.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Without this the release build flashes a console window per call.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("git {} failed", args.first().unwrap_or(&""))
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn has_local(dir: &Path, name: &str) -> bool {
    git(
        dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )
    .is_ok()
}

pub fn branches(path: &str) -> Result<Branches, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("`{path}` is not a directory"));
    }

    // Detached HEAD is not an error here — there is simply no current branch.
    let current = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Most recently committed first: the branch you are looking for is nearly
    // always one of the last few you touched.
    let listing = git(
        dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut local = Vec::new();
    let mut remotes = Vec::new();
    for line in listing.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(name) = line.strip_prefix("refs/heads/") {
            local.push(name.to_string());
        } else if let Some(name) = line.strip_prefix("refs/remotes/") {
            // `origin/HEAD` is a pointer at the remote's default branch, not a
            // branch of its own.
            if name.ends_with("/HEAD") {
                continue;
            }
            remotes.push(name.to_string());
        }
    }

    // A remote branch already checked out locally would be a duplicate entry.
    let remote = remotes
        .into_iter()
        .filter(|r| match r.split_once('/') {
            Some((_, short)) => !local.iter().any(|l| l == short),
            None => true,
        })
        .collect();

    Ok(Branches {
        current,
        local,
        remote,
    })
}

pub fn checkout(path: &str, branch: &str) -> Result<(), String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("`{path}` is not a directory"));
    }

    if has_local(dir, branch) {
        git(dir, &["checkout", branch])?;
        return Ok(());
    }

    // A remote-tracking name (`origin/feature`): check out the branch it tracks,
    // creating the local one the first time. Git would infer this itself, but
    // only when exactly one remote has the name — doing it here is unambiguous.
    if let Some((_, short)) = branch.split_once('/') {
        if has_local(dir, short) {
            git(dir, &["checkout", short])?;
        } else {
            git(dir, &["checkout", "-b", short, "--track", branch])?;
        }
        return Ok(());
    }

    git(dir, &["checkout", branch])?;
    Ok(())
}

// --------------------------------------------------------------------- diffs

/// Git's empty tree. A repo whose first commit has not happened yet has no
/// `HEAD` to diff against, and this is the object id that means "nothing".
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Files past this size are never read. A preview of them is not worth looking
/// at, and the read alone would stall the window.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// How much of a file to inspect before deciding it is binary — the same first
/// impression git itself goes on.
const SNIFF_BYTES: usize = 8000;

/// What the chip in the status bar counts.
#[derive(Serialize, Clone, Debug, Default)]
pub struct DiffStats {
    pub files: usize,
    pub insertions: usize,
    pub deletions: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffLine {
    /// `"ctx"`, `"add"` or `"del"`.
    pub kind: &'static str,
    /// Number this line had before the change — `None` on an added line.
    pub old: Option<usize>,
    /// Number this line has now — `None` on a removed line.
    pub new: Option<usize>,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Hunk {
    pub old_start: usize,
    pub new_start: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FileDiff {
    /// Relative to the repo root, in git's forward-slash form.
    pub path: String,
    /// Where a renamed file came from.
    pub old_path: Option<String>,
    /// `"modified"`, `"added"`, `"deleted"`, `"renamed"` or `"untracked"`.
    pub status: &'static str,
    pub insertions: usize,
    pub deletions: usize,
    /// Nothing to show: a binary file, or one too large to read.
    pub binary: bool,
    /// Lines the file has now, so the viewer can size the unmodified run that
    /// follows the last hunk. Zero when the file is gone or unreadable.
    pub new_lines: usize,
    pub hunks: Vec<Hunk>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Diff {
    /// Repo root — the paths inside are relative to it, not to the tab's folder.
    pub root: String,
    pub stats: DiffStats,
    pub files: Vec<FileDiff>,
}

fn repo_root(path: &str) -> Result<PathBuf, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("`{path}` is not a directory"));
    }
    let out = git(dir, &["rev-parse", "--show-toplevel"])?;
    let root = out.trim();
    if root.is_empty() {
        return Err("not a git repository".to_string());
    }
    Ok(PathBuf::from(root))
}

/// What the working tree is measured against.
fn diff_base(root: &Path) -> &'static str {
    if git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        "HEAD"
    } else {
        EMPTY_TREE
    }
}

/// One `--numstat` record: the authoritative path and counts for a changed file.
struct NumStat {
    path: String,
    old_path: Option<String>,
    insertions: usize,
    deletions: usize,
    binary: bool,
}

fn numstat(root: &Path, args: &[&str]) -> Result<Vec<NumStat>, String> {
    Ok(parse_numstat(&git(root, args)?))
}

/// `git diff --numstat -z` writes `adds\tdels\tpath\0`, and for a rename
/// `adds\tdels\t\0old\0new\0` — an empty third field, then the two paths. `-z`
/// is what keeps paths with spaces or non-ASCII out of git's quoting rules.
fn parse_numstat(out: &str) -> Vec<NumStat> {
    let mut fields: Vec<&str> = out.split('\0').collect();
    if fields.last() == Some(&"") {
        fields.pop();
    }

    let mut entries = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let mut parts = fields[i].splitn(3, '\t');
        i += 1;
        let (adds, dels, name) = match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(d), Some(n)) => (a, d, n),
            _ => continue,
        };
        let (path, old_path) = if name.is_empty() {
            let old = fields.get(i).copied().unwrap_or_default().to_string();
            let new = fields.get(i + 1).copied().unwrap_or_default().to_string();
            i += 2;
            (new, Some(old))
        } else {
            (name.to_string(), None)
        };
        entries.push(NumStat {
            path,
            old_path,
            // Binary files come through as `-\t-\t<path>`.
            insertions: adds.parse().unwrap_or(0),
            deletions: dels.parse().unwrap_or(0),
            binary: adds == "-" || dels == "-",
        });
    }
    entries
}

/// Files git has never been told about. `git diff` says nothing about these, so
/// they are built from what is on disk instead.
fn untracked_paths(root: &Path) -> Vec<String> {
    git(root, &["ls-files", "--others", "--exclude-standard", "-z"])
        .map(|out| {
            out.split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The file's lines, or `None` when it is binary, missing or too large to show.
fn text_lines(path: &Path) -> Option<Vec<String>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.is_empty() {
        return Some(Vec::new());
    }
    // A trailing newline terminates the last line, it does not start another.
    let body = text.strip_suffix('\n').unwrap_or(&text);
    Some(
        body.split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .collect(),
    )
}

fn count_lines(path: &Path) -> usize {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return 0;
    };
    if bytes.is_empty() || bytes.iter().take(SNIFF_BYTES).any(|byte| *byte == 0) {
        return 0;
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count();
    newlines + usize::from(bytes.last() != Some(&b'\n'))
}

/// The parts of a patch that only the patch knows — everything else about a
/// file comes from `--numstat`, which cannot be confused by an odd path.
#[derive(Default)]
struct ParsedFile {
    new_file: bool,
    deleted: bool,
    binary: bool,
    hunks: Vec<Hunk>,
}

/// `@@ -12,7 +14,9 @@ …` → the line each side starts at.
fn parse_hunk_header(line: &str) -> Option<(usize, usize)> {
    let inner = line.strip_prefix("@@ ")?;
    let end = inner.find(" @@")?;
    let mut ranges = inner[..end].split(' ');
    let old = ranges.next()?.strip_prefix('-')?;
    let new = ranges.next()?.strip_prefix('+')?;
    let start = |range: &str| range.split(',').next()?.parse::<usize>().ok();
    Some((start(old)?, start(new)?))
}

/// Split a unified diff into one entry per file, in the order git emitted them.
///
/// Paths are deliberately *not* read from here: `diff --git a/x b/x` cannot be
/// split reliably when a name contains a space, and `--numstat -z` already
/// answers that question exactly.
fn parse_patch(patch: &str) -> Vec<ParsedFile> {
    let mut files: Vec<ParsedFile> = Vec::new();
    let mut old_no = 0;
    let mut new_no = 0;
    let mut in_hunk = false;

    for raw in patch.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);

        if line.starts_with("diff --git ") {
            files.push(ParsedFile::default());
            in_hunk = false;
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };

        if line.starts_with("@@") {
            let Some((old, new)) = parse_hunk_header(line) else {
                continue;
            };
            old_no = old;
            new_no = new;
            file.hunks.push(Hunk {
                old_start: old,
                new_start: new,
                lines: Vec::new(),
            });
            in_hunk = true;
            continue;
        }

        if !in_hunk {
            if line.starts_with("new file mode") {
                file.new_file = true;
            } else if line.starts_with("deleted file mode") {
                file.deleted = true;
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                file.binary = true;
            }
            continue;
        }

        let Some(hunk) = file.hunks.last_mut() else {
            in_hunk = false;
            continue;
        };
        // The marker is always one ASCII byte, so slicing past it is safe.
        match line.as_bytes().first() {
            Some(b'+') => {
                hunk.lines.push(DiffLine {
                    kind: "add",
                    old: None,
                    new: Some(new_no),
                    text: line[1..].to_string(),
                });
                new_no += 1;
            }
            Some(b'-') => {
                hunk.lines.push(DiffLine {
                    kind: "del",
                    old: Some(old_no),
                    new: None,
                    text: line[1..].to_string(),
                });
                old_no += 1;
            }
            Some(b' ') => {
                hunk.lines.push(DiffLine {
                    kind: "ctx",
                    old: Some(old_no),
                    new: Some(new_no),
                    text: line[1..].to_string(),
                });
                old_no += 1;
                new_no += 1;
            }
            // `\ No newline at end of file` annotates the line above it.
            Some(b'\\') => {}
            // Anything else — including the blank line that ends the patch — is
            // past the end of the hunk body.
            _ => in_hunk = false,
        }
    }
    files
}

/// Count newlines in many files at once. Sequential I/O is fine for a handful;
/// past that, fan out so a pile of untracked sources does not serialize the chip.
fn count_lines_many(root: &Path, names: &[String]) -> Vec<usize> {
    const PARALLEL_AFTER: usize = 4;
    if names.len() < PARALLEL_AFTER {
        return names
            .iter()
            .map(|name| count_lines(&root.join(name)))
            .collect();
    }

    thread::scope(|scope| {
        let handles: Vec<_> = names
            .iter()
            .map(|name| scope.spawn(move || count_lines(&root.join(name))))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or(0))
            .collect()
    })
}

/// Every uncommitted change under `root`, at `context` lines of context.
///
/// `only` narrows it to one path, which is how a file gets re-read with its
/// whole body once the viewer asks to see the unmodified parts.
fn collect(root: &Path, only: Option<&str>, context: u32) -> Result<Vec<FileDiff>, String> {
    let base = diff_base(root);
    let unified = format!("--unified={context}");

    let mut stat_args = vec!["diff", "--numstat", "-z", base];
    let mut patch_args = vec!["diff", "--no-ext-diff", "--no-color", unified.as_str(), base];
    if let Some(name) = only {
        stat_args.extend_from_slice(&["--", name]);
        patch_args.extend_from_slice(&["--", name]);
    }

    // numstat and the patch walk the same tree; overlapping them cuts wall time
    // roughly in half when either side is non-trivial.
    let (entries, patch_text) = thread::scope(|scope| {
        let stat = scope.spawn(|| numstat(root, &stat_args));
        let patch = scope.spawn(|| git(root, &patch_args));
        match (stat.join(), patch.join()) {
            (Ok(entries), Ok(patch)) => (entries, patch),
            (Err(_), _) | (_, Err(_)) => (
                Err("diff worker panicked".to_string()),
                Err("diff worker panicked".to_string()),
            ),
        }
    });
    let entries = entries?;
    let parsed = parse_patch(&patch_text?);

    // Line counts for surviving files are independent; fan them out so a large
    // multi-file change is not one full-file read after another.
    let line_targets: Vec<Option<String>> = entries
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let patch = parsed.get(i);
            let deleted = patch.is_some_and(|f| f.deleted);
            let binary = entry.binary || patch.is_some_and(|f| f.binary);
            if binary || deleted {
                None
            } else {
                Some(entry.path.clone())
            }
        })
        .collect();
    let names_to_count: Vec<String> = line_targets.iter().filter_map(|p| p.clone()).collect();
    let counted = count_lines_many(root, &names_to_count);
    let mut counted_at = 0usize;

    let mut files = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let patch = parsed.get(i);
        let status = if entry.old_path.is_some() {
            "renamed"
        } else if patch.is_some_and(|f| f.new_file) {
            "added"
        } else if patch.is_some_and(|f| f.deleted) {
            "deleted"
        } else {
            "modified"
        };
        let binary = entry.binary || patch.is_some_and(|f| f.binary);
        let new_lines = if line_targets[i].is_some() {
            let n = counted.get(counted_at).copied().unwrap_or(0);
            counted_at += 1;
            n
        } else {
            0
        };
        files.push(FileDiff {
            path: entry.path.clone(),
            old_path: entry.old_path.clone(),
            status,
            insertions: entry.insertions,
            deletions: entry.deletions,
            binary,
            new_lines,
            hunks: patch.map(|f| f.hunks.clone()).unwrap_or_default(),
        });
    }

    let untracked = untracked_paths(root);
    for name in untracked {
        if only.is_some_and(|wanted| wanted != name) {
            continue;
        }
        let Some(lines) = text_lines(&root.join(&name)) else {
            files.push(FileDiff {
                path: name,
                status: "untracked",
                binary: true,
                ..FileDiff::default()
            });
            continue;
        };
        let count = lines.len();
        let hunk = Hunk {
            old_start: 0,
            new_start: 1,
            lines: lines
                .into_iter()
                .enumerate()
                .map(|(i, text)| DiffLine {
                    kind: "add",
                    old: None,
                    new: Some(i + 1),
                    text,
                })
                .collect(),
        };
        files.push(FileDiff {
            path: name,
            old_path: None,
            status: "untracked",
            insertions: count,
            deletions: 0,
            binary: false,
            new_lines: count,
            hunks: if count == 0 { Vec::new() } else { vec![hunk] },
        });
    }

    // git lists its own output by path; putting the untracked files back in the
    // same order keeps the panel from reshuffling as files are added.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn totals(files: &[FileDiff]) -> DiffStats {
    DiffStats {
        files: files.len(),
        insertions: files.iter().map(|f| f.insertions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
    }
}

/// Just the counts, for the status-bar chip. Polled, so it never reads a patch.
pub fn diff_stats(path: &str) -> Result<DiffStats, String> {
    let root = repo_root(path)?;
    let base = diff_base(&root);

    // Tracked numstat and the untracked listing are independent git walks.
    let (entries, untracked) = thread::scope(|scope| {
        let tracked = scope.spawn(|| numstat(&root, &["diff", "--numstat", "-z", base]));
        let others = scope.spawn(|| untracked_paths(&root));
        match (tracked.join(), others.join()) {
            (Ok(entries), Ok(untracked)) => (entries, Ok(untracked)),
            (Err(_), _) | (_, Err(_)) => (
                Err("diff worker panicked".to_string()),
                Err("diff worker panicked".to_string()),
            ),
        }
    });
    let entries = entries?;
    let untracked = untracked?;

    let mut stats = DiffStats {
        files: entries.len(),
        insertions: entries.iter().map(|e| e.insertions).sum(),
        deletions: entries.iter().map(|e| e.deletions).sum(),
    };
    // Untracked files are entirely new, so every line in them is an addition.
    stats.files += untracked.len();
    for lines in count_lines_many(&root, &untracked) {
        stats.insertions += lines;
    }
    Ok(stats)
}

/// The whole working-tree diff, with the three lines of context a patch shows.
pub fn diff(path: &str) -> Result<Diff, String> {
    let root = repo_root(path)?;
    let files = collect(&root, None, 3)?;
    Ok(Diff {
        root: root.to_string_lossy().to_string(),
        stats: totals(&files),
        files,
    })
}

/// One file with every unmodified line included — what expanding a collapsed
/// run in the viewer asks for. git has no "all context" flag, so this asks for
/// more lines than any source file has.
pub fn file_diff(path: &str, file: &str) -> Result<FileDiff, String> {
    let root = repo_root(path)?;
    collect(&root, Some(file), 1_000_000)?
        .into_iter()
        .find(|f| f.path == file)
        .ok_or_else(|| format!("`{file}` has no uncommitted changes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repo, cut off from the developer's own git config so the
    /// test sees the same defaults everywhere it runs.
    struct TempRepo {
        dir: PathBuf,
    }

    impl TempRepo {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("duckweed-git-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            let repo = Self { dir };
            repo.git(&["init"]);
            repo
        }

        fn git(&self, args: &[&str]) {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                // Line endings must not be rewritten under the test, and no
                // signing key exists here.
                .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
                .args(args)
                .env("GIT_CONFIG_GLOBAL", self.dir.join("no-global"))
                .env("GIT_CONFIG_SYSTEM", self.dir.join("no-system"))
                .env("GIT_AUTHOR_NAME", "duckweed")
                .env("GIT_AUTHOR_EMAIL", "duckweed@example.com")
                .env("GIT_COMMITTER_NAME", "duckweed")
                .env("GIT_COMMITTER_EMAIL", "duckweed@example.com")
                .output()
                .expect("git should be on PATH");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn write(&self, name: &str, body: &str) {
            std::fs::write(self.dir.join(name), body).expect("write");
        }

        fn path(&self) -> &str {
            self.dir.to_str().unwrap()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            // Git marks objects read-only, so this can lose on Windows. A
            // leftover temp folder is not worth failing a green test over.
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn numbered(count: usize) -> String {
        (1..=count).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn diff_reports_every_kind_of_change_in_a_real_repo() {
        let repo = TempRepo::new("kinds");
        repo.write("edited.txt", &numbered(20));
        repo.write("removed.txt", "gone\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-m", "first"]);

        repo.write(
            "edited.txt",
            &numbered(20).replace("line 10\n", "LINE TEN\n"),
        );
        repo.git(&["rm", "-q", "removed.txt"]);
        repo.write("added.txt", "hello\nworld\n");

        let diff = diff(repo.path()).expect("diff");
        let names: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, ["added.txt", "edited.txt", "removed.txt"]);

        // One line swapped, one file gone, two lines of a brand new file.
        assert_eq!(diff.stats.files, 3);
        assert_eq!((diff.stats.insertions, diff.stats.deletions), (3, 2));

        let added = &diff.files[0];
        assert_eq!(added.status, "untracked");
        assert_eq!(
            (added.insertions, added.deletions, added.new_lines),
            (2, 0, 2)
        );
        let lines = &added.hunks[0].lines;
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.kind == "add"));
        assert_eq!(lines[1].text, "world");

        let edited = &diff.files[1];
        assert_eq!(edited.status, "modified");
        assert_eq!(
            (edited.insertions, edited.deletions, edited.new_lines),
            (1, 1, 20)
        );
        // Three lines of context each side of the one that changed.
        assert_eq!(edited.hunks.len(), 1);
        assert_eq!(edited.hunks[0].new_start, 7);
        assert_eq!(edited.hunks[0].lines.len(), 8);

        let removed = &diff.files[2];
        assert_eq!(removed.status, "deleted");
        assert_eq!(
            (removed.insertions, removed.deletions, removed.new_lines),
            (0, 1, 0)
        );
    }

    #[test]
    fn file_diff_fills_the_unmodified_lines_back_in() {
        let repo = TempRepo::new("expand");
        repo.write("big.txt", &numbered(40));
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-m", "first"]);
        repo.write("big.txt", &numbered(40).replace("line 20\n", "CHANGED\n"));

        let file = file_diff(repo.path(), "big.txt").expect("file diff");
        assert_eq!(file.hunks.len(), 1);
        // The whole file, plus the line that was replaced.
        assert_eq!(file.hunks[0].lines.len(), 41);
        assert_eq!(file.hunks[0].new_start, 1);
        assert_eq!(file.new_lines, 40);
    }

    #[test]
    fn diff_sees_a_repo_with_no_commits_yet() {
        let repo = TempRepo::new("unborn");
        repo.write("staged.txt", "one\ntwo\n");
        repo.git(&["add", "-A"]);
        repo.write("loose.txt", "three\n");

        // There is no HEAD to compare against, so everything counts as new.
        let diff = diff(repo.path()).expect("diff");
        assert_eq!(diff.stats.files, 2);
        assert_eq!((diff.stats.insertions, diff.stats.deletions), (3, 0));
        assert_eq!(diff.files[1].status, "added");
    }

    #[test]
    fn diff_follows_a_rename() {
        let repo = TempRepo::new("rename");
        repo.write("before.txt", &numbered(12));
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-m", "first"]);
        repo.git(&["mv", "before.txt", "after.txt"]);

        let diff = diff(repo.path()).expect("diff");
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "after.txt");
        assert_eq!(diff.files[0].status, "renamed");
        assert_eq!(diff.files[0].old_path.as_deref(), Some("before.txt"));
    }

    #[test]
    fn diff_shows_a_binary_file_without_a_body() {
        let repo = TempRepo::new("binary");
        repo.git(&["commit", "--allow-empty", "-m", "first"]);
        std::fs::write(repo.dir.join("blob.bin"), [0u8, 1, 2, 0, 255]).expect("write");

        let diff = diff(repo.path()).expect("diff");
        assert_eq!(diff.files.len(), 1);
        assert!(diff.files[0].binary);
        assert!(diff.files[0].hunks.is_empty());
        // Nothing was counted, so the chip does not claim lines it cannot show.
        assert_eq!(diff.stats.insertions, 0);
    }

    #[test]
    fn numstat_reads_counts_paths_and_renames() {
        // A rename is three NUL-separated fields where a normal entry is one.
        let out = "12\t3\tsrc/a.rs\0-\t-\ticon.png\09\t0\t\0old/name.ts\0new/name.ts\0";
        let entries = parse_numstat(out);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!((entries[0].insertions, entries[0].deletions), (12, 3));
        assert!(entries[0].old_path.is_none());

        assert!(entries[1].binary, "`-` counts mean git saw a binary file");
        assert_eq!(entries[1].path, "icon.png");

        assert_eq!(entries[2].path, "new/name.ts");
        assert_eq!(entries[2].old_path.as_deref(), Some("old/name.ts"));
    }

    #[test]
    fn numstat_keeps_spaces_in_paths() {
        let entries = parse_numstat("1\t0\tdocs/release notes.md\0");
        assert_eq!(entries[0].path, "docs/release notes.md");
    }

    #[test]
    fn hunk_header_reads_both_starts() {
        assert_eq!(
            parse_hunk_header("@@ -12,7 +14,9 @@ fn main() {"),
            Some((12, 14))
        );
        // A one-line range has no comma, and a new file starts the old side at 0.
        assert_eq!(parse_hunk_header("@@ -0,0 +1 @@"), Some((0, 1)));
        assert_eq!(parse_hunk_header("@@ nonsense"), None);
    }

    #[test]
    fn patch_numbers_lines_from_the_hunk_header() {
        let patch = "\
diff --git a/a.rs b/a.rs
index 111..222 100644
--- a/a.rs
+++ b/a.rs
@@ -10,3 +10,4 @@ context heading
 kept
-gone
+first
+second
";
        let files = parse_patch(patch);
        assert_eq!(files.len(), 1);
        let lines = &files[0].hunks[0].lines;

        assert_eq!(lines.len(), 4);
        // Context advances both sides; a removal only the old, an addition only
        // the new — so the two columns drift apart exactly here.
        assert_eq!(
            (lines[0].kind, lines[0].old, lines[0].new),
            ("ctx", Some(10), Some(10))
        );
        assert_eq!(
            (lines[1].kind, lines[1].old, lines[1].new),
            ("del", Some(11), None)
        );
        assert_eq!(
            (lines[2].kind, lines[2].old, lines[2].new),
            ("add", None, Some(11))
        );
        assert_eq!(
            (lines[3].kind, lines[3].old, lines[3].new),
            ("add", None, Some(12))
        );
    }

    #[test]
    fn patch_splits_files_and_flags_their_status() {
        let patch = "\
diff --git a/new.rs b/new.rs
new file mode 100644
--- /dev/null
+++ b/new.rs
@@ -0,0 +1,1 @@
+hello
diff --git a/gone.rs b/gone.rs
deleted file mode 100644
--- a/gone.rs
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/logo.png b/logo.png
index 333..444 100644
Binary files a/logo.png and b/logo.png differ
";
        let files = parse_patch(patch);
        assert_eq!(files.len(), 3);
        assert!(files[0].new_file && !files[0].deleted);
        assert!(files[1].deleted);
        assert!(files[2].binary && files[2].hunks.is_empty());
    }

    #[test]
    fn patch_keeps_a_no_newline_marker_out_of_the_lines() {
        let patch = r"diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\ No newline at end of file
+new
";
        let lines = &parse_patch(patch)[0].hunks[0].lines;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].text, "new");
    }

    #[test]
    fn patch_line_text_drops_only_the_marker() {
        // A line that is itself a diff marker must survive intact.
        let patch = "\
diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,2 +1,2 @@
 - a list item
+++ still text
";
        let lines = &parse_patch(patch)[0].hunks[0].lines;
        assert_eq!(lines[0].text, "- a list item");
        assert_eq!(lines[1].text, "++ still text");
    }
}
