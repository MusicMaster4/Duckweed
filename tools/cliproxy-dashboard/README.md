# CLIProxy account panel

The main interface is the full proxy manager at `http://127.0.0.1:8317/management.html`, with Quota Management, accounts and settings. The local monitor at `127.0.0.1:8318` opens that manager. The optional compact account page, built with Claude Opus 5.5 at medium effort, is available at `http://127.0.0.1:8318/accounts`.

Run `cliproxy dashboard` to open it. Its password is stored in `C:\Users\jubar\.cli-proxy-api\.management-key`. Credentials and keys stay outside this repository.

## Ledger and forecasts

The native Quota Management page follows the ledger and pool charts shown in [the November walkthrough](https://www.youtube.com/watch?v=yh5IAUow4Hc&t=1470s). It keeps the full manager, including provider setup, credentials, native reset grants, logs and settings. The ledger shows aligned quota columns, per-account refresh actions, collapsible provider groups, weighted pool totals and the next scheduled reset. The navigation opens as a compact rail. Provider headers have distinct accents and each account has its own bordered row. Search, provider filters, sort and the original card view remain available. Use the pencil beside an account to set a display name, or save a blank name to restore its original identity. Names persist in `~/.cli-proxy-api/account-names.json` through authenticated local endpoints and are used by native account labels and search without renaming credential files or changing history identifiers.

Numbers and bars use the same remaining-quota thresholds everywhere, including native cards and Auth Files: above 30% is green, above 10% through 30% is yellow, and 10% or less is red. Unknown limits are not assigned a remaining balance. Pool totals use the remaining percentage of their weighted capacity for color.

The local monitor writes fresh quota snapshots to `~/.cli-proxy-api/quota-history.json`, retaining up to 30 days without account names, emails, keys or raw provider responses. It collects while the browser is closed. Authenticated `/local/quota-history` reads that history for the native manager. CORS permits only the local manager origins. Cached observations do not generate duplicate history.

Each provider chart shows recorded balances, a dashed future reset schedule, the next reset gain, the most recent three-hour burn rate, first account depletion and pool depletion. Choose a 3, 7 or 14 day horizon, hover for timestamps and values, or hide forecasts. Burn is calculated per account from its own observation timestamps, so staggered refreshes and cached copies of other accounts do not block it. Forecasts need at least five minutes of fresh, comparable observations per account; gaps longer than thirty minutes and reset transitions do not count as burn. Stale or incomplete data do not produce consumption estimates. Future lines are estimates using recent aggregate burn and scheduled resets, with consumption assigned to the account whose reset is nearest. The historical trace starts when this feature is installed. There is no backfilled sample data. Waiting labels distinguish the first reading, the next reading, a replenishment and delayed quota updates. Claude uses its existing ten-minute quota cadence; while an estimate is unavailable, the footer shows the next expected reading when known. A reset or manual replenishment cannot be counted as consumption, so it may require a new post-reset observation.

**Pool weights** sets a display multiplier per account, for example 2.5 for a plan with 2.5 times the reference allowance. Defaults are 1. Weights are saved in this browser and applied to both charts and ledger totals. They do not change routing or provider allowances. **Hide account names** replaces identities in ledger rows, titles and weight controls; it hides the native timeline and search input and prevents switching to unmasked cards while enabled. It is scoped to this quota view, not other management pages.

Opening or reloading Quota Management automatically invokes the native **Refresh all credentials** action once. The periodic refresh uses the initialized native translator, rather than the language detector that occupied an older bundle alias. Claude's existing shared cache and retry deadlines still apply. Native manual resets remain explicit user actions and use the provider's eligibility checks and confirmation flow.

`patch-ledger.cjs` updates the recognized existing native ledger injection without replacing its React integration, and updates native meter thresholds. `patch-management.cjs` maintains the saved custom management bundle when an incompatible upstream download replaces it. Deployment backs up overwritten dashboard files. The saved native bundle contains this PC's previously installed native extensions; the enhancer deliberately does not guess bindings for an unrelated unpatched release.

Validation: `node --test tools/cliproxy-dashboard/ledger.test.cjs tools/cliproxy-dashboard/dashboard.test.cjs tools/cliproxy-dashboard/quota-cache.test.cjs`.

## Accounts and quotas

Choose **Add account**, select a provider, and sign in. Repeat with another account. The provider's sign-in page controls account selection. Adding an account preserves the existing credentials. API key connections also support multiple keys.

The backend checks for due refreshes every minute; Claude usage is fetched at most once every ten minutes to avoid throttling. The panel checks for updates every ten seconds and updates reset countdowns locally. Provider errors preserve the last successful result and mark it stale. Rate limiting delays retries with exponential backoff and respects `Retry-After`, starting at ten minutes for Claude and five minutes for other providers. The panel never estimates an unavailable quota or resets a provider's allowance. After a fresh Claude quota reading confirms recovery (including an upgrade), the monitor clears an obsolete local quota cooldown through the native routing API. It checks the current credential again before resetting, preserves authentication and other non-quota restrictions, and records the reconciliation in `priority-status.json`. An unchanged balance cannot repeatedly clear a new rate limit; cached or failed quota readings cannot release a cooldown. The normal ten-minute Claude polling interval still applies.

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

Codex can use the original direct provider for one launch with `codex -c model_provider=openai`. This PC uses the compatibility-patched CLIProxyAPI build with HTTP/SSE selected for the local Codex provider and its accounts. Large image histories exceeded the upstream WebSocket message limit: the affected conversation sent about 28 MB and received close code `1009` (`message too big`). Automatic compaction retried that same history and failed repeatedly.

The compatibility build fixes two transport problems. Response forwarding now drains the final error channel before treating a closed data channel as a generic disconnect, preserving close codes `1009` and `1012`. When all Codex accounts use HTTP, the proxy declines native Codex WebSocket upgrades with HTTP `426`, the client's supported HTTP fallback signal. This also covers already-loaded conversations that retain their earlier WebSocket capability, without restarting the shared Codex service. Merely preserving `1009` was insufficient to prevent retries in the installed client. Streaming, messages sent during a response, interruption and continuation were verified over HTTP with an image-heavy request of more than 42 MB.

`configure-codex-transport.cjs --sync-proxy` backs up and updates the local provider configuration, saves `codex-transport.json` in the proxy home and applies the same preference to Codex accounts through the management API. The quota monitor applies this preference to existing, paused and newly added Codex accounts independently of quota availability. Priority updates preserve transport settings; they no longer unconditionally re-enable WebSocket. Without a saved preference, existing account settings are preserved. Run `--websocket --sync-proxy` only when WebSocket mode is explicitly desired and the compatibility build is installed. That transport still has the provider's message-size limit.

The build also retains native `response.interrupt` support for WebSocket mode. Stock CLIProxyAPI 8.0.10 rejects newer Codex interruption frames. The interruption patch forwards these control frames unchanged, including interrupts received after response completion. It preserves response IDs, discard mode and unknown fields. Upstream cancellation failures such as `response.interrupt.failed` remain non-terminal protocol events. Historical errors remain in the transcript after installation.

Its optional `--profile cliproxy` works for normal CLI sessions. Codex `app-server`, which Duckweed uses, reads the default proxy provider without a profile flag.

The proxy also accepts Anthropic Messages and Gemini-format API requests. The Gemini plugin does not implement the native Gemini CLI's Cloud Code inbound routes. Connecting models through this proxy does not automatically redirect the Antigravity IDE or every provider's native application.

Live Duckweed protocol checks passed for Claude, Codex and Grok, including tool use and streaming. Antigravity returned a chat completion and an Anthropic-format tool call with a small request. Google returned `429 RESOURCE_EXHAUSTED` for the larger Claude Code agent requests, so that account's full coding-agent test could not complete. Its published weekly quota does not guarantee availability for every request.

## Source and validation

`server.cjs` serves the optional compact UI and authenticated account operations. `quota.cjs` collects quota data and adjusts account priorities. `claude-cache.cjs` returns cached Claude quota data with an explicit timestamp and stale/error metadata. `index.html` is self-contained and has no external dependencies, shadows or glow. The full management page keeps its normal address and functionality. Hidden compact-page browser tabs pause polling.

```
node --test tools/cliproxy-dashboard/dashboard.test.cjs
node --test tools/cliproxy-dashboard/codex-transport.test.cjs
node --test tools/cliproxy-dashboard/quota-cache.test.cjs
node --test tools/cliproxy-dashboard/cooldown-recovery.test.cjs tools/cliproxy-dashboard/quota-recovery.test.cjs
python tools/cliproxy-dashboard/routing-integration.py
python tools/cliproxy-dashboard/codex-transport-integration.py
python tools/cliproxy-dashboard/codex-transport-integration.py --large-history
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

The build applies `codex-response-interrupt.patch` and `codex-websocket-fallback.patch`, runs WebSocket interruption, steering and close-code regression tests, compiles the server, and records SHA-256 hashes. Installation requires native HTTP fallback and close-code preservation capabilities and verifies both patch hashes and the binary hash, backs up the existing binary and configuration, selects and persists HTTP/SSE for Codex, restarts only the local proxy, and restores the previous files if startup fails. Python with PyYAML is required to preserve the configuration values while enabling the provider setting. Tests use dummy credentials and a local WebSocket upstream; they cover active and late interrupts, byte-for-byte frame preservation, continuation and connection cleanup without reconnecting or replaying the request.

The large-history integration mode uses the installed Codex app-server, dummy credentials, an isolated proxy and valid local PNG fixtures. It keeps the client's WebSocket capability enabled to exercise HTTP fallback for cached provider settings, sends more than 42 MB of image history, and verifies subsequent replies, messages sent during a response, interruption and continuation. Close-code regression tests cover queued and delayed errors, both WebSocket execution modes, initial and continuation failures, mapped HTTP 413 errors and the HTTP replay signal. Native handshake tests verify HTTP 426 only when Codex accounts have selected HTTP; generic WebSocket clients and WebSocket-enabled Codex accounts retain their normal transport.
