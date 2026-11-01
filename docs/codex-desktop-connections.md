# Codex desktop connections

Investigation date: 2026-10-28. Codex CLI 0.165.0, ChatGPT desktop 26.1023 on Windows.

## Root cause

The bundled browser and Computer Use tools run in the `node_repl` and `cua_repl` MCP servers. Before they touch Chrome, they ask the ChatGPT desktop app's local access host for permission. The host is a named pipe (`\\.\pipe\codex-app-tools-<uuid>`) that signs each `browser/access` answer with an Ed25519 key. The tools need three environment variables to reach it:

| Variable | Value |
|---|---|
| `BROWSER_USE_ACCESS_PIPE_PATH` | The host pipe. |
| `BROWSER_USE_ACCESS_VERIFYING_IDENTITY` | The host's public key, used to verify the signed answer. |
| `BROWSER_USE_ACCESS_EXECUTOR_ID` | `[desktop launch id, ChatGPT account id, ChatGPT user id]`. The host allows access when this matches the account signed in to the desktop app. |

The desktop app creates the pipe, key, and launch id at every launch. It passes them to its own app-server process and to each thread it opens. The `mcp_servers.node_repl` entry it writes to `config.toml` only forwards them from the app-server's environment (`env_vars`). The `unified-computer-use` plugin's `cua_repl` server does the same.

Duckweed's Codex conversations run in the CLI's shared app-server daemon. The daemon is not started by the desktop app, so it never has these variables. Every browser call therefore failed with `The browser access host is unavailable`, while the same tools worked in the desktop app. The settings toggles and the installed extension were correct. The variables were the only missing piece.

The `Computer Use native pipe is unavailable ... (os error 2)` error has a related cause. The Computer Use pipe name also changes at every desktop launch. A thread keeps the MCP servers it started with, so a thread loaded before a desktop restart points at a pipe that no longer exists.

## Fix

- `src-tauri/src/codex_desktop.rs` finds the running desktop app and reads the three values from its process environment. It takes the account and user ids from the Codex `auth.json` and reads the current `cua_repl` definition from the active `unified-computer-use` plugin version. It returns per-thread config overrides in the same shape the desktop app uses for its own daemon threads:
  - leaf overrides for `mcp_servers.node_repl.env.*`, only when `config.toml` defines `node_repl`;
  - a full `mcp_servers.cua_repl` server, unless the plugin is disabled. A thread-level server takes precedence over the plugin server with the same name.
- The Codex adapter sends these overrides on `thread/start`, `thread/resume`, and both `thread/fork` paths. If `thread/start` rejects them, the thread opens without them.
- A thread keeps the MCP environment it was loaded with. The adapter records which desktop launch each thread was bound to. It reconnects an idle conversation when the desktop app restarts, when a resumed thread was already loaded elsewhere, or after a tool reports a missing connection:
  - A saved thread is unsubscribed, allowed to unload (about 20 seconds), and resumed with the new settings. A prompt sent meanwhile waits.
  - An empty thread has no rollout to resume, so a new thread is opened with the settings.
  - There is one attempt per desktop launch, so a host that refuses access cannot cause a reconnect loop.
- The earlier workaround that disabled the bundled `chrome`, `browser`, and `unified-computer-use` plugins for Duckweed threads was removed.

Duckweed never signs, grants, or bypasses access. The desktop app's host makes every decision. It also does not rewrite `config.toml` or plugin files.

## Verification

- Control run: a private `codex app-server` (CLI 0.165.0) thread without overrides called `cua.getBrowser()`. It failed with `The browser access host is unavailable`, reproducing the reported error.
- With the overrides, a real model turn used `cua_repl` to select Chrome through the extension and list the open tabs with their URLs. It also listed the running desktop apps with Computer Use. No navigation, clicks, or typing were done.
- The spawned `node_repl` and `cua_repl` processes were inspected and carried the overridden variables.
- Thread lifecycle probes showed the following. A subscribed thread keeps its MCP processes across turns. `config/mcpServer/reload` does not change an existing process environment. An unsubscribed idle thread unloads after about 20 seconds and then resumes with new settings.

## Requirements and limits

- The ChatGPT desktop app must be running and signed in to the same ChatGPT account as Codex. Duckweed reads the account from `auth.json`, so keyring-only credential storage is not supported.
- Only Windows is implemented. Other platforms open threads without the overrides.
- If another client keeps a conversation loaded, it cannot unload, and the reconnect is reported instead.
- The Computer Use URL policy check (`could not determine the current browser URL`) is a separate safety stop. For web pages, use the Chrome plugin rather than Computer Use on the Chrome window.
