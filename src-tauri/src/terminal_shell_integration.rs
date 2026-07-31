//! Runtime shell hooks used to delimit commands in a real interactive PTY.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const BASH_HOOK: &str = r#"
if [ -z "${__DUCKWEED_SHELL_INTEGRATION_LOADED:-}" ]; then
    __DUCKWEED_SHELL_INTEGRATION_LOADED=1
    export __DUCKWEED_SHELL_INTEGRATION_LOADED

    # Reproduce login-shell startup before installing Duckweed's hooks.
    if [ -r "$HOME/.bash_profile" ]; then
        . "$HOME/.bash_profile"
    elif [ -r "$HOME/.bash_login" ]; then
        . "$HOME/.bash_login"
    elif [ -r "$HOME/.profile" ]; then
        . "$HOME/.profile"
    elif [ -r "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi

    __duckweed_running=
    __duckweed_in_prompt=
    __duckweed_status=0
    # Preserve any DEBUG trap installed by the user's profile. Bash allows only
    # one handler per signal; overwriting it breaks tools that rely on preexec,
    # auditing, or their own prompt integration.
    __duckweed_prev_debug_trap=
    __duckweed_capture_prev_debug_trap() {
        local -a terms
        eval "terms=( $(trap -p DEBUG 2>/dev/null) )"
        local cmd="${terms[2]:-}"
        case "$cmd" in
            ''|*__duckweed_preexec*) ;;
            *) __duckweed_prev_debug_trap="$cmd" ;;
        esac
    }
    __duckweed_run_prev_debug_trap() {
        if [ -n "${__duckweed_prev_debug_trap:-}" ]; then
            eval "$__duckweed_prev_debug_trap"
        fi
    }
    __duckweed_install_debug_trap() {
        trap '__duckweed_preexec' DEBUG
    }

    __duckweed_preexec() {
        local status=$?
        if [[ "$BASH_COMMAND" == __duckweed_precmd* ]]; then
            __duckweed_status=$status
            __duckweed_run_prev_debug_trap
            return
        fi
        if [ -n "$__duckweed_in_prompt" ]; then
            __duckweed_in_prompt=
        fi
        if [ -n "$__duckweed_running" ]; then
            __duckweed_run_prev_debug_trap
            return
        fi
        # Drop DEBUG while reading history so that builtin does not re-enter.
        trap - DEBUG
        local line encoded
        line="$(HISTTIMEFORMAT= builtin history 1)"
        line="${line#*([[:space:]])+([0-9])+([[:space:]])}"
        line="${line#"${line%%[![:space:]]*}"}"
        [ -n "$line" ] || line="$BASH_COMMAND"
        encoded="$(printf '%s' "$line" | base64 | tr -d '\r\n')"
        printf '\033]133;C;cmd=%s\007' "$encoded"
        __duckweed_running=1
        __duckweed_install_debug_trap
        __duckweed_run_prev_debug_trap
    }

    __duckweed_precmd() {
        __duckweed_in_prompt=1
        if [ -n "$__duckweed_running" ]; then
            printf '\033]133;D;%s\007' "$__duckweed_status"
            __duckweed_running=
        fi
        printf '\033]133;A\007'
    }

    shopt -s extglob
    PS1="${PS1}\\[\033]133;B\007\\]"
    if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
        PROMPT_COMMAND=(__duckweed_precmd "${PROMPT_COMMAND[@]}")
    else
        PROMPT_COMMAND="__duckweed_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    fi
    __duckweed_capture_prev_debug_trap
    __duckweed_install_debug_trap
fi
"#;

const ZSH_ENV: &str = r#"
if [ -r "$DUCKWEED_ORIGINAL_ZDOTDIR/.zshenv" ]; then
    ZDOTDIR="$DUCKWEED_ORIGINAL_ZDOTDIR"
    source "$DUCKWEED_ORIGINAL_ZDOTDIR/.zshenv"
    ZDOTDIR="$DUCKWEED_ZDOTDIR"
fi
"#;

const ZSH_PROFILE: &str = r#"
if [ -r "$DUCKWEED_ORIGINAL_ZDOTDIR/.zprofile" ]; then
    ZDOTDIR="$DUCKWEED_ORIGINAL_ZDOTDIR"
    source "$DUCKWEED_ORIGINAL_ZDOTDIR/.zprofile"
    ZDOTDIR="$DUCKWEED_ZDOTDIR"
fi
"#;

