# Handoff: fix Custom Agent UI — slash commands, model/effort, loading UX

> **Audience:** another coding agent (or developer) picking this up cold.
> **Do not re-discover the architecture** — it is documented below with file paths and the exact gaps already found.
> **User language:** the product owner speaks Portuguese; keep code, comments, and commit messages in English (repo convention). UI copy can stay English unless asked otherwise.

---

## Goal

Make Duckweed’s **Custom Agent UI** (the overlay that intercepts `claude` / `codex` / `grok` / `opencode` / `cursor-agent` launches) feel like a real agent front-end for three user-reported failures:

1. **Slash commands don’t work.** Typing `/` in the agent composer should list that CLI’s commands (per agent). Completing/submitting a slash command must actually do what the real CLI does — not silently become a normal chat message that the model “reads”.
2. **`/model` and `/effort` (and launch flags) don’t work.** Changing model and reasoning effort is the main control surface of these CLIs. Launch-time flags and in-session slash commands must apply for each protocol.
3. **Loading UX is weak.** While the agent is starting (and optionally while a turn is spinning up with no content yet), the empty/starting state needs a more polished animation — not just the plain “Starting up…” text.

Also polish related UI if you touch it, but **do not expand into a full redesign**. Stay focused on the three problems.

---

## Product context

Duckweed is a Tauri + React terminal app (Vite, Bun for tests). Branch:

`feature/fantastic-ui-for-cli-agents`

Custom Agent UI (Settings → Appearance → **Custom Agent UI**, default **on**) intercepts bare interactive launches and drives the agent headlessly through a structured protocol, then renders a React surface over the terminal pane.

| Agent        | Protocol                         | Spawn args (headless)                                      |
|--------------|----------------------------------|------------------------------------------------------------|
| Claude Code  | `claude-stream-json`             | `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio` |
| Codex        | `codex-app-server` (JSON-RPC)    | `app-server`                                               |
| Grok Build   | ACP (JSON-RPC)                   | `grok agent stdio`                                         |
| OpenCode     | ACP                              | `opencode acp`                                             |
| Cursor       | ACP                              | `cursor-agent acp` (may not be installed)                  |

Reference inspiration (not a dependency): T3 Code’s provider runtime — same idea of protocol → normalized timeline. Do **not** scrape the real TUI; stay on the structured protocols.

---

## Architecture map (read these first)

```
src/lib/terminals.ts              # intercepts submit → parseAgentLaunch → agentSessions.start
src/lib/agents/launch.ts          # parse typed command → AgentLaunch { agent, args, prompt, model, resume }
src/lib/agents/catalog.ts         # AGENTS definitions: binaries, headlessArgs, passthrough, accent
src/lib/agents/session.ts         # session store, spawn via Tauri, queue, submit, interrupt
src/lib/agents/adapter.ts         # AgentAdapter interface + parse helpers
src/lib/agents/events.ts          # AgentEvent union + applyEvent → AgentSessionState
src/lib/agents/types.ts           # AgentSessionState, items, usage, commands[]
src/lib/agents/adapters/claude.ts
src/lib/agents/adapters/codex.ts
src/lib/agents/adapters/acp.ts    # shared by grok / opencode / cursor
src/lib/ipc.ts                    # agentProcStart / Send / Stop / Probe
src-tauri/src/agent_proc.rs       # Windows-aware PATH resolution (.cmd before bare shim)
src/components/agent/AgentSurface.tsx
src/components/agent/AgentComposer.tsx   # slash popup lives here
src/components/agent/AgentTimeline.tsx
src/components/agent/AgentPermission.tsx
src/components/agent/AgentDiff.tsx
src/styles.css                    # search for `.agent-` (block starts ~4648)
```

Flow:

1. User types `claude` / `codex` / … in a pane and presses Enter.
2. `terminals.ts` → `startAgentUi` → `parseAgentLaunch` → `agentSessions.start`.
3. Rust `agent_proc` spawns the binary with headless args; stdout lines go to the adapter.
4. Adapter emits `AgentEvent`s; `applyEvent` updates `AgentSessionState`.
5. `AgentSurface` / `AgentComposer` / `AgentTimeline` render that state.
6. Composer `onSubmit` → `agents.submit` → `adapter.prompt(text)`.

---

## Problem 1 — Slash commands

### What exists today

`AgentComposer.tsx`:

```ts
const query = value.startsWith("/") && !value.includes(" ") ? value.toLowerCase() : null;
const matches =
  query === null
    ? []
    : session.commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 8);
```

