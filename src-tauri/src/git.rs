//! Listing and switching branches for the folder a tab has open.
//!
//! Reading `HEAD` (see `project.rs`) is enough to *show* a branch, but listing
//! and checking out are real git operations — so these shell out, and report
//! git's own stderr when it refuses (dirty tree, unknown branch, no repo).

use std::path::Path;
use std::process::Command;

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
        &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")],
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
