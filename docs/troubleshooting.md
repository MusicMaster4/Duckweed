# Troubleshooting Duckweed

Most first-run problems come from the operating system or from an agent CLI
that is not installed on the system `PATH` yet.

## The installer or app is blocked

Duckweed releases are not code-signed with a commercial certificate yet.

- **Windows:** SmartScreen can warn on the first installer run. Confirm that
  you downloaded the asset from the official
  [Duckweed release](https://github.com/MusicMaster4/Duckweed/releases/latest),
  then use the Windows option to continue if you trust that file.
- **macOS:** open the DMG, move Duckweed to Applications, then use **Open** from
  the context menu if Gatekeeper blocks the first launch.
- **Linux AppImage:** make the file executable with `chmod +x Duckweed_*.AppImage`.

The app's update channel still verifies update signatures. Do not run an
installer copied from an unofficial mirror when the same asset is available in
the official release.

## An agent opens as a normal shell

Duckweed does not install agent CLIs for you.

1. Open a regular terminal outside Duckweed.
2. Run the agent command there and complete its own sign-in or configuration.
3. Close and reopen Duckweed so it can discover the command on your `PATH`.
4. Check **Custom Agent UI** in the command palette.

The original terminal interface remains available even when a custom interface
is enabled.

## An agent needs sign-in

When a custom agent interface detects that its CLI is not signed in, Duckweed
returns that pane to the terminal and starts the CLI's native login flow. Finish
the browser or device-code steps there, then run the agent command again.

Use `/logout` in any supported custom agent interface to return to the terminal
and run that CLI's native logout command.

## A pane has no useful output

Check that the shell works outside Duckweed and that the project folder still
exists. Then open a new pane or restart Duckweed. Include the shell name,
operating system, Duckweed version, and the command you ran in a bug report.

Do not paste API keys, access tokens, or private repository contents into an
issue. Redact terminal output before sharing it.

## The Git diff is empty

Open the repository folder itself, not a parent folder that only contains the
repository. Confirm that `git status` shows the change in a normal terminal.
Duckweed reads the local working tree and does not upload it.

## Updates are not appearing

Stable and beta installs use separate update channels. A stable install only
looks at the latest stable release; a beta install follows the testing channel.
Install the other channel manually if you want to switch. You can also start a
manual check from the version chip or from **Check for updates** in the command
palette.

## Still stuck?

Open a [bug report](https://github.com/MusicMaster4/Duckweed/issues/new?template=bug_report.yml)
and include:

- Duckweed version and operating system;
- shell name and version;
- agent CLI and version, if relevant;
- exact reproduction steps; and
- the smallest redacted terminal output that shows the problem.
