# CLIProxy account panel

The main interface is the full proxy manager at `http://127.0.0.1:8317/management.html`, with Quota Management, accounts and settings. The local monitor at `127.0.0.1:8318` opens that manager. The optional compact account page, built with Claude Opus 5.5 at medium effort, is available at `http://127.0.0.1:8318/accounts`.

Run `cliproxy dashboard` to open it. Its password is stored in `C:\Users\jubar\.cli-proxy-api\.management-key`. Credentials and keys stay outside this repository.

## Accounts and quotas

Choose **Add account**, select a provider, and sign in. Repeat with another account. The provider's sign-in page controls account selection. Adding an account preserves the existing credentials. API key connections also support multiple keys.

The backend checks for due refreshes every minute; Claude usage is fetched at most once every ten minutes to avoid throttling. The panel checks for updates every ten seconds and updates reset countdowns locally. Provider errors preserve the last successful result and mark it stale. Rate limiting delays retries with exponential backoff and respects `Retry-After`, starting at ten minutes for Claude and five minutes for other providers. The panel never estimates an unavailable quota or resets a provider's allowance.

The full manager automatically updates Claude, Codex, Antigravity and Grok quota readings every minute while its browser tab is visible. Updates preserve the current cards until fresh readings arrive, prevent overlapping requests and reject results from an old login session. Failed updates retain the last reading and back off. The native **Quota Management** page shares Claude's cache and retry deadline through the local dashboard. Cached readings display their timestamp and any pending retry. Glow and text shadows are disabled. `patch-management.cjs` backs up the installed management page before applying the bridge, validates the expected bundle before editing it, and reapplies the patch when the dashboard starts or the proxy replaces the page. If a future management UI changes its bundle, the patch leaves that version unchanged and logs a message.

Claude and Codex spend available five-hour balances first, then prefer the nearest weekly reset. Within each group, the nearest reset wins. Exhausted accounts rank last, and paused accounts are excluded. Enable or disable accounts in the full manager to control which ones participate. Session affinity retains the same account for an existing conversation, fails over when it becomes unavailable, and keeps that replacement even when a higher-priority account recovers. New conversations use the current priority order. Antigravity, Grok, Gemini CLI and Kimi have provider-specific quota readers; installed plugins can supply normalized quota data. Some providers do not expose quotas.

On this PC, `codex-client-headers.json` stores the installed Codex client's identity. The monitor applies these headers to new Codex accounts. This fixes the HTTP 403 responses caused by the proxy's default client headers. It clears a previous local 403 cooldown once after changing those headers; it does not reset the provider's actual quota.

Claude, two Codex accounts, Antigravity and Grok are signed in on this PC. OpenRouter and the existing Grok API connection are preserved. Gemini CLI and Kiro plugins are installed. The tested Google account was refused a Gemini Code Assist license. Copilot and Cursor installation attempts failed because their store releases did not contain the expected Windows assets. Other providers require their own account or API key.

## Duckweed and command line

Duckweed's Usage and statistics panels read `priority-status.json` when Claude is configured to use the local CLIProxy endpoint. Each enabled Claude account gets its own limits and cache timestamp. Deleted or paused credentials are excluded. Duckweed does not make an additional Anthropic request in this mode, including when the monitor is offline or cooling down. Custom endpoints without a local quota source show an unavailable explanation instead of the unrelated local OAuth account.

Without a proxy, Duckweed checks Claude's OAuth usage at most once every ten minutes. It persists the last successful observation and retry deadline under `~/.cache/duckweed`, with a credential fingerprint and a filesystem lock to coordinate app instances. HTTP errors retain the last reading, show its timestamp and retry deadline, and back off up to one hour while honoring longer `Retry-After` values. Restarting Duckweed or switching dashboard ranges does not bypass the deadline. Cached or failed observations do not generate a fresh burn-rate estimate, and a known reset does not invent a replenished balance.

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

Codex can use the original direct provider for one launch with `codex -c model_provider=openai`. This PC uses the compatibility-patched CLIProxyAPI build with `oauth.providers.codex.response-steering = true` and `supports_websockets = true`. Stock CLIProxyAPI 8.0.10 rejects newer Codex `response.interrupt` frames. The patch forwards those control frames unchanged through its full-duplex Codex WebSocket transport, including interrupts received after response completion. It preserves the response ID, discard mode and unknown fields, and does not enqueue a new response or change accounts. Cancellation remains provider-owned: the upstream can report `response.interrupt.failed` for hosted tools. The proxy preserves that non-terminal protocol event, allowing the response and subsequent messages to continue instead of generating a local HTTP 400.

