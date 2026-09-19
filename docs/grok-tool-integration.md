# Grok tools in the custom agent UI

Duckweed launches the installed Grok Build CLI with `grok agent stdio` and
translates its ACP events through `src/lib/agents/adapters/acp.ts`.

Keep `clientCapabilities.fs.readTextFile` and `writeTextFile` disabled for
Grok. When enabled, Grok delegates file operations to Duckweed's workspace
text editor service. That service rejects binary images, files beyond the
editor size limit, and paths outside the workspace. The latter includes
Grok's bundled skills and temporary image attachments. Observed failures
included `The file is not readable text.` and `Path outside workspace.`

With these capabilities disabled, Grok uses its native filesystem tools and
permission policy. Image results remain available to the model. Tool updates,
diffs, and permission requests still flow through the custom UI. Cursor and
OpenCode continue to use the existing workspace-scoped file service.

The [ACP filesystem contract](https://agentclientprotocol.com/protocol/v1/file-system)
defines these client methods as text services and requires agents to respect
the advertised capability flags. Do not encode image bytes into the text
response as a substitute for Grok's native image handling.

## Validation

- `bun test src/lib/agents/adapters/acp.test.ts` covers Grok capability
  negotiation and rejection of unadvertised callbacks, plus continued
  client text reads, writes, and path containment for the other ACP agents.
- `bun scripts/grok-tools-smoke.ts` is an opt-in live test using the signed-in
  Grok account. It uses the actual UI adapter with a file service installed,
  starts a separate Grok process, and creates fixtures in a temporary folder.
  It exercises listing, image reads, text reads, an external file, a 6 MB text
  file, search, nested file creation, editing, and terminal execution. It checks
  image content, result markers, the edited file, and absence of client file
  callbacks. It grants one-time tool permissions for this test and stops its
  process afterwards. Fixtures are retained at the printed path for inspection.
  `GROK_BIN` can override the Windows executable path.

The capability change takes effect when a Grok process starts under the rebuilt
Duckweed application. Existing processes negotiated their capabilities at launch.