- Popup only appears when `session.commands` is non-empty.
- Tab / Enter completes the name into the textarea.
- **Submit always calls `agents.submit(text)`**, which always calls `adapter.prompt(text)` as a **normal user message**. There is no slash-command dispatch layer.

### How `session.commands` is filled (and why it fails)

| Adapter | Source of commands | Gap |
|---------|--------------------|-----|
| **Claude** | `system` + `subtype: "init"` → `slash_commands` string list | Init arrives **with the first turn**, not at spawn. `start()` immediately emits `status: idle` with `commands: []`. Typing `/` before any turn shows nothing. Descriptions are always `""`. |
| **ACP** | `initialize` result `_meta.availableCommands`, plus `sessionUpdate: available_commands_update` | Works only if the agent actually advertises them (Grok was reported to expose ~35 commands in live probing). If empty, UI has no fallback catalog. |
| **Codex** | — | **Never** emits `commands`. Slash popup is always empty. |

### What “working” means (acceptance)

- As soon as the session is `idle` (ready), typing `/` shows a useful list for that agent.
  - Prefer live advertised commands when available.
  - Provide a **static per-agent fallback catalog** of well-known slash commands when the protocol hasn’t sent any yet (or never will — Codex).
  - When live commands arrive, merge/replace carefully (live wins for overlapping names; keep descriptions from live when present).
- Typing `/mo` filters to `/model` etc.; ↑/↓ and Tab behave as today.
- Selecting/submitting a slash command **executes** it:
  - **Informational / local UI commands** (if any) can be handled in the app.
  - **Agent-native commands** must go through the right protocol channel for that agent, not as a free-form chat bubble unless that is how the protocol truly works.
- Cap display sensibly (current slice of 8 is fine for the popup; consider showing more or scrolling if the list is long — Grok advertises many).
- Empty query `/` should list all known commands (prefix match of `"/"` already does — the bug is empty data + no execution path).

### Investigation you must do (do not guess protocols)

Probe each installed CLI’s real slash-command surface:

```text
# Claude — how does stream-json accept slash commands?
# Does sending a user message "/model" work, or is there a control_request / special frame?
# When does system/init arrive with slash_commands?

# Codex app-server — is there a method for listing commands / setting model / effort?
# Or only thread/start + turn/start params?

# ACP — session/set_mode, available commands, model selection methods?
# Grok/OpenCode: what does availableCommands look like and how is a command invoked?
# (Some ACP agents expect `session/prompt` with the slash text; others have dedicated RPCs.)
```

Verify against the **installed** binaries on the machine, not only docs. This codebase already learned that Codex’s schema disagrees with itself (`sandbox: "workspace-write"` on `thread/start` vs `sandboxPolicy: { type: "workspaceWrite" }` on `turn/start`). Trust live rejection messages.

### Suggested design (you may improve it)

1. Add `src/lib/agents/slashCatalog.ts` (or similar) with **static fallback** `{ name, description }[]` per `AgentId` for the important commands (`/model`, `/effort` or agent-specific equivalents, `/compact`, `/clear`, `/help`, … — research exact names per CLI).
2. In `session.ts` initial state (or composer), expose `commands = live.length ? live : fallback(agent)`.
3. On `session` events that carry commands, merge: live replaces fallback for those names.
4. Add an adapter hook or session-level dispatcher, e.g.:

   ```ts
   // conceptual — shape is up to you
   handleSlash?(command: string, args: string, ctx: AdapterContext): "handled" | "prompt"
   ```

   or a shared `dispatchSlash(session, rawText)` that adapters implement.

5. Composer: if the committed text matches `/cmd …`, route through the dispatcher; only fall through to normal `prompt` when the agent treats slash text as a normal message **and** that is verified.

---

## Problem 2 — Model and effort

### What exists today

`AgentLaunch` (`launch.ts`):

```ts
export interface AgentLaunch {
  agent: AgentId;
  args: string[];
  prompt: string | null;
  model: string | null;   // only -m / --model
  resume: boolean;        // --continue / bare --resume / -c (non-codex)
}
```

- `--effort` and `--reasoning-effort` are in `VALUE_FLAGS` so they **consume the next word** (not mistaken for a prompt), but the **value is discarded**. There is no `effort` field.
- Claude adapter `args()`: passes `--model` and `--continue` only — **no effort**.
- Codex adapter: passes `model` on `thread/start` and `turn/start` only — **no effort / reasoning effort**.
- ACP adapter `args()`: **always `[]`**. Comment says model is protocol-level, but **no `session/set…` / model RPC is ever sent** for `launch.model`. Launch-time `-m` is effectively ignored for Grok/OpenCode/Cursor.
- Header shows `session.model` when set (`AgentSurface`); no UI to change model/effort mid-session.
- Submitting `/model …` or `/effort …` is just another user turn (and commands list is often empty anyway).

