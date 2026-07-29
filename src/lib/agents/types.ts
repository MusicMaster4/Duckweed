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

/**
 * Coarse access levels shared by the custom UI.
 *
 * Each adapter translates these into its native protocol. `default` is
 * intentionally an absence of overrides, so the headless session inherits
 * the same configuration as the agent's normal terminal UI.
 */
export type AgentAccessMode = "default" | "read-only" | "workspace" | "full-access";

export interface AgentAccessChoice {
  id: AgentAccessMode;
  label: string;
  description: string;
}

const AGENT_ACCESS_CHOICES: AgentAccessChoice[] = [
  {
    id: "default",
    label: "Agent default",
    description: "Inherit the agent's own permission configuration",
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Inspect and plan without changing files",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Write in the project and ask when needed",
  },
  {
    id: "full-access",
    label: "Full access",
    description: "Bypass routine sandbox and approval prompts",
  },
];

/**
 * Only expose a picker where the protocol can apply the choice faithfully.
 * ACP agents own their permission policy and currently expose only individual
 * approval requests, not a session-wide access level.
 */
export function accessChoicesFor(agent: AgentId): AgentAccessChoice[] {
  if (agent !== "codex" && agent !== "claude") return [];
  return AGENT_ACCESS_CHOICES.map((choice) => ({ ...choice }));
}

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

/** An image the user attached to a prompt. */
export interface AgentImageAttachment {
  /** Stable within the composer and transcript, used for removal and React keys. */
  id: string;
  /** Friendly clipboard or file name shown in the attachment UI. */
  name: string;
  /** MIME type accepted by the agent protocols. */
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Exact original source used by the full-size viewer and agent protocols. */
  dataUrl: string;
  /** Optional derived image used only by the small attachment tile. */
  thumbnailDataUrl?: string;
  /** Original encoded file size in bytes. */
  size: number;
}

/** One user turn, before an adapter translates it to its wire protocol. */
export interface AgentPrompt {
  text: string;
  images: AgentImageAttachment[];
}

/** How a follow-up submitted during an active turn should be delivered. */
export type AgentFollowupMode = "queue" | "steer";

/** A follow-up waiting for the current turn to finish. */
export interface AgentPendingPrompt extends AgentPrompt {
  /** Stable across removal and reordering, so transcript actions target the right prompt. */
  id: string;
}

interface ItemBase {
  id: string;
  at: number;
}

/** What the user sent, echoed into the transcript. */
export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  images?: AgentImageAttachment[];
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
  /**
   * Optional identity and live context for delegated work.
   *
   * Flat task tools remain the source of truth. Adapters lift richer protocol
   * details here when they have them, while L1 providers can omit the object
   * and still appear in the shared fleet.
   */
  subagent?: SubagentMeta;
}