Changing only `supports_websockets` in the user configuration does not update a model client retained by an already-loaded conversation. Rejoining a loaded thread can therefore keep using its earlier WebSocket capability. The proxy compatibility patch fixes this path for existing sessions as well as new ones. Installing it reconnects the proxy; the shared Codex service stays running. Historical error messages remain in the transcript.

`configure-codex-transport.cjs` remains a manual HTTP/SSE fallback and backs up the user configuration before changing only this provider. Pass `--websocket` only after installing the compatibility build. Normal dashboard deployment preserves the selected transport.

Its optional `--profile cliproxy` works for normal CLI sessions. Codex `app-server`, which Duckweed uses, reads the default proxy provider without a profile flag.

The proxy also accepts Anthropic Messages and Gemini-format API requests. The Gemini plugin does not implement the native Gemini CLI's Cloud Code inbound routes. Connecting models through this proxy does not automatically redirect the Antigravity IDE or every provider's native application.

Live Duckweed protocol checks passed for Claude, Codex and Grok, including tool use and streaming. Antigravity returned a chat completion and an Anthropic-format tool call with a small request. Google returned `429 RESOURCE_EXHAUSTED` for the larger Claude Code agent requests, so that account's full coding-agent test could not complete. Its published weekly quota does not guarantee availability for every request.

## Source and validation

`server.cjs` serves the optional compact UI and authenticated account operations. `quota.cjs` collects quota data and adjusts account priorities. `claude-cache.cjs` returns cached Claude quota data with an explicit timestamp and stale/error metadata. `index.html` is self-contained and has no external dependencies, shadows or glow. The full management page keeps its normal address and functionality. Hidden compact-page browser tabs pause polling.

```
node --test tools/cliproxy-dashboard/dashboard.test.cjs
node --test tools/cliproxy-dashboard/codex-transport.test.cjs
node --test tools/cliproxy-dashboard/quota-cache.test.cjs
python tools/cliproxy-dashboard/routing-integration.py
python tools/cliproxy-dashboard/codex-transport-integration.py
```

The integration test uses an isolated proxy fixture. It covers multiple accounts, preserving existing API keys, OAuth account addition, pausing accounts, quota normalization, secret exclusion and local access checks.

`routing-integration.py` runs the installed proxy against a local upstream using dummy keys. It verifies account affinity, quota failover and priority recovery without touching real accounts. Live Codex checks on this PC also passed: two simultaneous Responses streams, two app-server threads with the second finishing during the first thread's shell command, and steering the active first thread.

The deployed copy is in `C:\Users\jubar\.cli-proxy-api\dashboard`. After source changes, run `powershell -NoProfile -File tools/cliproxy-dashboard/deploy.ps1`. Deployment restarts only the panel server and keeps the proxy running. Pass `-RestartProxy` only when changing the proxy itself. Machine configuration backups are in `C:\Users\jubar\.cli-proxy-api\backups\20261002-065123`.

`codex-transport-integration.py` runs the installed Codex app-server and proxy with an isolated HTTP upstream and dummy keys. It verifies configuration reload for an existing conversation, streamed text, steering, interruption and continuation after stopping without using real provider accounts. Set `CODEX_BIN` or `CLIPROXY_BIN` to test a specific binary.

The compatibility build is reproducible from CLIProxyAPI commit `6fecc6e5567912661654a4eaf9b8f5436facd1c2`. With Go 1.26+ and that source checkout, run:

```powershell
./tools/cliproxy-dashboard/build-codex-interrupt-proxy.ps1 -SourcePath C:/path/to/CLIProxyAPI -OutputPath C:/path/to/patched/cli-proxy-api.exe
./tools/cliproxy-dashboard/install-codex-interrupt-proxy.ps1 -PatchedBinary C:/path/to/patched/cli-proxy-api.exe
```

The build applies `codex-response-interrupt.patch`, runs WebSocket interruption and steering regression tests, compiles the server, and records SHA-256 hashes. Installation verifies those hashes, backs up the existing binary and configuration, enables Codex full-duplex transport, restarts only the local proxy, and restores the previous files if startup fails. Python with PyYAML is required to preserve the configuration values while enabling the provider setting. Tests use dummy credentials and a local WebSocket upstream; they cover active and late interrupts, byte-for-byte frame preservation, continuation and connection cleanup without reconnecting or replaying the request.
