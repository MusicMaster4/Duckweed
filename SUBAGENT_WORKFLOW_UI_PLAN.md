# Subagent and Workflow UI Plan

A product and implementation plan for first-class subagent and workflow visibility across Duckweed custom agent interfaces. No code changes in this document. UI copy stays English per `AGENTS.md`.

---

## 1. Goal and product principles

### Goal

When a coding agent delegates work (Claude Task/Agent, Codex collab threads, OpenCode/Cursor/Grok `task` tools, provider plans), Duckweed should make that delegation as clear as the main conversation:

- See every live and recent subagent in one place.
- Know what each one is doing right now.
- Navigate from the fleet view into a focused inspector.
- See the parent workflow (plan phases) beside that fleet.
- Keep one mental model across Claude, Codex, Cursor, Grok, and OpenCode, with light brand chrome only.

### Success criteria

1. With three parallel subagents running, the user can name each task, its status, and the latest one-line activity without scrolling the full transcript.
2. Clicking a subagent opens an in-pane inspector (not a separate Duckweed pane by default) with prompt, live activity, and available output/transcript.
3. Workflow steps stay visible in a dock while a turn runs, and relate clearly to any subagents that belong to the current turn.
4. The same components and event model work for all five custom UIs; only skinning differs.
5. Adapters that only expose flat `task` tools still look good (L1). Richer protocols unlock L2/L3 without UI rewrites.

### Non-goals (for this plan)

- Spawning Duckweed-owned agents that are not the CLI's own children.
- Opening every subagent as a full workspace pane by default.
- Full Agent Teams multi-terminal orchestration UI (Claude experimental teams across processes).
- Glow, glass, or ornamental motion. Density and status clarity matter more.
- Blocking modal dialogs for routine inspection.

### Product principles

1. **One vocabulary.** Subagent, workflow, phase, status. Not five provider jargons in the chrome.
2. **Progressive disclosure.** Strip first, inspector on demand, nested tools only when the protocol gives them.
3. **Main timeline stays readable.** Fleet and dock absorb parallel noise; timeline keeps a compact card per delegation.
4. **Honest fidelity.** If the protocol does not stream nested tools, show progress and final output, never invent a fake inner transcript.
5. **Terminal-pane sized.** Everything must work in a narrow split pane.

---

## 2. Current state in Duckweed

### Data model (today)

Canonical types live in `src/lib/agents/types.ts`.

| Concept | Type | Notes |
| --- | --- | --- |
| Tool family for delegation | `ToolKind = "task"` | Mapped via `toolKind()` for `task`, `agent`, `spawn_agent`, `subagent`, `delegate`, etc. |
| Delegation as timeline row | `ToolItem` | `callId`, `name`, `title`, `status`, `output`, `changes`. No parent id, agent label, thread id, or nested items. |
| Workflow / plan | `PlanItem` + `AgentPlanStep` | Steps: `text` + `status: pending \| running \| done`. No phases, no link to subagents. |
| Session | `AgentSessionState` | Flat `items: AgentItem[]`. No `subagents[]` index. |
| Events | `AgentEvent` in `events.ts` | `tool` and `plan` only. No subagent-specific events. |

`src/lib/agentWorkflow.ts` already treats the newest `PlanItem` in the current user turn as the workflow dock source (`latestWorkflow`, `workflowIsComplete`, 30s TTL after completion).

### Adapter fidelity (today)

| Provider | What is emitted | What is lost |
| --- | --- | --- |
| **Claude** (`adapters/claude.ts`) | Task/Agent tools become normal `tool` events via `toolKind` → `task`. Title from `description`/`prompt`. TodoWrite → `plan`. | No use of `parent_tool_use_id` for nested messages. Child-agent frames are mostly collapsed into tool output / error dedupe. No structured subagent identity (`subagent_type`, agent name). |
| **Codex** (`adapters/codex.ts`) | `collabAgentToolCall` and `subAgentActivity` → `tool` with `tool: "task"`. Titles like "Spawned subagent: …". `agentsStates` and thread ids flattened into `output` text. | Structured multi-thread state is stringified, not first-class. No separate SubagentSession per receiver thread. No steer/close actions in UI. |
| **ACP** (Cursor / Grok / OpenCode via `adapters/acp.ts`) | Tool calls with name/kind that map to `task`. Plans when the agent sends them. | ACP does not define a rich multi-agent object graph. Parallel delegation is just more tool rows. |

