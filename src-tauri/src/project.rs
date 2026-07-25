//! Lightweight metadata about the folder the user opened as a "project".

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    /// Current git branch, if the folder (or an ancestor) is a git repo.
    pub branch: Option<String>,
    pub is_git: bool,
}

/// Read `.git/HEAD` directly instead of shelling out to git — it is instant and
/// works even when git is not installed.
fn git_branch(start: &Path) -> (bool, Option<String>) {
    let mut dir = Some(start);
    while let Some(current) = dir {
        let git = current.join(".git");
        let head = if git.is_dir() {
            Some(git.join("HEAD"))
        } else if git.is_file() {
            // Worktree / submodule: `.git` is a file pointing at the real dir.
            std::fs::read_to_string(&git)
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find_map(|l| l.strip_prefix("gitdir:").map(|p| p.trim().to_string()))
                })
                .map(|p| {
                    let p = PathBuf::from(p);
                    if p.is_absolute() {
                        p.join("HEAD")
                    } else {
                        current.join(p).join("HEAD")
                    }
                })
        } else {
            None
        };

        if let Some(head) = head {
            let contents = std::fs::read_to_string(&head).unwrap_or_default();
            let branch = contents
                .trim()
                .strip_prefix("ref: refs/heads/")
                .map(|b| b.to_string())
                .or_else(|| {
                    let t = contents.trim();
                    // Detached HEAD: show the short sha.
                    if t.len() >= 7 && t.chars().all(|c| c.is_ascii_hexdigit()) {
                        Some(format!("detached@{}", &t[..7]))
                    } else {
                        None
                    }
                });
            return (true, branch);
        }

        dir = current.parent();
    }
    (false, None)
}

pub fn info(path: &str) -> Result<ProjectInfo, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("`{path}` is not a directory"));
    }
    let canonical = dunce_canonicalize(p);
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical.to_string_lossy().to_string());
    let (is_git, branch) = git_branch(&canonical);

    Ok(ProjectInfo {
        path: canonical.to_string_lossy().to_string(),
        name,
        branch,
        is_git,
    })
}

/// `std::fs::canonicalize` yields `\\?\C:\...` on Windows, which looks bad in
/// the UI and confuses some shells. Strip the verbatim prefix.
fn dunce_canonicalize(p: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = canonical.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.len() > 2 && rest.as_bytes()[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    canonical
}
