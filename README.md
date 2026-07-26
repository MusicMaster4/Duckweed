<div align="center">

<img src="duckweed_icon.ico" alt="Duckweed icon" width="112" />

# Duckweed

### The terminal workspace for vibe coding

Organize real shells, projects, and AI coding agents in draggable panes and tabs —
without breaking your flow.

<p>
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/xterm.js-terminal-0f172a" alt="xterm.js" />
</p>

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#how-it-works">Architecture</a>
</p>

</div>

<br />

> A calm, capable terminal for the messy middle of building things.

## The idea

Vibe coding is faster when your terminal keeps up with your thoughts. Duckweed is a
focused, native desktop terminal built around the way modern development actually
happens: multiple repositories, several shells, quick experiments, and an AI coding
agent running alongside you.

It gives you the flexibility of a tiling workspace with the familiarity of a regular
terminal, while staying small, fast, and keyboard-friendly.

<table>
  <tr>
    <td width="33%" align="center"><strong>⚡ Stay in flow</strong><br /><sub>Keep your editor, shell, logs, and agent sessions one shortcut away.</sub></td>
    <td width="33%" align="center"><strong>🧭 See the whole project</strong><br /><sub>Project names, Git branches, tabs, and panes stay visible together.</sub></td>
    <td width="33%" align="center"><strong>🪶 Keep it light</strong><br /><sub>A native Tauri shell with a focused interface and no hosted workspace.</sub></td>
  </tr>
</table>

## Features

<table>
  <tr>
    <td width="50%"><strong>🗂 Project-aware sessions</strong><br /><sub>Open a folder and see its project name and Git branch in the title bar.</sub></td>
    <td width="50%"><strong>🖥 Real native shells</strong><br /><sub>PTY-backed sessions with ConPTY on Windows and <code>openpty</code> on Linux/macOS.</sub></td>
  </tr>
  <tr>
    <td><strong>▦ Flexible pane layouts</strong><br /><sub>Split, resize, swap, drag, and temporarily zoom any pane.</sub></td>
    <td><strong>⌘ Command palette</strong><br /><sub>Reach every action, shell, project, tab, and pane with <code>Ctrl+Shift+P</code>.</sub></td>
  </tr>
  <tr>
    <td><strong>⎇ Live diff review</strong><br /><sub>A chip counts your uncommitted files and lines; click it for the full diff.</sub></td>
    <td><strong>⌕ Searchable scrollback</strong><br /><sub>Find terminal output instantly with <code>Ctrl+Shift+F</code>.</sub></td>
  </tr>
  <tr>
    <td><strong>◎ Readable output</strong><br /><sub>Optional highlighting for paths, URLs, flags, hashes, diffs, and warnings.</sub></td>
    <td><strong>☷ Shell discovery</strong><br /><sub>Detect PowerShell, <code>cmd</code>, Git Bash, WSL, Nushell, Bash, Zsh, and Fish.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><strong>↺ Persistent layouts</strong><br /><sub>Restore your arrangement between launches without reviving old processes.</sub></td>
  </tr>
</table>

## Quick start

### Requirements

- [Bun](https://bun.sh/)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)

### Run locally

```bash
bun install
bun run app
```

### Build an installer

```bash
bun run app:build
```

On Windows, this produces an NSIS installer. The native shell used by each pane is
selected from the shells installed on your machine.

### Install and stay updated

Duckweed installs for the current user only, so neither the first install nor any
later update asks for administrator rights. Once it is installed, updates are one
click inside the app: the version chip in the status bar, or **Check for updates**
in the command palette.

There are two channels, and an install only ever sees its own:

| Install from | Channel | Sees |
| --- | --- | --- |
| the latest release | stable | stable releases only |
| a pre-release | beta | beta releases only |

Releases are built automatically — `main` publishes stable, `testing` publishes
beta. See [docs/releases.md](docs/releases.md) for the versioning rules, the
signing secrets, and how to test the pipeline.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Split right / down |
| `Ctrl+Shift+W` | Close the focused pane |
| `Ctrl+Shift+Z` | Zoom the focused pane |
| `Ctrl+Shift+B` | Equalize all panes |
| `Alt+Arrow keys` | Move focus between panes |
| `Ctrl+Shift+[` / `]` | Focus the previous / next pane |
| `Ctrl+Shift+T` / `Ctrl+Shift+Q` | New tab / close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+1` … `Ctrl+9` | Go to tab N |
| `Ctrl+Shift+O` | Open a project |
| `Ctrl+Shift+P` | Open the command palette |
| `Ctrl+Shift+G` | Review uncommitted changes |
| `Ctrl+Shift+F` | Search terminal output |
| `Ctrl+Shift+K` | Clear the focused pane |
| `Ctrl+Shift+H` | Toggle command and output highlighting |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Increase / decrease / reset font size |
| `F11` | Toggle fullscreen |

Right-click copies a selection. With no selection, it pastes from the clipboard.

## How it works

Duckweed combines a React + TypeScript interface with a Rust backend through Tauri 2.
Each pane owns a real PTY process, while the terminal instances live outside the React
render tree so dragging or rearranging a pane does not destroy its process or scrollback.

```text
src/
├── components/       UI: title bar, tabs, panes, search, palette, status bar, updates
├── hooks/             drag-and-drop behavior, update checks
└── lib/               layout, terminal registry, persistence, IPC, themes, highlighting,
                       version arithmetic shared with the release workflow

src-tauri/src/
├── main.rs            Tauri commands and IPC
├── pty.rs             One PTY session per pane
├── shells.rs          Installed-shell discovery
└── project.rs         Project name and Git branch detection
```

The PTY stream is transported as base64 and decoded incrementally, so split UTF-8
characters are preserved even during large bursts of output. Pane sizing uses explicit
flex bases and `minmax(0, 1fr)` to keep dense layouts inside the window.

## Development checks

```bash
bun run typecheck
bun test
cd src-tauri && cargo check
```

## Current scope

Duckweed is an active, experimental project. The core workspace experience — projects,
tabs, panes, native shells, search, and layout persistence — is implemented.

Warp-style command blocks group each command submitted from the editor with its output:
a thin separator between chunks, and a click selects the whole block. Raw-mode typing
(without the composer) still needs OSC 133 shell integration for the same treatment.

## Contributing

Issues, ideas, and pull requests are welcome. If you find a bug, include your operating
system, shell, reproduction steps, and any relevant terminal output.

## License

No license has been declared yet. Until one is added, all rights are reserved.
