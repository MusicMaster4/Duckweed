/**
 * One shape for every coding agent.
 *
 * Claude streams Anthropic message deltas, Codex speaks its own app-server
 * JSON-RPC, and Cursor / Grok / OpenCode speak ACP. The custom UI renders none
 * of those directly: each adapter normalises its protocol into the timeline
 * below, so a thinking block looks the same whoever produced it and a new agent
 * costs one adapter rather than one more branch in every component.
 *
 * The vocabulary follows T3 Code's canonical provider runtime — turns hold
 * items, items hold streamed content — trimmed to what a terminal-sized surface
 * can actually show.
 */

/** Agents the custom UI can drive headlessly. */
export type AgentId = "claude" | "codex" | "cursor" | "grok" | "opencode";

/** Where a session is in its request/response cycle. */
export type AgentStatus =
  /** Process spawned, handshake not finished. */
  | "starting"
  /** Ready and waiting for the user. */
  | "idle"
  /** A turn is in flight. */
  | "working"
  /** Blocked on the user: a permission prompt or a question. */
  | "waiting"
  /** The agent process is gone. */
  | "exited"
  /** Startup or the protocol failed; `error` explains. */
  | "error";

export type ToolStatus = "pending" | "running" | "done" | "error";

/**
 * Coarse tool families, so the UI can pick an icon and a summary line without
 * knowing every agent's tool names.
 */
export type ToolKind =
  | "read"
  | "edit"
  | "search"
  | "execute"
  | "fetch"
  | "think"
  | "task"
  | "todo"
  | "other";

/**
 * One file's worth of proposed or applied change.
 *
 * Agents describe an edit in one of two ways and neither converts cleanly to
 * the other: Claude and ACP send the old and new text, Codex sends a unified
 * patch it already computed. Both are kept, and the renderer takes whichever
 * is present.
 */
export interface AgentFileChange {
  path: string;
  /** Null when the agent only sent the new content (a fresh file). */
  before: string | null;
  after: string | null;
  /** A ready-made unified patch, when that is what the agent sent. */
  diff: string | null;
  insertions: number;
  deletions: number;
}

export interface AgentPlanStep {
  text: string;
  status: "pending" | "running" | "done";
}

interface ItemBase {
  id: string;
  at: number;
}

/** What the user sent, echoed into the transcript. */
export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
}

/** Prose the agent wrote. */
export interface AssistantItem extends ItemBase {
  kind: "assistant";
  text: string;
  streaming: boolean;
}

/** Reasoning the agent exposed — Claude's thinking, Codex's reasoning deltas. */
export interface ThinkingItem extends ItemBase {
  kind: "thinking";
  text: string;
  streaming: boolean;
}

export interface ToolItem extends ItemBase {
  kind: "tool";
  /** Protocol-level identifier, used to match a later update to this call. */
  callId: string;
  /** Raw tool name (`Bash`, `apply_patch`, `edit_file`). */
  name: string;
  tool: ToolKind;
  /** One line describing the call: a command, a path, a query. */
  title: string;
  status: ToolStatus;
  /** Shell command, when this call runs one. */
  command: string | null;
  /** Output so far, trimmed for display. */
  output: string;
  /** File edits this call is making. */
  changes: AgentFileChange[];
}

export interface PlanItem extends ItemBase {
  kind: "plan";
  steps: AgentPlanStep[];
}

/** Anything the user should read that is not the agent talking. */
export interface NoticeItem extends ItemBase {
  kind: "notice";
  text: string;
  tone: "info" | "error";
}

export type AgentItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | PlanItem
  | NoticeItem;

export interface PermissionOption {
  id: string;
  label: string;
  /** Approve options are styled as the affirmative action. */
  kind: "allow" | "allow-always" | "reject" | "reject-always";
}

/** A decision only the user can make; the turn is parked until it is answered. */
export interface AgentPermission {
  id: string;
  title: string;
  detail: string | null;
  command: string | null;
  changes: AgentFileChange[];
  options: PermissionOption[];
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** Null when the agent does not report a price. */
  costUsd: number | null;
  /** Fraction of the model's context that is used, when known. */
  contextUsed: number | null;
}

/**
 * One switchable model, with the effort levels that model accepts.
 *
 * Adapters fill this from their protocol (`model/list`, ACP `modelState`, …)
 * so the header pickers and the `/model` / `/effort` composer menus can offer
 * real choices instead of dumping a wall of text into the transcript.
 */
export interface AgentModelChoice {
  id: string;
  /** Short label for the UI; falls back to {@link id}. */
  label: string;
  efforts: string[];
}