export interface SubagentMeta {
  /** Short task name shown in the fleet. */
  label?: string;
  /** Provider role or agent type, such as Explore. */
  role?: string;
  /** Child thread id when the protocol exposes one. */
  threadId?: string;
  /** Parent delegation call for nested protocol messages. */
  parentCallId?: string;
  /** Model selected for this child. */
  model?: string;
  /** Current one-line work update. */
  activity?: string;
  /** Original delegated prompt. */
  prompt?: string;
  /** Nested settled activity when the provider attributes child messages. */
  items?: AgentItem[];
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
  /** Short-lived UI feedback such as a model/effort picker confirmation. */
  transient?: boolean;
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

/** One choice offered for an agent question. */
export interface AgentQuestionOption {
  /** Stable within its question; used for selection state and React keys. */
  id: string;
  /** Short display text, the thing the user actually picks. */
  label: string;
  /** What choosing it means, shown under the label. */
  description: string;
  /** Longer sample content (a mockup, a snippet) the option wants to show. */
  preview: string | null;
}

/** One question an agent asked, with the choices it offered. */
export interface AgentQuestionItem {
  id: string;
  /** Very short chip label, e.g. "Auth method". */
  header: string;
  question: string;
  /** The user may pick several options rather than exactly one. */
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/**
 * The user's reply to one question.
 *
 * `labels` and `custom` are independent on purpose: picking options and adding
 * a note is a normal answer, and typing with nothing selected is the "none of
 * these" answer. Adapters decide how their protocol carries each part.
 */
export interface AgentQuestionAnswer {
  questionId: string;
  /** Labels of the chosen options, in the order they were picked. */
  labels: string[];
  /** Free text the user wrote, when they wrote any. */
  custom: string | null;
}

/**
 * Whether the card is asking to run something or asking the user to decide.
 *
 * Missing means `approval`: the original prompt, and what every adapter that
 * has not learned about questions still emits.
 */
export type AgentPermissionKind = "approval" | "question";

/** A decision only the user can make; the turn is parked until it is answered. */
export interface AgentPermission {
  id: string;
  kind?: AgentPermissionKind;
  title: string;
  detail: string | null;
  command: string | null;
  changes: AgentFileChange[];
  options: PermissionOption[];
  /** Set when {@link kind} is `question`; the card renders its own controls. */
  questions?: AgentQuestionItem[];
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
  /**
   * Executable that was spawned (`claude`, `claudex`, …). Branding and model
   * catalogs key off this when a wrapper shares an agent protocol.
   */
  program: string;
  /** Display name in the header — may differ from the catalog agent (Claudex). */
  label: string;
  /** Two-letter badge mark for the empty state and header. */
  mark: string;
  /** Accent colour for the session chrome. */
  accent: string;
  status: AgentStatus;
  /** Wall-clock time when the current turn first entered `working`. */
  workStartedAt: number | null;
  /** Wall-clock duration of the most recently completed turn. */
  lastWorkedForMs: number | null;
  cwd: string;
  /** Model the agent reports, once it says. */
  model: string | null;
  /** Reasoning effort in effect, when the agent exposes one. */
  effort: string | null;
  /**
   * Access override selected in Duckweed. Missing means `default` for older
   * persisted/test state; live sessions always initialize this field.
   */
  accessMode?: AgentAccessMode;
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
  pending: AgentPendingPrompt[];
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
  /** Claude/Grok are waiting for the confirming Ctrl+C that closes the harness. */
  exitArmed?: boolean;
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

/** Compact a long provider/model id for the header / trigger chip. */
export function shortModelLabel(model: string): string {
  // Full-string checks first: Claudex's `or/selected` is a single id, not a
  // provider/name pair, so the slash split below must not eat the prefix.
  const full = model.toLowerCase();
  if (full === "or/selected" || full === "or\\selected") return "OpenRouter";
  if (full === "gpt-5.6-sol" || full === "gpt-5.6") return "GPT-5.6 Sol";
  if (full === "grok-4.5") return "Grok 4.5";

  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  // Claude-style ids: `claude-opus-5[1m]` / `opus[1m]` → readable short form.
  const lower = base.toLowerCase();
  if (lower.includes("fable")) return lower.includes("1m") ? "Fable 5 (1M)" : "Fable 5";
  if (lower.includes("opus") && !lower.includes("plan")) {
    return lower.includes("1m") ? "Opus 5 (1M)" : "Opus 5";
  }
  if (lower.includes("sonnet")) return lower.includes("1m") ? "Sonnet 5 (1M)" : "Sonnet 5";
  if (lower.includes("haiku")) return "Haiku 4.5";
  if (lower === "default") return "Default";
  if (lower === "best") return "Best";
  if (lower === "opusplan") return "Opus Plan";
  if (lower === "gpt-5.6-sol" || lower === "gpt-5.6") return "GPT-5.6 Sol";
  if (lower === "grok-4.5") return "Grok 4.5";
  // OpenCode Zen labels often arrive as the full id; keep the tail readable.
  return base.replace(/^claude-/, "").replace(/-/g, " ");
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
  spawn_agent: "task",
  spawnagent: "task",
  subagent: "task",
  sub_agent: "task",
  delegate: "task",
  delegation: "task",
  todowrite: "todo",
  todo_write: "todo",
  taskcreate: "todo",
  task_create: "todo",
  taskupdate: "todo",
  task_update: "todo",
  tasklist: "todo",
  task_list: "todo",
  taskget: "todo",
  task_get: "todo",
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
