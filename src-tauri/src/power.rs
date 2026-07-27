//! Put the machine to sleep, or shut it down.
//!
//! Only the power watch reaches this: the user picks an action, arms the watch,
//! and it fires once every pane has been quiet for the whole countdown. Nothing
//! here runs on its own, and the action is parsed from a closed set rather than
//! taken as a command line, so the front end can never ask for anything else.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Suspend to RAM. Everything is still open when the machine wakes.
    Suspend,
    Shutdown,
}

impl Action {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "suspend" => Ok(Self::Suspend),
            "shutdown" => Ok(Self::Shutdown),
            other => Err(format!("unknown power action: {other}")),
        }
    }
}

/// Ask the OS to carry out `action`.
///
/// On Windows sleep this only returns once the machine wakes up again, so call
/// it from a blocking task rather than the IPC thread.
pub fn run(action: Action) -> Result<(), String> {
    perform(action)
}

#[cfg(windows)]
fn perform(action: Action) -> Result<(), String> {
    match action {
        Action::Suspend => {
            use windows_sys::Win32::System::Power::SetSuspendState;
            // hibernate = false, force = false, wake events stay enabled. A
            // machine with hibernation enabled may still hibernate; that is
            // Windows' own policy and not something an app overrides.
            let ok = unsafe { SetSuspendState(0, 0, 0) };
            if ok == 0 {
                return Err("Windows refused the sleep request".into());
            }
            Ok(())
        }
        // Shutting down through the API means acquiring SE_SHUTDOWN_NAME by
        // hand; `shutdown.exe` already does that, and it is the same call the
        // Start menu makes.
        Action::Shutdown => spawn_detached("shutdown", &["/s", "/t", "0"]),
    }
}

#[cfg(target_os = "macos")]
fn perform(action: Action) -> Result<(), String> {
    match action {
        Action::Suspend => spawn_detached("pmset", &["sleepnow"]),
        Action::Shutdown => spawn_detached(
            "osascript",
            &["-e", "tell application \"System Events\" to shut down"],
        ),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn perform(action: Action) -> Result<(), String> {
    match action {
        Action::Suspend => spawn_detached("systemctl", &["suspend"]),
        Action::Shutdown => spawn_detached("systemctl", &["poweroff"]),
    }
}

/// Start a helper and stop caring about it. The shell that answers is going to
/// take this process down with the rest of the session.
fn spawn_detached(program: &str, args: &[&str]) -> Result<(), String> {
    let mut command = std::process::Command::new(program);
    command.args(args);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, so there is no console flash on the way out.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not run {program}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_two_known_actions() {
        assert_eq!(Action::parse("suspend"), Ok(Action::Suspend));
        assert_eq!(Action::parse("shutdown"), Ok(Action::Shutdown));
        assert!(Action::parse("reboot").is_err());
        assert!(Action::parse("shutdown /s").is_err());
        assert!(Action::parse("").is_err());
    }
}