### Acceptance

| Path | Required behavior |
|------|-------------------|
| Launch `claude --model opus` / `claude -m sonnet` | Process starts on that model; header reflects it when known. |
| Launch with effort flags appropriate to each CLI (e.g. Claude/Codex/Grok equivalents — **confirm real flag names**) | Effort is applied for that session. |
| In-session `/model` (and agent-specific aliases) | Changes model for subsequent turns; updates header; feedback if invalid. |
| In-session `/effort` (or Claude’s `/model` effort, Codex reasoning, Grok effort — **per agent**) | Changes effort for subsequent turns; visible confirmation. |
| Persistence within the session | After change, further `prompt`s use the new model/effort without retyping the flag. |

### Implementation notes

1. Extend `AgentLaunch` with `effort: string | null` (or a structured enum once you know legal values). Parse `--effort`, `--reasoning-effort`, and any Codex `-c model_reasoning_effort=…` style if you support it without treating it as passthrough incorrectly.
2. Session state: keep `model` (already) and add `effort` (or store on adapter instance). Update via `session` events when the agent confirms a change.
3. Per adapter:
   - **Claude:** CLI flags at spawn; research stream-json for mid-session model/effort (control request vs slash as user message vs restart). Prefer the approach the real CLI uses in print/stream-json mode.
   - **Codex:** params on `thread/start` / `turn/start` (and any dedicated methods you find). Remember the **kebab vs camel** trap already fixed for sandbox — apply the same discipline for any new enums.
   - **ACP:** after `session/new`, call whatever model/effort methods the agent implements; also honor `launch.model` / `launch.effort` at start. Do not leave `args()` as a permanent dead end for model if the binary only accepts CLI flags for some agents.
4. Tests: extend `launch.test.ts`, each adapter’s `*.test.ts`, and any session-level slash tests. Pin **exact** param shapes with comments when the wire format is surprising (see existing Codex sandbox comments).

### Known Codex casing landmine (already fixed — do not regress)

```
thread/start  → sandbox: "workspace-write"              (kebab)
turn/start    → sandboxPolicy: { type: "workspaceWrite" } (camel)
approvalPolicy: "on-request"                            (kebab)
```

Tests in `codex.test.ts` document the rejection strings. Keep them.

---

## Problem 3 — Loading / starting animation

### What exists today

`AgentSurface.tsx` when `!session.started && status !== "error"`:

- Status `starting` → text **“Starting up…”**
- Status `idle` empty → static mark + label + cwd
- Working indicator: small `.agent-pulse` dot in the header only

CSS: `.agent-empty`, `.agent-pulse` / `@keyframes agent-pulse` in `styles.css`.

### Acceptance

- While `status === "starting"` (handshake / process spin-up), show a **distinct, polished loading state**: motion + agent accent (`--agent-accent` is already set on `.agent-surface`).
- Optional: subtle waiting state when `working` but no assistant/thinking/tool items yet (first token latency).
- Respect reduced-motion (`prefers-reduced-motion: reduce`) — static or minimal fallback.
- Match Duckweed’s existing dark terminal aesthetic (see other animations: duck welcome, usage-spin, agent-caret). Don’t introduce a foreign design system.
- Keep it lightweight (CSS animation preferred; no heavy image assets unless already in the project).

Ideas (pick one coherent design, don’t implement all):

- Animated agent mark (soft glow / breathe) + staggered “Connecting…” / “Starting {label}…”
- Thin indeterminate progress bar under the header using `--agent-accent`
- Three-dot or shimmer skeleton in the empty area

---

## Related bugs / quality bars (fix if you touch the area)

- **Commands only after first Claude turn:** even a perfect fallback catalog should be replaced/enhanced when `system/init` finally arrives.
- **Silent failures are banned:** spawn failures already print  
  `Custom Agent UI could not start (<reason>); running <bin> instead.`  
  Keep that for protocol/slash failures where the user would otherwise think nothing happened (e.g. unknown `/model` value → notice in the timeline).
