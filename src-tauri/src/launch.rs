//! Launch intents from Explorer context menus and other external openers.
//!
//! Windows shell verbs invoke Duckweed with a URI-shaped argument, matching
//! Warp's pattern:
//!
//! ```text
//! duckweed.exe "duckweed://action/new_tab?path=C:\project"
//! duckweed.exe "duckweed://action/new_window?path=C:\project"
//! ```
//!
//! Plain flags (`--new-tab`, `--new-window`) and a bare directory path are also
//! accepted so the same openers work from scripts and the command line.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// What the user asked the OS to do when launching Duckweed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchAction {
    /// Open the folder as a new tab in the running window (or cold-start one).
    NewTab,
    /// Open the folder in a fresh process/window.
    NewWindow,
}

/// A folder (or file whose parent is used) requested at launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchIntent {
    pub action: LaunchAction,
    pub path: String,
}

/// Holds the cold-start intent until the frontend is ready to consume it.
#[derive(Default)]
pub struct PendingLaunch(pub Mutex<Option<LaunchIntent>>);

/// True when argv asks for an independent process rather than a new tab.
pub fn wants_new_window(args: &[String]) -> bool {
    parse_args(args)
        .as_ref()
        .is_some_and(|intent| intent.action == LaunchAction::NewWindow)
        || args.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower == "--new-window"
                || lower.starts_with("duckweed://action/new_window")
                || lower.starts_with("duckweed:action/new_window")
        })
}

