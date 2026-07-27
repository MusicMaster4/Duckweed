import type {
  AgentItem,
  AgentPlanStep,
  AgentSessionState,
  ToolItem,
  ToolKind,
} from "../../../lib/agents/types";

/**
 * Shared reading of a normalised session, for the provider-specific surfaces.
 *
 * Cursor and OpenCode have no canonical web UI to copy, so their surfaces are
 * drawn from scratch — but they are drawn from the *same* facts. Everything
 * below is a pure derivation of {@link AgentSessionState}: what phase the turn
 * is in, how far the plan has got, what the tools have touched. Keeping it here
 * means the two experiences can disagree about presentation without drifting on
 * what the session actually says.
 */

/**
 * What a provider experience is handed.
 *
 * `items` defaults to the session's own transcript; it exists so the surface can
 * be given a window of it (a virtualised tail, a resumed slice) without the
 * component knowing where the slice came from.
 */
export interface ProviderExperienceProps {
  session: AgentSessionState;
  /** Defaults to `session.items`. */
  items?: AgentItem[];
  /** Extra classes on the root, for whatever lays the surface out. */
  className?: string;
}

/* ── Plan ───────────────────────────────────────────────────────────────── */

export interface PlanSummary {
  steps: AgentPlanStep[];
  done: number;
  total: number;
  /** Index of the step the agent says it is on, or -1. */
  activeIndex: number;
  /** The running step, when there is one. */
  active: AgentPlanStep | null;
  /** The first step still to do — what "active" degrades to between steps. */
  next: AgentPlanStep | null;
}

/**
 * The live checklist.
 *
 * Agents rewrite the whole plan every time they tick a box and the reducer
 * replaces it in place, so the last `plan` item is the only one that is true.
 */
export function planSummary(items: AgentItem[]): PlanSummary | null {
  let steps: AgentPlanStep[] | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "plan") {
      steps = item.steps;
      break;
    }
  }
  if (!steps || !steps.length) return null;

  const done = steps.filter((step) => step.status === "done").length;
  const activeIndex = steps.findIndex((step) => step.status === "running");
  const nextIndex = steps.findIndex((step) => step.status === "pending");
  return {
    steps,
    done,
    total: steps.length,
    activeIndex,
    active: activeIndex < 0 ? null : steps[activeIndex],
    next: nextIndex < 0 ? null : steps[nextIndex],
  };
}

/* ── Tool activity ──────────────────────────────────────────────────────── */

export interface ToolTally {
  kind: ToolKind;
  count: number;
  running: number;
  failed: number;
}

export interface ActivitySummary {
  /** Non-empty families, in a fixed order so the strip does not reshuffle. */
  tallies: ToolTally[];
  tools: number;
  /** The call the agent is on right now — the newest running one. */
  running: ToolItem | null;
  runningCount: number;
  failed: number;
  /** `task` calls: the only signal either agent gives that it delegated work. */
  subagents: ToolItem[];
  /** Distinct paths touched, first-seen order. */
  files: string[];
  insertions: number;
  deletions: number;
}

/** Fixed display order for tool families — busiest-to-quietest, not alphabetical. */
const KIND_ORDER: ToolKind[] = [
  "execute",
  "edit",
  "read",
  "search",
  "fetch",
  "task",
  "todo",
  "think",
  "other",
];

export function activitySummary(items: AgentItem[]): ActivitySummary {
  const counts = new Map<ToolKind, ToolTally>();
  const subagents: ToolItem[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  let running: ToolItem | null = null;
  let runningCount = 0;
  let failed = 0;
  let tools = 0;
  let insertions = 0;
  let deletions = 0;

  for (const item of items) {
    if (item.kind !== "tool") continue;
    tools += 1;
    const tally = counts.get(item.tool) ?? { kind: item.tool, count: 0, running: 0, failed: 0 };
    tally.count += 1;
    if (item.status === "running" || item.status === "pending") {
      tally.running += 1;
      runningCount += 1;
      // The newest running call is the one worth naming in a status line.
      running = item;
    }
    if (item.status === "error") {
      tally.failed += 1;
      failed += 1;
    }
    counts.set(item.tool, tally);

    if (item.tool === "task") subagents.push(item);
    for (const change of item.changes) {
      insertions += change.insertions;
      deletions += change.deletions;
      if (seen.has(change.path)) continue;
      seen.add(change.path);
      files.push(change.path);
    }
  }

  const tallies = KIND_ORDER.map((kind) => counts.get(kind)).filter(
    (tally): tally is ToolTally => tally !== undefined,
  );
  return {
    tallies,
    tools,
    running,
    runningCount,
    failed,
    subagents,
    files,
    insertions,
    deletions,
  };
}

/* ── Phase ──────────────────────────────────────────────────────────────── */

/**
 * What the surface should be showing right now.
 *
 * `AgentStatus` says whether a turn is in flight; it does not say whether the
 * agent is reasoning, writing, or shelling out, and those are three visibly
 * different things. The last few items answer that.
 */
export type PhaseKind =
  | "starting"
  | "ready"
  | "thinking"
  | "writing"
  | "tool"
  | "waiting"
  | "ended"
  | "failed";

export interface Phase {
  kind: PhaseKind;
  /** One line naming what is happening — a command, a tool title, an error. */
  detail: string | null;
  /** Animations run only while this is true. */
  busy: boolean;
}

/** Last non-empty line of a streamed block — the part that is still moving. */
export function tailLine(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) return line;
  }
  return "";
}

export function phaseOf(session: AgentSessionState, items: AgentItem[]): Phase {
  if (session.status === "error") {
    return { kind: "failed", detail: session.error, busy: false };
  }
  if (session.status === "exited") return { kind: "ended", detail: null, busy: false };
  if (session.status === "starting") return { kind: "starting", detail: null, busy: true };
  if (session.status === "waiting") {
    return { kind: "waiting", detail: session.permission?.title ?? null, busy: false };
  }
  if (session.status !== "working") return { kind: "ready", detail: null, busy: false };

  // A running tool outranks the prose around it: the agent may keep writing
  // while a command runs, and the command is the thing that can hang.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "tool") continue;
    if (item.status === "running" || item.status === "pending") {
      return { kind: "tool", detail: item.command ?? item.title, busy: true };
    }
    break;
  }

  const last = items[items.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    return { kind: "thinking", detail: tailLine(last.text) || null, busy: true };
  }
  if (last?.kind === "assistant" && last.streaming) {
    return { kind: "writing", detail: null, busy: true };
  }
  return { kind: "thinking", detail: null, busy: true };
}

/** When the turn on screen began — the user's last message. */
export function turnStart(items: AgentItem[]): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "user") return item.at;
  }
  return null;
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `opencode/claude-sonnet-4` → provider and model, for the identity chips. */
export function splitModel(model: string | null): { provider: string | null; name: string | null } {
  if (!model) return { provider: null, name: null };
  const slash = model.lastIndexOf("/");
  if (slash <= 0) return { provider: null, name: model };
  return { provider: model.slice(0, slash), name: model.slice(slash + 1) };
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