- **Narrow interception:** only bare interactive launches. `codex exec`, `claude -p`, pipes, redirects stay on the real shell (`launch.ts` + `catalog.passthrough`). Do not widen interception.
- **Windows PATH:** `agent_proc.rs` prefers `.cmd`/`.exe` over bare POSIX shims. Don’t break that.
- **TypeScript:** no `any` unless unavoidable (project preference).
- **Tests:** `bun test` for JS; Rust tests under `src-tauri` if you touch agent_proc. User preference: prefer `bun run typecheck` / `bun test` over starting dev servers (assume app may already be running).
- **Do not run** `bun run dev` / full app builds unless the user asks.

---

## Suggested implementation order

1. **Research** live protocols for slash invoke + model/effort (Claude stream-json, Codex app-server, one ACP agent).
2. **Launch parsing:** `effort` on `AgentLaunch` + tests.
3. **Adapters:** apply model/effort at start; mid-session change APIs; slash handling where protocol-native.
4. **Composer + session:** fallback command catalogs; dispatch path for `/…` submits; show list on bare `/`.
5. **Loading animation** CSS + empty-state markup.
6. **Verify:** unit tests green; manually type `claude`, then `/`, `/model`, `/effort` (or agent equivalents); same for `codex` and `grok` if installed.

---

## Files you will almost certainly edit

| File | Why |
|------|-----|
| `src/lib/agents/launch.ts` + `launch.test.ts` | Parse effort; maybe more flags |
| `src/lib/agents/types.ts` | Session fields (`effort`, richer commands) |
| `src/lib/agents/events.ts` | Events for effort / command updates |
| `src/lib/agents/session.ts` | Dispatch, initial commands, state |
| `src/lib/agents/adapters/claude.ts` + test | Model/effort/slash |
| `src/lib/agents/adapters/codex.ts` + test | Model/effort/commands |
| `src/lib/agents/adapters/acp.ts` + test | Model/effort/commands invoke |
| `src/lib/agents/slashCatalog.ts` (new) | Static fallbacks |
| `src/components/agent/AgentComposer.tsx` | Slash UX / dispatch |
| `src/components/agent/AgentSurface.tsx` | Loading state, show effort? |
| `src/styles.css` | Loading animation |

Rust only if spawn args need changes beyond what adapters already pass via `headlessArgs` + `adapter.args()`.

---

## How to verify manually

1. Ensure Custom Agent UI is on (Settings → Appearance).
2. In a pane: `claude` → wait until header says **ready**.
3. Type `/` → full/filtered command list appears.
4. Use `/model` (and effort command) → header/model state updates; next message uses new settings.
5. Repeat with `codex` and `grok` (and `opencode` if present).
6. Kill and relaunch with `claude --model <id>` and effort flags → session starts already configured.
7. Confirm `claude -p "hi"` and `codex exec …` still hit the real CLI (passthrough).

---

## What was already verified (do not re-litigate)

From prior work on this branch (see conversation dump `c.txt` if needed):

- Protocol adapters work end-to-end for Claude (full turn + cost), Codex (handshake + turn; usage limit is account-side), Grok ACP (session + commands advertised).
- UI screenshot confirmed thinking, prose, tokens for Claude + Grok.
- Windows npm shim bug fixed (`.cmd` before bare name).
- Silent fallback fixed (reason printed).
- Codex dual sandbox casing fixed and tested.
- Large JS + Rust test suites exist; **UI was the weak verification surface** — user eyes found slash/model/effort and loading gaps.

---

## Out of scope (unless user expands)

- Cursor-specific spawn quirks beyond shared ACP (binary may be missing).
- Full Warp-like redesign of the agent chrome.
- Replacing the terminal for non-agent commands.
- Scraping interactive TUIs instead of structured protocols.

---

## Definition of done

- [ ] `/` shows per-agent commands when session is ready (fallback + live merge).
- [ ] Submitting slash commands has correct protocol behavior for model, effort, and other important agent commands you wire up.
- [ ] Launch flags for model and effort apply; in-session changes stick for later turns.
- [ ] Starting state has a clearly better animation; reduced-motion safe.
- [ ] `bun test` and `bun run typecheck` pass for touched code.
- [ ] No regression on passthrough launches or Windows spawn resolution.
- [ ] Short note in the PR/commit body: what each agent supports for slash/model/effort after your research.

---

## One-line mission for the implementer

**Make the Custom Agent UI’s composer command palette real (data + execution), wire model/effort for launch and mid-session per protocol, and replace the bare “Starting up…” state with a polished loading animation — without breaking headless protocol correctness or shell passthrough.**