const ZSH_LOGIN: &str = r#"
if [ -r "$DUCKWEED_ORIGINAL_ZDOTDIR/.zlogin" ]; then
    ZDOTDIR="$DUCKWEED_ORIGINAL_ZDOTDIR"
    source "$DUCKWEED_ORIGINAL_ZDOTDIR/.zlogin"
    ZDOTDIR="$DUCKWEED_ZDOTDIR"
fi
"#;

const ZSH_RC: &str = r#"
if [ -r "$DUCKWEED_ORIGINAL_ZDOTDIR/.zshrc" ]; then
    ZDOTDIR="$DUCKWEED_ORIGINAL_ZDOTDIR"
    source "$DUCKWEED_ORIGINAL_ZDOTDIR/.zshrc"
    ZDOTDIR="$DUCKWEED_ZDOTDIR"
fi

if [ -z "${__DUCKWEED_SHELL_INTEGRATION_LOADED:-}" ]; then
    typeset -g __DUCKWEED_SHELL_INTEGRATION_LOADED=1
    typeset -g __duckweed_running=

    __duckweed_preexec() {
        local encoded="$(printf '%s' "$1" | base64 | tr -d '\r\n')"
        printf '\033]133;C;cmd=%s\007' "$encoded"
        __duckweed_running=1
    }

    __duckweed_precmd() {
        local status=$?
        if [ -n "$__duckweed_running" ]; then
            printf '\033]133;D;%s\007' "$status"
            __duckweed_running=
        fi
        printf '\033]133;A\007'
    }

    autoload -Uz add-zsh-hook
    add-zsh-hook preexec __duckweed_preexec
    add-zsh-hook precmd __duckweed_precmd
    PROMPT="${PROMPT}%{$(printf '\033]133;B\007')%}"
fi
"#;

pub fn bash_hook(app: &AppHandle) -> Result<PathBuf, String> {
    write_cached(app, "shell-integration.bash", BASH_HOOK)
}

/// Create a private ZDOTDIR that forwards to the user's files, then adds hooks.
pub fn zsh_zdotdir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("zsh");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    for (name, contents) in [
        (".zshenv", ZSH_ENV),
        (".zprofile", ZSH_PROFILE),
        (".zshrc", ZSH_RC),
        (".zlogin", ZSH_LOGIN),
    ] {
        write_if_changed(&dir.join(name), contents)?;
    }
    Ok(dir)
}

fn write_cached(app: &AppHandle, name: &str, contents: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(name);
    write_if_changed(&path, contents)?;
    Ok(path)
}

fn write_if_changed(path: &std::path::Path, contents: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(contents) {
        std::fs::write(path, contents).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{BASH_HOOK, ZSH_RC};

    #[test]
    fn unix_hooks_emit_commands_prompts_status_and_preserve_user_startup() {
        for hook in [BASH_HOOK, ZSH_RC] {
            for marker in ["133;A", "133;B", "133;C;cmd=", "133;D;"] {
                assert!(hook.contains(marker), "missing {marker}");
            }
            assert!(hook.contains("base64"));
        }
        assert!(BASH_HOOK.contains(".bash_profile"));
        assert!(ZSH_RC.contains("DUCKWEED_ORIGINAL_ZDOTDIR/.zshrc"));
    }

    #[test]
    fn installed_bash_emits_a_complete_interactive_command_lifecycle() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        #[cfg(windows)]
        let program = [
            std::env::var("ProgramFiles").ok(),
            std::env::var("ProgramFiles(x86)").ok(),
        ]
        .into_iter()
        .flatten()
        .map(|base| std::path::Path::new(&base).join("Git/bin/bash.exe"))
        .find(|path| path.is_file());
        #[cfg(not(windows))]
        let program = crate::shells::find_in_path("bash");

        let Some(program) = program else {
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "duckweed-bash-osc133-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let hook = root.join("integration.bash");
        std::fs::write(&hook, BASH_HOOK).unwrap();
        let mut child = Command::new(program)
            .args(["--noprofile", "--rcfile"])
            .arg(&hook)
            .arg("-i")
            .env("HOME", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"printf 'duckweed-test'\nexit\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("\x1b]133;A\x07"), "stdout: {stdout:?}");
        // A pipe cannot render PS1, so B is covered by the static hook test.
        assert!(
            stdout.contains("\x1b]133;C;cmd=cHJpbnRmICdkdWNrd2VlZC10ZXN0Jw=="),
            "stdout: {stdout:?}"
        );
        assert!(stdout.contains("\x1b]133;D;0\x07"), "stdout: {stdout:?}");
        assert!(stdout.contains("duckweed-test"), "stdout: {stdout:?}");
    }

}