Codex already has the richest wire signal in-repo (tests in `codex.test.ts` for `collabAgentToolCall`). Claude has the highest user expectation for live subagent visibility. ACP is L1-shaped.

### UI today

| Surface | Behavior |
| --- | --- |
| `OfficialShared.ToolActivity` | `tool === "task"` adds `is-subagent`, kicker "Subagent", status "Working", expands by default when not compact. |
| `OfficialShared.PlanTracker` | Shared workflow card: kicker "Workflow", progress bar, step list. Used inline in Claude/Grok/ChatGPT experiences. |
| `AgentSurface` | Workflow **dock** above the composer: latest plan for the turn, hides 30s after complete. |
| `CursorExperience` / `OpenCodeExperience` | Dedicated `CursorSubagent` / `OpenCodeSubagent` rows; HUD metric `N sub`; Cursor "Workflow" plan block + tracker. |
| `providerExperience.activitySummary` | Collects `subagents: ToolItem[]` for HUD counts only. |
| Preview | `AgentExperiencePreview` seeds a fake `task` tool and workflow dock. |

### What already works

- Consistent `task` family across adapters.
- Distinct subagent chrome in official and provider experiences.
- Workflow dock + completion TTL.
- Codex collab normalization into live task tools.

### Gaps vs the desired product

1. No fleet strip: subagents only appear as timeline rows (plus a count chip on Cursor).
2. No inspector: expand-in-place only; no navigate "into" a subagent.
3. No structured identity: label, role, thread id, parent call id, model, current activity line.
4. No nested transcript model when Claude/Codex could provide more than a flat `output` string.
5. Workflow steps do not reference or count child agents.
6. No keyboard navigation across subagents.
7. No post-turn "review fleet" presentation beyond scrolling history.
8. No protocol-gated steer/stop/close actions (Codex docs support some of this; Duckweed does not surface them).

### Constraints (`AGENTS.md`)

- All app UI English.
- No glow on UI elements.
- No em dashes in writing.
- Prefer simple solutions over parallel abstractions.

---

## 3. Reference systems

### Claude Code

- **Task / Agent tool:** parent spawns isolated workers; results return as tool results. Tool renamed Task → Agent in recent versions; adapters must accept both (Duckweed already maps both to `task`).
- **`parent_tool_use_id`:** complete assistant messages from inside a subagent carry the parent tool id. Critical for demuxing parallel workers. Token-level stream events for subagents are often **not** forwarded on the main stream; UIs must use complete messages and tool updates.
- **Named subagents:** `.claude/agents/` definitions (name, description, tools, model). UI should show the agent name/type when present.
- **Workflows:** multi-phase orchestration (including experimental Agent Teams with shared task lists). Duckweed should mirror the **progress tree / phase list** idea, not necessarily multi-process teams.
- **Mental model to steal:** parent orchestrator + workers; main chat stays clean; inspect workers without polluting the primary narrative.