export interface AgentSessionState {
  /** Terminal this session replaced. */
  termId: string;
  agent: AgentId;
  label: string;
  status: AgentStatus;
  cwd: string;
  /** Model the agent reports, once it says. */
  model: string | null;
  /** Reasoning effort in effect, when the agent exposes one. */
  effort: string | null;
  /**
   * Models the user can switch to in this session. Empty until the adapter
   * learns them (or a static fallback is seeded); the UI treats an empty list
   * as "no interactive picker yet".
   */
  models: AgentModelChoice[];
  /** Provider-side session id, shown so a transcript can be found later. */
  sessionId: string | null;
  items: AgentItem[];
  /**
   * Prompts the user sent while a turn was still running, oldest first.
   *
   * Only one turn can be in flight, so a follow-up waits here rather than
   * being pushed at a protocol that would reject it — and it is shown while it
   * waits, because text that vanishes out of the composer looks like a bug.
   */
  pending: string[];
  permission: AgentPermission | null;
  usage: AgentUsage;
  /** Set when `status` is `error`. */
  error: string | null;
  /**
   * Slash commands for composer completion. Starts as the agent's static
   * fallback catalog; commands the agent later advertises are merged in
   * (live names win, static descriptions survive an empty live one).
   */
  commands: { name: string; description: string }[];
  /** True once any turn has run — the empty state steps aside. */
  started: boolean;
}

/** Effort levels the current model (or any known model) accepts. */
export function effortsFor(state: Pick<AgentSessionState, "model" | "models">): string[] {
  if (!state.models.length) return [];
  const active =
    (state.model &&
      state.models.find(
        (model) =>
          model.id === state.model ||
          model.label === state.model ||
          model.id.endsWith(`/${state.model}`),
      )) ||
    null;
  if (active?.efforts.length) return active.efforts;
  // Fall back to the union so a session that only knows efforts on a sibling
  // model still offers something useful in the picker.
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const model of state.models) {
    for (const effort of model.efforts) {
      if (seen.has(effort)) continue;
      seen.add(effort);
      efforts.push(effort);
    }
  }
  return efforts;
}

/** Compact a long provider/model id for the header chip. */
export function shortModelLabel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: null, contextUsed: null };
}

/** Tool families keyed by the names each agent actually uses. */
const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  readfile: "read",
  read_file: "read",
  notebookread: "read",
  write: "edit",
  writefile: "edit",
  write_file: "edit",
  edit: "edit",
  edit_file: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  applypatch: "edit",
  str_replace_editor: "edit",
  glob: "search",
  grep: "search",
  search: "search",
  codebase_search: "search",
  grep_search: "search",
  file_search: "search",
  ls: "search",
  list: "search",
  bash: "execute",
  shell: "execute",
  powershell: "execute",
  run_terminal_cmd: "execute",
  local_shell: "execute",
  exec: "execute",
  webfetch: "fetch",
  web_fetch: "fetch",
  websearch: "fetch",
  web_search: "fetch",
  fetch: "fetch",
  task: "task",
  agent: "task",
  todowrite: "todo",
  todo_write: "todo",
  update_plan: "todo",
  think: "think",
  thinking: "think",
};

/** ACP reports a `kind` of its own; map it onto the same families. */
const ACP_TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  execute: "execute",
  fetch: "fetch",
  think: "think",
  switch_mode: "other",
  other: "other",
};

export function toolKind(name: string, acpKind?: string | null): ToolKind {
  if (acpKind) {
    const mapped = ACP_TOOL_KINDS[acpKind.toLowerCase()];
    if (mapped) return mapped;
  }
  const key = name.toLowerCase().replace(/[\s-]/g, "_");
  return TOOL_KINDS[key] ?? TOOL_KINDS[key.replace(/_/g, "")] ?? "other";
}

/** Count changed lines without building a full diff — enough for a `+n −m` chip. */
export function countChanges(
  before: string | null,
  after: string | null,
): { insertions: number; deletions: number } {
  const oldLines = before === null ? [] : before.split("\n");
  const newLines = after === null ? [] : after.split("\n");
  if (before === null) return { insertions: newLines.length, deletions: 0 };
  if (after === null) return { insertions: 0, deletions: oldLines.length };

  // Trim the shared head and tail, then treat the rest as replaced. That is
  // what a single-hunk edit actually looks like, and it avoids running a real
  // LCS over every file an agent touches.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    insertions: Math.max(0, newLines.length - head - tail),
    deletions: Math.max(0, oldLines.length - head - tail),
  };
}

export function makeChange(
  path: string,
  before: string | null,
  after: string | null,
): AgentFileChange {
  return { path, before, after, diff: null, ...countChanges(before, after) };
}

/** Wrap a unified patch the agent computed itself. */
export function makePatchChange(path: string, diff: string): AgentFileChange {
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    // `+++`/`---` are the file headers, not changed lines.
    if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { path, before: null, after: null, diff, insertions, deletions };
}
