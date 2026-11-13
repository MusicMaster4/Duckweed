# Local browser download timeout override

The installed browser runtime clamps `playwright_wait_for_download` and
`playwright_locator_download_media` to 120,000 ms, independently of the MCP tool
and JavaScript execution deadlines.

To prepare a local copy with a 60-minute download ceiling:

```powershell
node scripts/browser-download-timeout.mjs '<active unified-computer-use plugin>\.mcp.json' 60
```

Use `30` for 30 minutes. The script rejects unexpected source layouts instead of
patching an unknown runtime. It copies the browser package into
`~/.codex/runtime-overrides/browser-download-timeout`, changes only the two download
defaults and ceilings, and points the plugin's browser service to that local copy.
The original installed package is unchanged. Other service mappings and plugin
settings are preserved. The outer MCP tool deadline is raised to cover the download
plus two minutes of overhead.

Start a new Duckweed conversation or reload the MCP server after applying. An
already running server retains its previous environment. For a long download,
explicitly set the enclosing `cua_repl.js` call's `timeout_ms` to `3720000` and the
browser download's `timeoutMs` to `3600000`; the JavaScript call otherwise retains
its short default deadline. This patch does not guarantee a connection will stay
available for an hour or make interrupted downloads resumable.

The original plugin definition is saved beside it with suffix
`.before-download-timeout`. Restore that file over `.mcp.json` to revert, then reload
the server. Desktop startup or a plugin update may regenerate the definition;
reapply and validate against the new runtime when needed.

Validation:

```powershell
node --test scripts/browser-download-timeout.test.mjs
```

The current installation was also checked by importing the local service, verifying
both 3,600,000 ms clamps, and comparing all other plugin settings with the backup.
A real download lasting more than two minutes still needs verification in a new
server session.