References: [Claude Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents), [streaming output notes](https://code.claude.com/docs/en/agent-sdk/streaming-output).

### Codex / ChatGPT

- **Hierarchy:** main thread + subagent threads; collab tools: spawn, sendInput, resume, wait, close.
- **UX surfaces:** Active/Done lists, open thread to inspect, steer/stop/close, IDE background-agent panel.
- **Duckweed adapter already sees** `collabAgentToolCall`, `receiverThreadIds`, `agentsStates`, `subAgentActivity`.
- **Mental model to steal:** thread list + open detail; status lines per child; wait-all then synthesize.

References: [Codex subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents).

### Cursor / OpenCode / Grok (ACP)

- Delegation surfaces as tools (`task` kind).
- Plans/todos become workflow docks.
- Cursor HUD count of subs; OpenCode dedicated subagent row styling.
- **Mental model to steal:** compact delegated row + optional expand; do not invent threads the protocol does not send.

### Portable patterns (standardize on these)

1. Fleet / strip of child agents while any are active in the turn.
2. One-line live status per child.
3. Detail inspector (dock/slide-over) over modal.
4. Workflow checklist separate from tool spam.
5. Timeline keeps a slim card that deep-links to the inspector.
6. Graceful degradation when only L1 data exists.

### Anti-patterns

- Dumping full nested tool streams into the main timeline.
- Provider-specific navigation that feels like five apps.
- Blocking modals for inspection.
- Fake nested activity when the protocol only returns a final blob.
- Glow / heavy animation for status (use quiet pulse / text status only).

---

## 4. Unified information architecture

### Design rule

Prefer extending the existing reducer (`applyEvent`) and types over a second parallel store. Derive fleet views from session state.

### New / extended types (proposed)

```ts
// Conceptual sketch, not final code

type SubagentStatus =
  | "pending"
  | "running"
  | "waiting"  // blocked on permission/question if known
  | "done"
  | "error"
  | "closed";

interface SubagentRef {
  id: string;                 // stable UI id (often callId or thread id)
  callId: string;             // parent tool call id when applicable
  parentCallId: string | null;
  threadId: string | null;    // Codex receiver thread, etc.
  label: string;              // "Explore", "Inspect parser tests"
  role: string | null;        // subagent_type / agent path / worker
  model: string | null;
  status: SubagentStatus;
  activity: string | null;    // one-line current work
  prompt: string | null;
  output: string;             // progressive summary / final result
  items: AgentItem[];         // L3 nested transcript; empty at L1/L2
  startedAt: number;
  endedAt: number | null;
  usage?: Partial<AgentUsage>;
}

// Optional enrichment on ToolItem for L1 compatibility
interface ToolItem {
  // existing fields...
  subagent?: {
    label?: string;
    role?: string;
    threadId?: string;
    parentCallId?: string;
    activity?: string;
  };
}
```

### Workflow model

Keep `PlanItem` as the dock source. Optional later:

```ts
interface AgentPlanStep {
  text: string;
  status: "pending" | "running" | "done";
  phaseId?: string;           // group id for multi-phase workflows
  subagentIds?: string[];     // related children when known
}
```

Phase 0–2 can ship **without** `phaseId` / `subagentIds` by deriving "running subagents this turn" from `task` tools since the last `user` item.

### Relationships

```
User turn
  ├─ PlanItem (workflow dock)
  │    └─ steps[]
  ├─ ToolItem(tool=task) × N  ──index──► SubagentRef[]
  │    └─ (L3) nested AgentItem[]
  └─ other tools / assistant / thinking (main timeline)
```

### Event extensions (proposed)

Keep backward compatible; unknown fields ignored by old UI.

| Event | Purpose |
| --- | --- |
| `tool` (existing) | L1/L2 still update the flat row; optional `subagent` meta. |
| `subagent-upsert` | Create/update `SubagentRef` by id (status, activity, label, prompt). |
| `subagent-delta` | Append nested transcript item or output delta (L3). |
| `subagent-end` | Terminal status + final output. |
| `plan` (existing) | Workflow steps. |

Session state may add `subagents: SubagentRef[]` **or** pure selectors that scan `items` until L3 requires a dedicated list. Recommendation: **selectors from items for L1/L2**; add `session.subagents` only when nested items would bloat the main timeline.

### Mapping from protocols

| Protocol | Spawn | Identity | Live activity | Nested work |
| --- | --- | --- | --- | --- |
| Claude Task/Agent | tool_use name Task/Agent | `subagent_type`, description, prompt | tool status + complete messages with `parent_tool_use_id` | L3 when parent_tool_use_id messages are attributed |
| Codex collab | `collabAgentToolCall` spawnAgent | `receiverThreadIds`, model, prompt | `agentsStates[id].message` | L3 only if app-server streams child items later |
| Codex subAgentActivity | activity items | `agentPath`, `agentThreadId` | kind/status | usually L2 |
| ACP task tools | tool call | title/name | tool status + output | L1/L2 |

---

## 5. UX design

Shared experience for every custom UI. Brand accents (Claude/Grok/ChatGPT/Cursor/OpenCode) may recolor kickers and status dots only.

### 5.1 Subagent strip / fleet view

**When:** any `task` tool (or SubagentRef) exists in the **current user turn**, or the inspector is open on a historical one.

**Where:** above the workflow dock (or combined header with it) inside `agent-composer-shell`, so it stays visible while scrolling the transcript. Alternative for ultra-narrow panes: a single "N subagents" chip that expands the strip.

**Chip contents:**

- Status dot: running / waiting / done / error (CSS, no glow).
- Label (truncate): role or short title.
- One-line activity (truncate): `activity` or last non-empty output line or "Starting…".
- Optional tiny elapsed while running.

**Empty:** strip not rendered.

**Many agents (>4):** horizontal scroll with snap, or "Fleet" button opening a compact list panel.

### 5.2 Navigation

| Input | Action |
| --- | --- |
| Click chip | Open inspector for that subagent; highlight matching timeline card. |
| Click timeline subagent card | Same inspector. |
| Esc / Back control | Close inspector, return focus to composer or timeline. |
| Optional keys (phase 4) | `Alt+[` / `Alt+]` cycle subagents; `Alt+\\` toggle fleet focus. |

Navigation stays **inside the agent pane**. Do not open a new Duckweed split unless a future "Open as pane" action is explicitly added.

### 5.3 Subagent detail (inspector)

**Primary pattern:** right-side or bottom **slide-over dock** within the agent surface (prefer bottom on very short panes, right when width allows). Not a modal.

**Sections:**

1. Header: label, role, status, model (if known), close.
2. Prompt: original task text (collapsible if long).
3. Live activity: current `activity` line + spinner only if running.
4. Body:
   - **L1/L2:** progressive `output` + file changes.
   - **L3:** nested mini-timeline reusing existing item renderers (thinking/tool/assistant) in compact mode.
5. Footer actions: Copy summary, Show in timeline (scroll+flash), Collapse.  
   **Phase 2+ if protocol allows:** Steer (send input), Stop/Close (Codex collab). Hide when adapter reports unsupported.

**Talking to a subagent:** product language is "steer" or "send to this agent", not a second full composer unless L3 + protocol support. Default recommendation: parent composer remains the only full input; inspector offers an optional single-line steer when `adapter.supportsSubagentSteer` is true (Codex-shaped). Claude stream-json may not support this initially.

### 5.4 Workflow view

Keep and upgrade `PlanTracker` / workflow dock:

- Title "Workflow" (already).
- Progress `done/total` and bar (already).
- Optional secondary line: `2 running subagents` derived from fleet.
- When a step is running, keep it as the strong headline (already).
- After completion: existing 30s TTL (`COMPLETED_WORKFLOW_TTL_MS`).
- Future: phase groups if providers emit multi-level plans.

Do not rename to provider-specific terms in chrome ("Todo", "Kanban"). Experiences may still say "tasks" in step text from the model.

### 5.5 Timeline integration

| Element | Behavior |
| --- | --- |
| Subagent card | Slim row: kicker Subagent, title, status. Click opens inspector. |
| Expanded by default | Only when single running subagent and no fleet strip focused; otherwise collapsed if fleet is visible (avoid double noise). |
| Output in timeline | Truncated preview; full content in inspector. |
| Completed historical | Remain as cards; click still opens read-only inspector. |

### 5.6 States

| State | UI |
| --- | --- |
| Starting | Chip "Starting…", pending status. |
| Running | Quiet pulse on dot (respect reduced motion → static). |
| Waiting (permission) | Status "Needs you"; if permission is session-level, keep existing permission card; if child-specific and known, note in inspector. |
| Error | Error mark on chip + inspector shows output/error. |
| Done | Check; activity becomes final summary first line. |
| Parent idle, children running | Session may still be `working` or show notice; fleet remains primary focus. |
| Protocol limited | Inspector banner: "This agent only reports a summary for delegated work." |

### 5.7 Accessibility and density

- All chips and cards keyboard focusable; `aria-label` includes status + title.
- `aria-live="polite"` on fleet activity region (throttled).
- No glow. Status via color + text, not brightness alone.
- Prefer 28–32px chip height; inspector padding matches existing agent chrome.
- `prefers-reduced-motion`: disable pulse.

---

## 6. Interaction flows

### Flow 1: Three research subagents in parallel

1. User sends a broad prompt.
2. Parent emits three `task` tools → three fleet chips appear within ~1 event cycle.
3. Timeline shows three compact Subagent cards; workflow dock may show "Research → Synthesize".
4. Activities update on chips as adapters emit output/activity.

### Flow 2: Inspect one while others run

1. User clicks chip B.
2. Inspector opens with B's prompt and live output.
3. Chips A/C continue updating; selected chip gets `is-selected`.
4. User presses Esc → inspector closes; composer focused.

### Flow 3: Workflow phase advances

1. Plan steps move pending → running → done via existing `plan` events.
2. Dock headline tracks running step.
3. Optional: when last research subagent completes, next step "Synthesize" becomes running.

### Flow 4: Subagent completes

1. Status → done; chip activity freezes on summary first line.
2. Timeline card shows completed.
3. If inspector open on that agent, body shows final output; no auto-close.

### Flow 5: Review after turn ends

1. Session becomes idle; fleet remains for current turn until next user message (or collapses to "N completed" summary chip).
2. Recommendation: keep completed chips until next user prompt, then archive to timeline-only.

### Flow 6: Resume session

1. Historical `task` tools restore as cards.
2. Fleet strip shows only if the resumed "current turn" still has incomplete tasks, else timeline-only until a new turn spawns work.
3. Nested L3 items restore only if history adapter stored them (often L1 on disk).

---

## 7. Protocol and adapter work

### Fidelity levels

| Level | Meaning | UI capability |
| --- | --- | --- |
| **L1** | Flat `ToolItem` with `tool: "task"` | Fleet from tools; inspector shows title/status/output/changes. |
| **L2** | Structured identity + activity | Labels, roles, thread ids, live activity lines, better titles. |
| **L3** | Nested transcript | Inspector mini-timeline; optional demux via parent ids. |

### Per adapter

#### Claude (`adapters/claude.ts`) — priority 1

- Detect Task/Agent tool_use; set `subagent.label` from `subagent_type` / description / prompt.
- When stream-json (or SDK-shaped) messages include `parent_tool_use_id`, attribute assistant/tool content into that subagent (L3). If stream-json headless mode only yields final tool_result, stay L2.
- Continue TodoWrite → `plan`.
- Dedupe child-forwarded errors without dropping the only status signal.

#### Codex (`adapters/codex.ts`) — priority 1 for structure

- Parse `collabAgentToolCall` into one SubagentRef **per receiver thread** when possible (today one tool row packs multi-state text).
- Map `agentsStates` → `activity` + status (L2).
- `subAgentActivity` updates matching thread.
- Future: wire sendInput/closeAgent as inspector actions if app-server allows from Duckweed session.

#### ACP (`adapters/acp.ts`) — L1/L2 opportunistic

- Keep `toolKind` mapping.
- If tool content includes agent name / description fields, lift into `subagent` meta.
- No fake threads.

### Migration

1. Ship UI that only needs `ToolItem` + selectors (L1).
2. Add optional fields / events; UI reads them when present.
3. Never require `session.subagents` for basic fleet.

---

## 8. Shared UI architecture

### Suggested layout

```
src/lib/agents/
  subagents.ts          # selectors: subagentsForTurn, upsert helpers, status mapping
  types.ts              # optional ToolItem.subagent + SubagentRef
  events.ts             # optional subagent-* events + applyEvent branches

src/components/agent/subagents/
  SubagentFleet.tsx     # strip / list
  SubagentInspector.tsx # dock/slide-over
  SubagentCard.tsx      # timeline compact card (or fold into OfficialShared)
  subagents.css         # no glow; shared tokens

Reuse:
  OfficialShared.PlanTracker, ToolActivity (bridge to SubagentCard)
  providerExperience.activitySummary (extend to return SubagentRef-like view models)
  AgentSurface composer shell for fleet + workflow + inspector host
```

### Theming

- Shared structure and class names: `agent-sub-*`.
- Variant modifiers: `agent-sub--claude`, `--codex` / `--chatgpt`, `--grok`, `--cursor`, `--opencode` for accent only.
- Official and provider experiences mount the same fleet/inspector; they stop reimplementing subagent rows once the shared card is good enough (Cursor/OpenCode can keep local styling via variants).

### AgentSurface host responsibilities

- Compute `fleet = subagentsForTurn(session)`.
- Own `selectedSubagentId` local UI state.
- Render fleet + workflow dock + inspector portal region.
- Pass selection handlers into experience timelines **or** handle card clicks via a small context.

Prefer a thin React context (`SubagentUiContext`) over prop-drilling through every experience.

---

## 9. Phased implementation

### Phase 0 — Model and selectors (no visual redesign)

**Work**

- `subagentsForTurn(items)` derived from `tool === "task"` since last user item.
- Optional `ToolItem.subagent` meta fields.
- Codex: parse `agentsStates` into activity strings more cleanly (still on ToolItem).
- Claude: better titles for Task/Agent inputs.

**Files:** `types.ts`, `subagents.ts` (new), `adapters/codex.ts`, `adapters/claude.ts`, tests.

**Acceptance:** unit tests cover multi-task turns; no UI regressions.

**Risk:** over-modeling before UI; mitigate by selectors-only.

### Phase 1 — Fleet strip + inspector (L1/L2), Claude + Codex first

**Work**

- `SubagentFleet`, `SubagentInspector`.
- Mount in `AgentSurface` for all agents (data-driven; empty = hidden).
- Timeline cards open inspector.
- Experience skins: accent only.

**Acceptance**

- Parallel tasks show N chips with status.
- Inspector shows prompt/output for selected task.
- Works in a half-width split pane.

**Risk:** composer height squeeze. Mitigate: collapsible fleet, max 2 rows then scroll.

### Phase 2 — Workflow dock upgrade + all providers L2

**Work**

- Dock secondary line for running subagent count.
- Unify Cursor/OpenCode custom sub rows to shared card (or wrap shared card).
- ACP title/role enrichment where available.
- Wire inspector "Show in timeline".

**Acceptance:** all five experiences share fleet+inspector; Cursor HUD can deep-link to fleet.

### Phase 3 — Nested transcripts (L3) where possible

**Work**

- Claude `parent_tool_use_id` attribution when present in the stream Duckweed consumes.
- Codex: only if app-server exposes child items beyond collab summaries.
- Inspector mini-timeline in compact mode.

**Acceptance:** at least one provider shows nested tools live; others remain L2 without UI errors.

**Risk:** protocol incomplete in headless mode. Feature-detect; banner when nested unavailable.

### Phase 4 — Polish

- Keyboard cycle, reduced motion, completion flash alignment with pane completion signals when a subagent finishes while pane unfocused (optional).
- Historical fleet summary chip after turn idle.
- Optional Codex steer/close if safe and protocol-complete.
- Preview fixtures updated in `AgentExperiencePreview`.

---

## 10. Testing and verification

### Unit

- `subagentsForTurn` with multi-turn isolation (previous turn tasks excluded).
- Codex collab fixtures → structured status/activity (extend `codex.test.ts`).
- Claude Task/Agent title + optional parent id fixtures.
- `applyEvent` for any new event types.
- Workflow + fleet interaction: plan complete TTL still works.

### Component

- Fleet renders N chips; selection opens inspector.
- Esc closes inspector.
- Narrow width layout (no overflow crash).
- a11y: labels include status.

### Manual (real CLIs)

1. Claude: prompt that forces Explore/Task parallelism; confirm chips + inspector.
2. Codex: collab/multi-agent prompt; confirm thread states in activity.
3. OpenCode/Cursor/Grok: any task-style delegation; L1 fleet still usable.
4. Split pane + zoom; workflow dock + fleet + composer all usable.
5. Resume past session with task tools.

### Non-regression

- Sessions without subagents: zero new chrome.
- Existing ToolActivity still works if fleet disabled by empty selectors.

---

## 11. Open questions

1. **Does Duckweed's Claude headless stream include `parent_tool_use_id` complete messages today?** If not, L3 is blocked until adapter/CLI flags improve.
2. **Codex multi-thread:** one ToolItem per collab call vs one SubagentRef per receiver thread? Prefer **per thread** for fleet clarity.
3. **Fleet retention after idle:** keep until next user message (recommended) vs 30s TTL like workflow.
4. **"Open as pane":** out of scope, but leave an extension point on SubagentRef id.
5. **Permission from child threads:** session-level card only, or per-subagent waiting state when protocol says so?
6. **Agent Teams (multi-process):** ignore until product asks; different UX (multi-pane) than in-process Task tools.

---

## 12. Recommended defaults

| Decision | Default |
| --- | --- |
| Inspector chrome | In-pane dock, not modal |
| Primary input | Parent composer only |
| Steer to child | Hidden unless adapter capability flag is true |
| Data source L1/L2 | Derive from `ToolItem` task rows |
| Fleet placement | Above workflow dock in composer shell |
| Completed fleet | Keep until next user message |
| Nested tools in main timeline | No; inspector only |
| Naming in UI | "Subagent" + "Workflow" for all providers |
| Motion | Status dot pulse only; none if reduced motion |
| First implementation PR | Phase 0 + Phase 1 skeleton for all agents, polish Claude/Codex titles |

---

## Next step

Open a single implementation PR for **Phase 0 + Phase 1 skeleton**:

1. Add `src/lib/agents/subagents.ts` with `subagentsForTurn` and status helpers.
2. Improve Claude/Codex task titles and Codex `agentsStates` → activity line on `ToolItem`.
3. Add `SubagentFleet` + `SubagentInspector` mounted from `AgentSurface` (hidden when empty).
4. Click task tool cards / chips to select; Esc to close.
5. Tests for selectors and Codex collab fixture activity lines.

That delivers visible fleet navigation and inspection on top of data Duckweed already has, then Phase 2–3 deepen protocol fidelity without redesigning the UX again.
