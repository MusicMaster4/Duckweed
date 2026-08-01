# Duckweed quick start

This is the shortest path from download to a useful multi-pane workspace.

## Before you open Duckweed

You need:

- a project folder on your computer;
- a shell you already use; and
- any coding-agent CLI you want to run.

Duckweed provides the terminal workspace. It does not provide agent accounts,
subscriptions, or API credentials. Install and authenticate those tools using
their own instructions, then make sure each command works in a normal terminal
before launching it inside Duckweed.

## Install

Download the [latest stable release](https://github.com/MusicMaster4/Duckweed/releases/latest).

| Platform | What to download | First-launch note |
| --- | --- | --- |
| Windows x64 | `.exe` installer | The installer is per-user and does not need administrator access. SmartScreen may warn because the installer is not code-signed yet. |
| macOS | Universal `.dmg` | Move Duckweed to Applications. Gatekeeper may require right-clicking the app and choosing **Open** on the first launch. |
| Linux x64 | `.AppImage` or `.deb` | Run `chmod +x Duckweed_*.AppImage` before opening an AppImage. A `.deb` uses the system package installer. |

Stable is the recommended channel. The [beta release](https://github.com/MusicMaster4/Duckweed/releases?q=prerelease%3Atrue)
is for trying changes earlier and may be rougher.

## Make a first workspace

1. Open Duckweed and choose your project folder.
2. Leave the first pane as a normal shell.
3. Press `Ctrl+Shift+D` to split right, or `Ctrl+Shift+E` to split down.
4. Start your coding agent in the new pane.
5. Add another pane for tests, logs, or a second agent when the task needs it.
6. Press `Ctrl+Shift+G` to review the complete uncommitted Git diff.

You can drag panes, resize them, swap them, or zoom the focused pane. Open
`Ctrl+Shift+P` for projects, shells, panes, settings, and updates. Layouts and
settings are saved locally so the next session starts where you left off.

## Agent interface

Duckweed can show a native interface for supported local launches, including
Claude Code, Codex CLI, Cursor Agent, Grok CLI, and OpenCode. The original CLI
still runs on your computer and keeps its own authentication and provider
configuration.

If an agent opens as a normal terminal instead, first run its command outside
Duckweed. Then check that the custom agent interface is enabled in the command
palette. The [agent usage section](../README.md#agent-usage) lists the tools
Duckweed can scan locally even when it does not provide a custom interface.

## Next step

Read [troubleshooting](troubleshooting.md) if something is unclear, or open a
[bug report](https://github.com/MusicMaster4/Duckweed/issues/new?template=bug_report.yml)
with your platform, Duckweed version, shell, and reproduction steps.
