# CLIProxy account panel

Local account dashboard for this PC, built with Claude Opus 5.5 at medium effort. The proxy API runs on `127.0.0.1:8317`; this panel runs on `127.0.0.1:8318`.

Run `cliproxy dashboard` to open it. Its password is stored in `C:\Users\jubar\.cli-proxy-api\.management-key`. Credentials and keys stay outside this repository.

## Accounts and quotas

Choose **Add account**, select a provider, and sign in. Repeat with another account. The provider's sign-in page controls account selection. Adding an account preserves the existing credentials. API key connections also support multiple keys.

The backend checks for due refreshes every minute; Claude usage is fetched at most once every ten minutes to avoid throttling. The panel checks for updates every ten seconds and updates reset countdowns locally. Provider errors preserve the last successful result and mark it stale. Rate limiting delays retries with exponential backoff and respects `Retry-After`, starting at ten minutes for Claude and five minutes for other providers. The panel never estimates an unavailable quota or resets a provider's allowance.

The native **Quota Management** page shares Claude's cache and retry deadline through the local dashboard. Cached readings display their timestamp and any pending retry. `patch-management.cjs` backs up the installed management page before applying the bridge, validates the expected bundle before editing it, and reapplies the patch when the dashboard starts or the proxy replaces the page. If a future management UI changes its bundle, the patch leaves that version unchanged and logs a message.

Claude and Codex prefer available accounts whose weekly quota resets soonest. Session affinity keeps existing conversations on their original account. Antigravity, Grok, Gemini CLI and Kimi have provider-specific quota readers; installed plugins can supply normalized quota data. Some providers do not expose quotas.

Claude, two Codex accounts, Antigravity and Grok are signed in on this PC. OpenRouter and the existing Grok API connection are preserved. Gemini CLI and Kiro plugins are installed. The tested Google account was refused a Gemini Code Assist license. Copilot and Cursor installation attempts failed because their store releases did not contain the expected Windows assets. Other providers require their own account or API key.

## Duckweed and command line

Use `claude` or `codex` in Duckweed. Both now read their local proxy configuration automatically. `claudex --g` selects the existing Grok route. Available model IDs are listed in the panel's **Models** disclosure. A Responses or OpenAI-compatible client can use `http://127.0.0.1:8317/v1` with the local key in `~/.cli-proxy-api/.api-key`.

```
cliproxy start
cliproxy status
cliproxy dashboard
cliproxy login codex
cliproxy login antigravity
cliproxy login grok
cliproxy login gemini-cli
cliproxy stop
```

The Windows startup entry launches the proxy and panel in the background. The panel server refreshes account quotas every minute, including when the browser panel is closed. `cliproxy stop` stops both local processes. The duplicate scheduled quota task is disabled. The credential command only reads the local key and does not launch services; run `cliproxy start` if the proxy was intentionally stopped.

Codex can use the original direct provider for one launch with `codex -c model_provider=openai`. Its optional `--profile cliproxy` works for normal CLI sessions. Codex `app-server`, which Duckweed uses, reads the default proxy provider without a profile flag.

The proxy also accepts Anthropic Messages and Gemini-format API requests. The Gemini plugin does not implement the native Gemini CLI's Cloud Code inbound routes. Connecting models through this proxy does not automatically redirect the Antigravity IDE or every provider's native application.

Live Duckweed protocol checks passed for Claude, Codex and Grok, including tool use and streaming. Antigravity returned a chat completion and an Anthropic-format tool call with a small request. Google returned `429 RESOURCE_EXHAUSTED` for the larger Claude Code agent requests, so that account's full coding-agent test could not complete. Its published weekly quota does not guarantee availability for every request.

## Source and validation

`server.cjs` serves the UI and authenticated account operations. `quota.cjs` collects quota data and adjusts account priorities. `claude-cache.cjs` returns cached Claude quota data with an explicit timestamp and stale/error metadata. `index.html` is self-contained and has no external dependencies, shadows or glow. Existing management bookmarks open the redesigned account panel. The original proxy management UI remains available through **Advanced settings**, using `management.html?advanced=1`. Hidden browser tabs pause polling.

```
node --test tools/cliproxy-dashboard/dashboard.test.cjs
```

The integration test uses an isolated proxy fixture. It covers multiple accounts, preserving existing API keys, OAuth account addition, pausing accounts, quota normalization, secret exclusion and local access checks.

The deployed copy is in `C:\Users\jubar\.cli-proxy-api\dashboard`. After source changes, run `powershell -NoProfile -File tools/cliproxy-dashboard/deploy.ps1`. Deployment restarts only the panel server and keeps the proxy running. Pass `-RestartProxy` only when changing the proxy itself. Machine configuration backups are in `C:\Users\jubar\.cli-proxy-api\backups\20261002-065123`.