/// Parse launch arguments into an optional folder intent.
///
/// `args[0]` is typically the executable path and is ignored. Only the first
/// recognised intent is returned.
pub fn parse_args(args: &[String]) -> Option<LaunchIntent> {
    let mut action = LaunchAction::NewTab;
    let mut path: Option<String> = None;
    let mut i = 1;

    while i < args.len() {
        let arg = args[i].as_str();
        let lower = arg.to_ascii_lowercase();

        if lower == "--new-tab" || lower == "-t" {
            action = LaunchAction::NewTab;
            if let Some(next) = args.get(i + 1).filter(|value| !value.starts_with('-')) {
                path = Some(next.clone());
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if lower == "--new-window" || lower == "-n" {
            action = LaunchAction::NewWindow;
            if let Some(next) = args.get(i + 1).filter(|value| !value.starts_with('-')) {
                path = Some(next.clone());
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if lower == "--cwd" || lower == "--path" {
            if let Some(next) = args.get(i + 1) {
                path = Some(next.clone());
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if let Some(intent) = parse_uri(arg) {
            return Some(intent);
        }

        // Bare path: only accept real directories/files so unknown flags stay ignored.
        let candidate = PathBuf::from(arg);
        if candidate.is_absolute() || looks_like_path(arg) {
            if candidate.exists() {
                path = Some(arg.to_string());
            }
        }

        i += 1;
    }

    let raw = path?;
    let resolved = resolve_folder(&raw)?;
    Some(LaunchIntent {
        action,
        path: resolved,
    })
}

fn parse_uri(raw: &str) -> Option<LaunchIntent> {
    let lower = raw.to_ascii_lowercase();
    let rest = if let Some(stripped) = lower
        .strip_prefix("duckweed://")
        .or_else(|| lower.strip_prefix("duckweed:"))
    {
        // Keep the original casing for the path query; re-slice with the same length.
        let prefix_len = raw.len() - stripped.len();
        &raw[prefix_len..]
    } else {
        return None;
    };

    let (action_part, query) = rest.split_once('?').unwrap_or((rest, ""));
    let action_part = action_part.trim_matches('/').to_ascii_lowercase();
    let action = match action_part.as_str() {
        "action/new_tab" | "action/new-tab" | "new_tab" | "new-tab" => LaunchAction::NewTab,
        "action/new_window" | "action/new-window" | "new_window" | "new-window" => {
            LaunchAction::NewWindow
        }
        _ => return None,
    };

    let mut path: Option<String> = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key.eq_ignore_ascii_case("path") || key.eq_ignore_ascii_case("cwd") {
            path = Some(percent_decode(value));
            break;
        }
    }

    let raw_path = path.filter(|value| !value.is_empty())?;
    let resolved = resolve_folder(&raw_path)?;
    Some(LaunchIntent {
        action,
        path: resolved,
    })
}

fn looks_like_path(value: &str) -> bool {
    value.contains('\\')
        || value.contains('/')
        || (value.len() >= 2 && value.as_bytes()[1] == b':')
}

/// Prefer a directory. If a file is given, open its parent (Explorer can pass either).
fn resolve_folder(raw: &str) -> Option<String> {
    let path = PathBuf::from(raw.trim().trim_matches('"'));
    if path.as_os_str().is_empty() {
        return None;
    }
    let folder = if path.is_file() {
        path.parent().map(Path::to_path_buf).unwrap_or(path)
    } else {
        path
    };
    // Keep non-existing paths: the project may appear after a network mount,
    // and the frontend will surface a failed open cleanly.
    Some(normalize_path_string(&folder))
}

fn normalize_path_string(path: &Path) -> String {
    path.to_string_lossy().trim_end_matches(['/', '\\']).to_string()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = from_hex(bytes[i + 1]);
                let lo = from_hex(bytes[i + 2]);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h << 4) | l);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        std::iter::once("duckweed".to_string())
            .chain(parts.iter().map(|s| (*s).to_string()))
            .collect()
    }

    #[test]
    fn parses_warp_style_new_tab_uri() {
        let intent = parse_args(&args(&[r"duckweed://action/new_tab?path=H:\Python\Slop\duckweed"]))
            .expect("intent");
        assert_eq!(intent.action, LaunchAction::NewTab);
        assert_eq!(intent.path, r"H:\Python\Slop\duckweed");
    }

    #[test]
    fn parses_new_window_uri_case_insensitively() {
        let intent =
            parse_args(&args(&[r"Duckweed://Action/New_Window?PATH=C:\Users\test"])).expect("intent");
        assert_eq!(intent.action, LaunchAction::NewWindow);
        assert_eq!(intent.path, r"C:\Users\test");
    }

    #[test]
    fn parses_flag_forms() {
        let tab = parse_args(&args(&["--new-tab", r"C:\work"])).expect("tab");
        assert_eq!(tab.action, LaunchAction::NewTab);
        assert_eq!(tab.path, r"C:\work");

        let window = parse_args(&args(&["--new-window", r"C:\work"])).expect("window");
        assert_eq!(window.action, LaunchAction::NewWindow);
    }

    #[test]
    fn percent_decodes_spaces_in_uri_path() {
        let intent =
            parse_args(&args(&[r"duckweed://action/new_tab?path=C:\My%20Projects\app"])).expect("intent");
        assert_eq!(intent.path, r"C:\My Projects\app");
    }

    #[test]
    fn wants_new_window_detects_uri_and_flag() {
        assert!(wants_new_window(&args(&[
            r"duckweed://action/new_window?path=C:\a"
        ])));
        assert!(wants_new_window(&args(&["--new-window", r"C:\a"])));
        assert!(!wants_new_window(&args(&[
            r"duckweed://action/new_tab?path=C:\a"
        ])));
    }

    #[test]
    fn file_path_resolves_to_parent_when_present() {
        let dir = std::env::temp_dir().join("duckweed-launch-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("readme.txt");
        std::fs::write(&file, "hi").unwrap();
        let intent = parse_args(&args(&["--new-tab", file.to_str().expect("utf8 path")]))
            .expect("intent");
        let normalized = intent.path.replace('/', "\\");
        assert!(
            normalized.ends_with("duckweed-launch-test"),
            "expected parent folder, got {}",
            intent.path
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
