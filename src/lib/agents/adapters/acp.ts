import {
  asArray,
  asRecord,
  asString,
  imagePayloadBase64,
  oneLine,
  parseJson,
  type AdapterContext,
  type AgentAdapter,
} from "../adapter";
import { goalAfterCommand, goalAfterProviderText } from "../goal";
import type { AgentLaunch } from "../launch";
import { promptTextWithLocalSkills } from "../localSkills";
import {
  makeChange,
  toolKind,
  type AgentAccessMode,
  type AgentFileChange,
  type AgentGoal,
  type AgentExtension,
  type AgentId,
  type AgentPlanStep,
  type AgentPrompt,
  type AgentQuestionAnswer,
  type AgentRuntimeTask,
  type SubagentMeta,
  type ToolStatus,
} from "../types";
import { createAntigravitySubagentTracker } from "./antigravitySubagents";

/**
 * Agent Client Protocol — the shared language of Cursor, Grok, and OpenCode.
 *
 * ACP is JSON-RPC 2.0 over stdio with a small, well-shaped vocabulary: the
 * client opens a session, sends a prompt, and receives `session/update`
 * notifications until the prompt request resolves with a stop reason. Grok
 * can keep a workflow running after that response, so its private workflow
 * lifecycle also participates in turn completion. Because three of the five
 * supported agents speak ACP, this one adapter is most of the
 * protocol coverage — the per-agent differences live in spawn arguments
 * and in the `_meta` fields read below. Grok steers through
 * `_x.ai/interject` and Antigravity steers with an overlapping `session/prompt`.
 *
 * Slash commands: names an agent advertises (`availableCommands`) are sent
 * back as plain `session/prompt` text — the agent intercepts them (verified:
 * grok answers in 0 tokens). `/model` and `/effort` are never advertised, so
 * they are wired to RPCs instead: `session/set_model` (or `session/set_config_option`
 * when the agent publishes `configOptions`) and Grok's effort selector.
 * Grok 1.0.24+ exposes effort as `configId: "reasoning_effort"` (category
 * `thought_level`) with per-model rows that include `xhigh` on grok-4.6.
 * Older Grok builds still take `session/set_mode`. Anything unknown is refused
 * locally rather than spending a model turn on it — grok happily chats about
 * a `/model` typo.
 */

const PROTOCOL_VERSION = 1;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Record<string, unknown>) => void;
}

const RESUME_CANCELLED = "duckweed_resume_cancelled";

/** A model the agent says it can switch to, with its effort levels if any. */
interface AcpModel {
  id: string;
  name: string;
  efforts: string[];
}

const ACP_STATUS: Record<string, ToolStatus> = {
  pending: "pending",
  in_progress: "running",
  inProgress: "running",
  completed: "done",
  failed: "error",
};

const ANTIGRAVITY_ACTIVE_POLL_MS = 750;
const ANTIGRAVITY_IDLE_POLL_MS = 2_000;
const ANTIGRAVITY_STATUS_GRACE_MS = 12_000;

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalize `/C:/path` Windows URIs that ACP servers like Antigravity emit. */
function normalizeAcpPath(path: string): string {
  return path.replace(/^\/([A-Za-z]:\/)/, "$1");
}

function readCommandInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  return asString(input.command) ?? asString(input.CommandLine);
}

/** Extract per-model efforts from flattened variant ids like `gemini-4-neon-xhigh`. */
function effortsFromModelVariants(baseId: string, variantIds: readonly string[]): string[] {
  const prefix = `${baseId.toLowerCase()}-`;
  const found = new Set<string>();
  for (const variant of variantIds) {
    const lower = variant.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const suffix = lower.slice(prefix.length);
    if ((EFFORT_ORDER as readonly string[]).includes(suffix)) found.add(suffix);
  }
  return EFFORT_ORDER.filter((level) => found.has(level));
}

function splitAntigravityModelEffort(
  value: string,
): { model: string; effort: string } | null {
  const match = /^(.+)-(low|medium|high|xhigh|max)$/i.exec(value);
  if (!match) return null;
  return { model: match[1], effort: match[2].toLowerCase() };
}

function accessModeFromAcpMode(modeId: string): AgentAccessMode | null {
  switch (modeId.toLowerCase()) {
    case "default":
      return "default";
    case "plan":
      return "read-only";
    case "accept-edits":
      return "workspace";
    case "auto":
      return "auto";
    default:
      return null;
  }
}

function acpModeFromAccessMode(mode: AgentAccessMode): string {
  switch (mode) {
    case "read-only":
      return "plan";
    case "workspace":
      return "accept-edits";
    case "auto":
    case "full-access":
      return "auto";
    case "default":
      return "default";
  }
}

/** Canonical effort token: Grok catalog rows use `value`, older ACP rows use `id`. */
function effortToken(entry: Record<string, unknown>): string {
  return asString(entry.value) ?? asString(entry.id) ?? "";
}

function isEffortConfigOption(entry: Record<string, unknown>): boolean {
  const id = (asString(entry.id) ?? "").toLowerCase();
  const category = (asString(entry.category) ?? "").toLowerCase();
  return (
    category === "thought_level" ||
    id === "effort" ||
    id === "reasoning" ||
    id === "reasoning_effort"
  );
}

function isModeConfigOption(entry: Record<string, unknown>): boolean {
  const id = (asString(entry.id) ?? "").toLowerCase();
  const category = (asString(entry.category) ?? "").toLowerCase();
  return category === "mode" || id === "mode";
}

/** Pull display text and diffs out of a tool call's content blocks. */
function readToolContent(blocks: unknown[]): { text: string; changes: AgentFileChange[] } {
  const lines: string[] = [];
  const changes: AgentFileChange[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block) continue;
    const type = asString(block.type);
    if (type === "diff") {
      const path = asString(block.path);
      if (path) {
        changes.push(
          makeChange(normalizeAcpPath(path), asString(block.oldText), asString(block.newText)),
        );
      }
      continue;
    }
    // `{ type: "content", content: { type: "text", text } }` is the common
    // wrapper; some agents inline the text block directly.
    const inner = asRecord(block.content) ?? block;
    const text = asString(inner.text);
    if (text) lines.push(text);
  }
  return { text: lines.join("\n"), changes };
}

/** ACP content blocks used for messages and thoughts. */
function readContentText(value: unknown): string {
  const block = asRecord(value);
  if (!block) return "";
  const text = asString(block.text);
  if (text) return text;
  const inner = asRecord(block.content);
  return inner ? (asString(inner.text) ?? "") : "";
}

/**
 * Recover only the text the person typed from Grok's stored user messages.
 *
 * Grok persists harness context such as `<user_info>` and `<system-reminder>`
 * as user-role messages. `session/load` then replays those records through the
 * same `user_message_chunk` channel as real prompts. The custom transcript
 * must not expose that private protocol plumbing as conversation content.
 * Goal sessions are the exception: their original prompt is nested inside a
 * reminder, so extract that prompt instead of dropping the whole record.
 */
function visibleGrokReplayText(text: string): string | null {
  let visible = text.trim();
  if (!visible) return null;

  const query = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/i.exec(visible);
  if (query) visible = query[1].trim();

  if (/^<system-reminder>/i.test(visible)) {
    const goal = /^<system-reminder>\s*A goal has been set:\s*([\s\S]*?)(?:\r?\n){2}You are working directly on this goal across multiple turns\./i.exec(
      visible,
    );
    if (goal) return goal[1].trim() || null;

    const reminderEnd = visible.indexOf("</system-reminder>");
    if (reminderEnd < 0) return null;
    visible = visible.slice(reminderEnd + "</system-reminder>".length).trim();
    if (!visible) return null;
  }

  if (/^<(?:user_info|rules|INSTRUCTIONS|recommended_plugins)>/i.test(visible)) return null;
  return visible || null;
}

/** A complete Grok context record starts a new stored user-role message. */
function startsGrokReplayRecord(text: string): boolean {
  return /^<(?:user_query|user_info|system-reminder|rules|INSTRUCTIONS|recommended_plugins)>/i.test(
    text.trimStart(),
  );
}

function lastLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

function readRawOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (typeof entry === "string" ? entry : readContentText(entry)))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(raw);
  if (!record) return "";
  return (
    asString(record.text) ??
    asString(record.output) ??
    asString(record.result) ??
    asString(record.summary) ??
    readContentText(record.content)
  );
}

function readMetaToolName(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const xaiTool = asRecord(meta["x.ai/tool"]);
  return (
    asString(meta.toolName) ??
    asString(meta.tool_name) ??
    asString(meta.name) ??
    asString(xaiTool?.name) ??
    asString(xaiTool?.tool_name) ??
    asString(xaiTool?.toolName)
  );
}

function readMetaThreadId(
  meta: Record<string, unknown> | null,
  rawOutput: unknown,
): string | null {
  const output = asRecord(rawOutput);
  const outputMeta = asRecord(output?.metadata);
  return (
    asString(meta?.subagentSessionId) ??
    asString(meta?.sessionId) ??
    asString(meta?.session_id) ??
    asString(meta?.threadId) ??
    asString(meta?.thread_id) ??
    asString(output?.subagentSessionId) ??
    asString(output?.sessionId) ??
    asString(output?.session_id) ??
    asString(output?.threadId) ??
    asString(output?.thread_id) ??
    asString(outputMeta?.sessionId) ??
    asString(outputMeta?.session_id) ??
    null
  );
}

function isAntigravityInvokeCall(
  agent: AgentId,
  rawToolName: string | null,
  title: string | null,
  rawInput: Record<string, unknown> | null,
): boolean {
  if (agent !== "antigravity") return false;
  if (rawToolName === "invoke_subagent") return true;
  if (title && /\binvoke_subagent\b/i.test(title)) return true;
  return Boolean(
    rawInput &&
      asString(rawInput.TypeName) &&
      (asString(rawInput.Prompt) || asString(rawInput.Role)),
  );
}

/** Grok's private ACP extension reports background workflow phases this way. */
function readWorkflowSteps(update: Record<string, unknown>): AgentPlanStep[] {
  const workflowStatus = asString(update.status)?.toLowerCase();
  return asArray(update.phases)
    .map((raw) => asRecord(raw))
    .filter((phase): phase is Record<string, unknown> => phase !== null)
    .map((phase) => {
      const state = asString(phase.state)?.toLowerCase();
      const done =
        state === "done" ||
        state === "completed" ||
        workflowStatus === "done" ||
        workflowStatus === "completed";
      const running =
        state === "active" ||
        state === "running" ||
        state === "in_progress" ||
        state === "inprogress";
      return {
        text: asString(phase.title) ?? asString(phase.name) ?? "",
        status: done ? ("done" as const) : running ? ("running" as const) : ("pending" as const),
      };
    })
    .filter((step) => step.text);
}

/** OpenCode exposes its TodoWrite state as a normal ACP tool call. */
function readTodoSteps(value: unknown): AgentPlanStep[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }

  const record = asRecord(parsed);
  const entries = Array.isArray(parsed)
    ? parsed
    : record && Array.isArray(record.todos)
      ? record.todos
      : null;
  if (!entries?.length) return null;

  const steps: AgentPlanStep[] = [];
  for (const raw of entries) {
    const todo = asRecord(raw);
    if (!todo) return null;
    const text =
      asString(todo.content)?.trim() ||
      asString(todo.description)?.trim() ||
      asString(todo.text)?.trim();
    if (!text) return null;
    const status = asString(todo.status)?.toLowerCase();
    steps.push({
      text,
      status:
        status === "completed" || status === "done"
          ? "done"
          : status === "in_progress" || status === "inprogress" || status === "running"
            ? "running"
            : "pending",
    });
  }
  return steps;
}

function isTodoToolTitle(title: string): boolean {
  return toolKind(title) === "todo" || /^\s*(?:\d+\s+)?todos?\s*$/i.test(title);
}

/** Lift task-like raw input without inventing a thread ACP never reported. */
function readSubagentMeta(
  title: string | null,
  input: Record<string, unknown> | null,
  toolName: string | null = null,
): SubagentMeta | null {
  if (!input && (!toolName || toolKind(toolName) !== "task")) return null;
  const prompt = (asString(input?.prompt) ?? asString(input?.Prompt))?.trim();
  const description = (
    asString(input?.description) ??
    asString(input?.Description) ??
    asString(input?.Role)
  )?.trim();
  const role =
    asString(input?.subagent_type)?.trim() ||
    asString(input?.TypeName)?.trim() ||
    asString(input?.Role)?.trim() ||
    asString(input?.agent)?.trim() ||
    asString(input?.agent_name)?.trim() ||
    asString(input?.agentName)?.trim();
  const rawTool =
    toolName?.trim() ||
    asString(input?.tool)?.trim() ||
    asString(input?.tool_name)?.trim() ||
    asString(input?.toolName)?.trim();
  const taskShaped =
    (rawTool ? toolKind(rawTool) === "task" : false) ||
    Boolean(role) ||
    Boolean(prompt && description);
  if (!taskShaped) return null;
  const label = description || role || title?.trim() || prompt || "Subagent";
  const model = (asString(input?.model) ?? asString(input?.Model))?.trim();
  return {
    label: oneLine(label, 80),
    ...(role ? { role } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
  };
}

export function createAcpAdapter(agent: AgentId = "grok"): AgentAdapter {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let sessionId: string | null = null;
  /** The session/load request currently replaying history into the pane. */
  let resumeRequestId: number | null = null;
  let resumeSessionId: string | null = null;
  /** Turn ids so streamed chunks group into one bubble per turn. */
  let turnSeq = 0;
  /**
   * ACP only labels a chunk as message or thought; it does not provide a
   * content-block id. Keep one thought stream and one message stream per
   * tool-bounded phase. Grok interleaves `agent_thought_chunk` with
   * `agent_message_chunk` at token granularity, and its workflow also emits
   * `tool_call_update` while prose is still arriving. Opening a new block on
   * every kind switch (or every tool update) shatters one sentence into a
   * stack of interim bubbles. A new phase starts only when a tool call id
   * first appears.
   */
  let activeContent: "assistant" | "thinking" | null = null;
  let assistantSegment = 0;
  let currentGoal: AgentGoal | null = null;
  let goalBeforeCommand: AgentGoal | null = null;
  let goalResponsePending = false;
  let goalResponseText = "";
  let thinkingSegment = 0;
  /** Counts tool-bounded phases so thought/message can resume after a switch. */
  let contentPhase = 0;
  let assistantPhase = -1;
  let thinkingPhase = -1;
  /** Tool ids already used to open a content phase. */
  const seenToolCalls = new Set<string>();
  /** Permission id → the JSON-RPC request id ACP is waiting on. */
  const permissionRequests = new Map<string, string | number>();
  const questionRequests = new Map<string, string | number>();
  /** Tool calls whose content we have already seen, to merge partial updates. */
  const toolTitles = new Map<string, string>();
  /** ACP updates omit raw input, so remember which calls were delegated work. */
  const taskCalls = new Set<string>();
  /** A launch acknowledgement is not the background agent's result. */
  const backgroundTaskCalls = new Set<string>();
  /** Synchronous delegated calls that must settle when their parent turn ends. */
  const openSyncTaskCalls = new Set<string>();
  /** Grok background task_id -> originating ACP toolCallId. */
  const grokTaskCallById = new Map<string, string>();
  const activeGrokTasks = new Set<string>();
  const antigravitySubagents = agent === "antigravity" ? createAntigravitySubagentTracker() : null;
  /** Whether AGY has already acknowledged starting each invoke_subagent call. */
  const antigravityInvocations = new Map<string, boolean>();
  /** OpenCode updates omit raw input too, so keep TodoWrite calls absorbed. */
  const todoCalls = new Set<string>();
  /**
   * Slash commands the agent advertised, without the leading slash. Only
   * these may go out as prompt text — anything else slash-shaped would be
   * chatted to the model at full price.
   */
  const advertised = new Set<string>();
  let extensions: AgentExtension[] = [];
  const runtimeTasks = new Map<string, AgentRuntimeTask>();
  let supportsImages = false;
  let supportsEmbeddedContext = false;
  let supportsTerminalClient = false;
  /** Models the agent can switch to, and each one's effort levels. */
  let availableModels: AcpModel[] = [];
  /** Raw flattened model ids reported by `session.models` (used by Antigravity). */
  let rawModelVariantIds: string[] = [];
  let currentModelId: string | null = null;
  let currentEffort: string | null = null;
  /**
   * OpenCode advertises effort as a `configOptions` entry (`id: "effort"`,
   * category `thought_level`). Grok 1.0.24+ does the same with
   * `id: "reasoning_effort"`, and Antigravity with `id: "thought_level"` plus
   * `id: "mode"`. When present, model/effort/mode changes go through
   * `session/set_config_option` so the response can refresh the option list
   * (effort levels depend on model). Older Grok still uses `session/set_mode`.
   */
  let usesConfigOptions = false;
  /** `configId` for the thought-level option, when the agent publishes one. */
  let effortConfigId: string | null = null;
  /** `configId` for the execution mode option, when the agent publishes one. */
  let modeConfigId: string | null = null;
  /**
   * Antigravity Full access runs ACP in `auto` mode and immediately approves
   * any remaining `session/request_permission` prompts without asking.
   */
  let fullAccessBypass = false;
  /** Cumulative token usage across turns in this ACP session. */
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  /**
   * Slash commands an agent intercepts can legitimately produce no output
   * (grok's `/context` renders in its TUI only). When a slash turn comes
   * back empty, say so instead of leaving a lone echo on screen.
   */
  let slashPending = false;
  let turnHadContent = false;
  /**
   * Grok workflows outlive the foreground `session/prompt` request. Resolving
   * that request only means the model handed control to the workflow runner;
   * the turn remains busy until every run reports a terminal status.
   */
  const activeWorkflows = new Set<string>();
  // Antigravity can settle superseded prompt requests out of order after a steer.
  let pendingTurnPrompts = 0;
  let turnOpen = false;
  let antigravityActivityWatch: { timer?: ReturnType<typeof setTimeout> } | undefined;
  let disposed = false;
  /** The agent advertised `session/load` — see {@link AgentAdapter.resume}. */
  let canLoadSession = false;
  /**
   * A `session/load` is in flight, so the `session/update` notifications
   * arriving are the stored conversation being replayed rather than live work.
   * The replayed user turns are chunked, so they are buffered and flushed as
   * one message each — see {@link flushReplayedUser}.
   */
  let loading = false;
  /** True after the first replay update replaced the previous transcript. */
  let replayStarted = false;
  let replayedUser = "";

  function resetContentSegments() {
    activeContent = null;
    assistantSegment = 0;
    thinkingSegment = 0;
    contentPhase = 0;
    assistantPhase = -1;
    thinkingPhase = -1;
    seenToolCalls.clear();
  }

  function workflowId(update: Record<string, unknown>): string {
    return (
      asString(update.run_id) ??
      asString(update.runId) ??
      asString(update.workflow_id) ??
      asString(update.workflowId) ??
      asString(update.name) ??
      "grok-workflow"
    );
  }

  function workflowIsTerminal(status: string): boolean {
    return (
      status === "completed" ||
      status === "done" ||
      status === "failed" ||
      status === "error" ||
      status === "stopped" ||
      status === "interrupted" ||
      status === "cancelled" ||
      status === "canceled" ||
      status === "budget_limited" ||
      status === "budgetlimited"
    );
  }

  function finishTurnWhenReady(ctx: AdapterContext, force = false) {
    if (!turnOpen || pendingTurnPrompts > 0) return;
    if (!force && activeWorkflows.size > 0) return;
    if (force) {
      activeWorkflows.clear();
      for (const callId of backgroundTaskCalls) {
        if (antigravityInvocations.has(callId)) continue;
        ctx.emit({
          type: "tool",
          callId,
          status: "error",
          ...(taskCalls.has(callId)
            ? { subagent: { activity: "Delegated work stopped" } }
            : {}),
        });
      }
      backgroundTaskCalls.clear();
      activeGrokTasks.clear();
    }
    for (const callId of openSyncTaskCalls) {
      ctx.emit({
        type: "tool",
        callId,
        status: force ? "error" : "done",
        subagent: {
          activity: force ? "Delegated work stopped" : "Delegated work completed",
        },
      });
    }
    openSyncTaskCalls.clear();
    antigravitySubagents?.pollNow();
    turnOpen = false;
    ctx.emit({ type: "turn-end" });
  }

  function stopAntigravityActivityWatch() {
    clearTimeout(antigravityActivityWatch?.timer);
    antigravityActivityWatch = undefined;
  }

  function watchAntigravityActivity(ctx: AdapterContext): boolean {
    const readActivity = ctx.readAntigravityActivity;
    const id = sessionId;
    if (agent !== "antigravity" || !readActivity || !id || disposed) return false;

    const watch: NonNullable<typeof antigravityActivityWatch> = {};
    antigravityActivityWatch = watch;
    let lastStatusAt: number | null = null;

    const poll = async () => {
      const active = await readActivity(id).catch(() => null);
      if (antigravityActivityWatch !== watch) return;

      if (active === null) {
        // Older CLI versions may have no readable status. After a successful
        // read, tolerate temporary SQLite or IPC failures before falling back.
        if (lastStatusAt === null || Date.now() - lastStatusAt >= ANTIGRAVITY_STATUS_GRACE_MS) {
          stopAntigravityActivityWatch();
          finishTurnWhenReady(ctx);
          return;
        }
      } else {
        lastStatusAt = Date.now();
        if (active && !turnOpen) {
          turnOpen = true;
          if (permissionRequests.size === 0 && questionRequests.size === 0) {
            ctx.emit({ type: "status", status: "working" });
          }
        } else if (!active) {
          finishTurnWhenReady(ctx);
        }
      }

      // Completing a turn can dispatch a queued prompt synchronously.
      if (antigravityActivityWatch === watch) {
        const delay = turnOpen ? ANTIGRAVITY_ACTIVE_POLL_MS : ANTIGRAVITY_IDLE_POLL_MS;
        watch.timer = setTimeout(poll, delay);
        (watch.timer as { unref?: () => void }).unref?.();
      }
    };

    // ACP can answer session/prompt while the conversation still has work.
    // Check again after idle in case Antigravity restarts on its own.
    void poll();
    return true;
  }

  function activeContentId(): string | null {
    if (activeContent === "assistant") {
      return `a${turnSeq}${assistantSegment > 1 ? `-${assistantSegment}` : ""}`;
    }
    if (activeContent === "thinking") {
      return `r${turnSeq}${thinkingSegment > 1 ? `-${thinkingSegment}` : ""}`;
    }
    return null;
  }

  function closeActiveContent(ctx: AdapterContext) {
    const id = activeContentId();
    if (!id || !activeContent) return;
    ctx.emit({
      type: activeContent === "assistant" ? "assistant-end" : "thinking-end",
      id,
    });
    activeContent = null;
  }

  function contentId(kind: "assistant" | "thinking", ctx: AdapterContext): string {
    if (activeContent !== kind) {
      closeActiveContent(ctx);
      activeContent = kind;
    }
    if (kind === "assistant") {
      if (assistantPhase !== contentPhase) {
        assistantPhase = contentPhase;
        assistantSegment += 1;
      }
    } else if (thinkingPhase !== contentPhase) {
      thinkingPhase = contentPhase;
      thinkingSegment += 1;
    }
    const segment = kind === "assistant" ? assistantSegment : thinkingSegment;
    const prefix = kind === "assistant" ? "a" : "r";
    return `${prefix}${turnSeq}${segment > 1 ? `-${segment}` : ""}`;
  }

  /** First sighting of a tool starts a new thought/message phase. */
  function beginToolContentPhase(callId: string, ctx: AdapterContext) {
    if (seenToolCalls.has(callId)) return;
    seenToolCalls.add(callId);
    closeActiveContent(ctx);
    contentPhase += 1;
  }

  function request(
    ctx: AdapterContext,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ctx.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(ctx: AdapterContext, method: string, params: unknown) {
    ctx.send({ jsonrpc: "2.0", method, params });
  }

  function fail(ctx: AdapterContext, message: string) {
    ctx.emit({ type: "status", status: "error", error: message });
  }

  /** `availableCommands` entries → stored names + composer rows. */
  function readCommands(raw: unknown): { name: string; description: string }[] {
    const commands = asArray(raw)
      .map((entry) => asRecord(entry))
      .filter((command): command is Record<string, unknown> => command !== null)
      .map((command) => ({
        name: `/${asString(command.name) ?? ""}`,
        description: asString(command.description) ?? "",
      }))
      .filter((command) => command.name.length > 1);
    for (const command of commands) advertised.add(command.name.slice(1).toLowerCase());
    extensions = [
      ...extensions.filter((extension) => extension.kind !== "workflow"),
      ...commands.map((command) => ({
        id: `workflow:${command.name.slice(1)}`,
        kind: "workflow" as const,
        name: command.name,
        description: command.description,
        enabled: true,
        callable: true,
        status: "ready" as const,
        source: agent,
      })),
    ];
    return commands;
  }

  /**
   * Grok's `modelState` (and the standard `models` field on `session/new`):
   * current model, switchable models, and each one's reasoning efforts.
   */
  /** Map the adapter's internal model list onto the session event shape. */
  function modelsForUi() {
    return availableModels.map((model) => ({
      id: model.id,
      label: model.name || model.id,
      efforts: [...model.efforts],
    }));
  }

  function readModelState(
    raw: unknown,
    opts: { sessionEffort?: boolean } = {},
  ): {
    model?: string;
    effort?: string;
    models?: ReturnType<typeof modelsForUi>;
  } {
    const applyEffort = opts.sessionEffort !== false;
    const state = asRecord(raw);
    if (!state) return {};
    const current = asString(state.currentModelId);
    const entries = asArray(state.availableModels)
      .map((entry) => asRecord(entry))
      .filter((model): model is Record<string, unknown> => model !== null);
    const models = entries
      .map((model) => {
        const meta = asRecord(model._meta);
        return {
          id: asString(model.modelId) ?? "",
          name: asString(model.name) ?? asString(model.modelId) ?? "",
          efforts: asArray(meta?.reasoningEfforts)
            .map((entry) => asRecord(entry))
            .filter((effort): effort is Record<string, unknown> => effort !== null)
            .map((effort) => effortToken(effort))
            .filter(Boolean),
        };
      })
      .filter((model) => model.id);
    if (models.length) {
      rawModelVariantIds = models.map((model) => model.id);
      availableModels = models;
    }
    if (current) currentModelId = current;
    const active = entries.find((model) => asString(model.modelId) === currentModelId);
    const effort = applyEffort ? asString(asRecord(active?._meta)?.reasoningEffort) : null;
    if (effort) currentEffort = effort;
    return {
      ...(current ? { model: current } : {}),
      ...(effort ? { effort } : {}),
      ...(availableModels.length ? { models: modelsForUi() } : {}),
    };
  }

  /**
   * OpenCode's answer to model/effort: `configOptions` on `session/new` (and
   * on every `session/set_config_option` result). Model is always present;
   * effort (`category: "thought_level"`) appears only for models that support
   * thinking budgets — switching to big-pickle drops it, switching to Opus
   * brings it back (verified against opencode 1.18).
   */
  function readConfigOptions(raw: unknown): {
    model?: string;
    effort?: string | null;
    accessMode?: AgentAccessMode;
    models?: ReturnType<typeof modelsForUi>;
  } {
    const options = asArray(raw)
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    if (!options.length) return {};
    usesConfigOptions = true;

    const modelOption = options.find(
      (entry) => entry.category === "model" || asString(entry.id) === "model",
    );
    const effortOption = options.find(isEffortConfigOption);
    const modeOption = options.find(isModeConfigOption);
    if (effortOption) {
      effortConfigId = asString(effortOption.id) ?? effortConfigId ?? "effort";
    }
    if (modeOption) {
      modeConfigId = asString(modeOption.id) ?? modeConfigId ?? "mode";
    }

    const efforts = effortOption
      ? asArray(effortOption.options)
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
          .map((entry) => effortToken(entry))
          .filter(Boolean)
      : [];

    if (modelOption) {
      const current = asString(modelOption.currentValue);
      const listed = asArray(modelOption.options)
        .map((entry) => asRecord(entry))
        .filter((model): model is Record<string, unknown> => model !== null)
        .map((model) => ({
          id: asString(model.value) ?? "",
          name: asString(model.name) ?? asString(model.value) ?? "",
        }))
        .filter((model) => model.id);
      if (current) currentModelId = current;
      if (listed.length) {
        const known = new Map(availableModels.map((model) => [model.id, model]));
        if (agent === "antigravity" && rawModelVariantIds.length) {
          // Antigravity publishes flattened `<model>-<effort>` variants in
          // `session.models` alongside clean base ids in `configOptions`.
          // Derive each base model's exact effort list upfront so pickers
          // reflect per-model thinking support before switching.
          availableModels = listed.map((model) => {
            const variantEfforts = effortsFromModelVariants(model.id, rawModelVariantIds);
            const existing = known.get(model.id);
            const resolvedEfforts = variantEfforts.length
              ? variantEfforts
              : existing
                ? existing.efforts
                : [];
            return { ...model, efforts: [...resolvedEfforts] };
          });
        } else if (availableModels.length) {
          // Grok already sent per-model effort lists on modelState. Keep those
          // (grok-4.6 has xhigh, grok-4.5 does not) and only refresh names.
          availableModels = listed.map((model) => {
            const existing = known.get(model.id);
            return existing
              ? { ...existing, name: model.name || existing.name }
              : { ...model, efforts: [...efforts] };
          });
        } else {
          // OpenCode: effort levels are per active model on the wire, but the
          // picker needs them on the current row; attach the live list to every
          // entry so switching model keeps the effort chip usable until the
          // next configOptions refresh replaces it.
          availableModels = listed.map((model) => ({ ...model, efforts: [...efforts] }));
        }
      }
      if (currentModelId) {
        if (efforts.length) {
          availableModels = availableModels.map((model) =>
            model.id === currentModelId ? { ...model, efforts: [...efforts] } : model,
          );
        } else if (!effortOption) {
          availableModels = availableModels.map((model) =>
            model.id === currentModelId ? { ...model, efforts: [] } : model,
          );
        }
      }
    } else if (efforts.length && currentModelId) {
      // Only effort changed; stamp the new list onto the active model.
      availableModels = availableModels.map((model) =>
        model.id === currentModelId ? { ...model, efforts: [...efforts] } : model,
      );
    }

    let effort: string | null | undefined;
    if (effortOption) {
      const value = asString(effortOption.currentValue);
      if (value) {
        currentEffort = value;
        effort = value;
      }
    } else if (modelOption) {
      // Model config refreshed without an effort option: this model has none.
      currentEffort = null;
      effort = null;
    }

    let accessMode: AgentAccessMode | undefined;
    if (agent === "antigravity" && modeOption) {
      const value = asString(modeOption.currentValue);
      const mapped = value ? resolveAntigravityAccessMode(value) : null;
      if (mapped) accessMode = mapped;
    }

    return {
      ...(currentModelId ? { model: currentModelId } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(accessMode !== undefined ? { accessMode } : {}),
      ...(availableModels.length ? { models: modelsForUi() } : {}),
    };
  }

  /** Apply a set_config_option result that may carry a refreshed option list. */
  function applyConfigResult(result: Record<string, unknown>, ctx: AdapterContext) {
    const update = readConfigOptions(result.configOptions);
    if (Object.keys(update).length) ctx.emit({ type: "session", ...update });
  }

  async function setModel(modelId: string, ctx: AdapterContext): Promise<void> {
    if (!sessionId) return;
    if (usesConfigOptions) {
      const result = await request(ctx, "session/set_config_option", {
        sessionId,
        configId: "model",
        value: modelId,
      });
      currentModelId = modelId;
      applyConfigResult(result, ctx);
      if (!result.configOptions) {
        ctx.emit({ type: "session", model: modelId });
      }
      return;
    }
    await request(ctx, "session/set_model", { sessionId, modelId });
    currentModelId = modelId;
    ctx.emit({ type: "session", model: modelId });
  }

  async function setEffort(level: string, ctx: AdapterContext): Promise<void> {
    if (!sessionId) return;
    if (usesConfigOptions) {
      const result = await request(ctx, "session/set_config_option", {
        sessionId,
        configId: effortConfigId ?? "effort",
        value: level,
      });
      currentEffort = level;
      applyConfigResult(result, ctx);
      if (!result.configOptions) {
        ctx.emit({ type: "session", effort: level });
      }
      return;
    }
    await request(ctx, "session/set_mode", { sessionId, modeId: level });
    currentEffort = level;
    ctx.emit({ type: "session", effort: level });
  }

  function resolveAntigravityAccessMode(modeId: string): AgentAccessMode | null {
    const mapped = accessModeFromAcpMode(modeId);
    if (!mapped) return null;
    if (mapped === "auto" && fullAccessBypass) return "full-access";
    if (mapped !== "auto") fullAccessBypass = false;
    return mapped;
  }

  async function setAccessMode(mode: AgentAccessMode, ctx: AdapterContext): Promise<void> {
    if (!sessionId) return;
    const previousBypass = fullAccessBypass;
    fullAccessBypass = mode === "full-access";
    const modeId = acpModeFromAccessMode(mode);
    try {
      if (usesConfigOptions) {
        const result = await request(ctx, "session/set_config_option", {
          sessionId,
          configId: modeConfigId ?? "mode",
          value: modeId,
        });
        applyConfigResult(result, ctx);
        if (!result.configOptions) {
          ctx.emit({ type: "session", accessMode: mode });
        }
        return;
      }
      await request(ctx, "session/set_mode", { sessionId, modeId });
      ctx.emit({ type: "session", accessMode: mode });
    } catch (error) {
      fullAccessBypass = previousBypass;
      throw error;
    }
  }

  /** `initialize` → `session/new` → launch-time model/effort → ready. */
  /** Resolve ACP client-file requests inside the launched workspace only. */
  function resolveClientPath(cwd: string, requested: string): string | null {
    const slash = (value: string) => value.replace(/\\/g, "/");
    const root = slash(cwd).replace(/\/+$/, "");
    const absolute = /^(?:[A-Za-z]:\/|\/)/.test(slash(requested))
      ? slash(requested)
      : `${root}/${slash(requested)}`;
    const drive = /^[A-Za-z]:/.exec(absolute)?.[0] ?? "";
    const segments: string[] = [];
    for (const segment of absolute.slice(drive.length).split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    const resolved = `${drive}/${segments.join("/")}`;
    const fold = (value: string) => (drive ? value.toLowerCase() : value);
    if (fold(resolved) !== fold(root) && !fold(resolved).startsWith(`${fold(root)}/`)) return null;
    return resolved;
  }

  function handleClientFileRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): boolean {
    if (method !== "fs/read_text_file" && method !== "fs/write_text_file") return false;
    // Grok and Antigravity must retain their native filesystem tools, including
    // binary reads, artifacts, and skill folders outside the workspace.
    if (agent === "grok" || agent === "antigravity") return false;
    const requested = asString(params.path);
    const path = requested ? resolveClientPath(ctx.cwd, requested) : null;
    if (!path) {
      ctx.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Path outside workspace." } });
      return true;
    }
    if (method === "fs/read_text_file") {
      if (!ctx.files) {
        ctx.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "File service unavailable." } });
        return true;
      }
      void ctx.files.readText(path)
        .then((file) => {
          if (file.binary || file.tooLarge) throw new Error("The file is not readable text.");
          const line = typeof params.line === "number" ? Math.max(1, Math.floor(params.line)) : 1;
          const limit = typeof params.limit === "number" ? Math.max(0, Math.floor(params.limit)) : null;
          const lines = file.content.split(/(?<=\n)/);
          const content = lines.slice(line - 1, limit === null ? undefined : line - 1 + limit).join("");
          ctx.send({ jsonrpc: "2.0", id, result: { content } });
        })
        .catch((error: unknown) =>
          ctx.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        );
    } else {
      const content = asString(params.content);
      if (content === null) {
        ctx.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing content." } });
        return true;
      }
      if (!ctx.files) {
        ctx.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "File service unavailable." } });
        return true;
      }
      void ctx.files.writeText(path, content)
        .then(() => ctx.send({ jsonrpc: "2.0", id, result: null }))
        .catch((error: unknown) =>
          ctx.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        );
    }
    return true;
  }

  async function handshake(ctx: AdapterContext) {
    try {
      const initialized = await request(ctx, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // Grok and Antigravity route read_file through this text-only service
          // when enabled, losing native image handling, large-file reads, and
          // access to skills and artifacts outside the workspace. Keep both
          // file operations native under their own permission policies. Other
          // ACP agents retain the workspace-scoped client file service.
          fs: {
            readTextFile: agent !== "grok" && agent !== "antigravity" && Boolean(ctx.files),
            writeTextFile: agent !== "grok" && agent !== "antigravity" && Boolean(ctx.files),
          },
          terminal: false,
        },
        clientInfo: { name: "duckweed", title: "Duckweed", version: "0.1.0" },
      });

      // Only agents that say they can load a session get a resume offer;
      // calling `session/load` on one that cannot is a hard JSON-RPC error.
      canLoadSession = asRecord(initialized.agentCapabilities)?.loadSession === true;

      const agentCapabilities = asRecord(initialized.agentCapabilities) ?? {};
      const promptCapabilities = asRecord(agentCapabilities.promptCapabilities) ?? {};
      // Older ACP agents omitted promptCapabilities while still accepting
      // images. An explicit false is authoritative; absence keeps the legacy
      // compatible path.
      supportsImages = promptCapabilities.image !== false;
      supportsEmbeddedContext = promptCapabilities.embeddedContext === true;
      const clientNeeds = asRecord(asRecord(initialized._meta)?.clientCapabilities);
      supportsTerminalClient = clientNeeds?.terminal === true;

      const meta = asRecord(initialized._meta);
      const identity = readModelState(meta?.modelState);
      const commands = readCommands(meta?.availableCommands);
      const richNativeAgent = agent === "grok" || agent === "antigravity";
      ctx.emit({
        type: "session",
        ...identity,
        ...(commands.length ? { commands } : {}),
        capabilities: {
          inputs: {
            text: true,
            image: supportsImages || supportsEmbeddedContext,
            file: supportsEmbeddedContext,
            embeddedContext: supportsEmbeddedContext,
            skill: richNativeAgent,
            appMention: false,
          },
          interactions: { approvals: true, questions: agent === "grok", forms: false, links: false },
          extensions: {
            skills: richNativeAgent,
            apps: false,
            plugins: richNativeAgent,
            mcp: true,
            hooks: richNativeAgent,
            workflows: richNativeAgent,
          },
          runtime: {
            backgroundTasks: richNativeAgent,
            terminals: richNativeAgent || supportsTerminalClient,
            worktrees: agent === "grok",
            checkpointing: agent === "grok",
            nativeFallback: true,
          },
        },
      });
      ctx.emit({ type: "extensions", extensions, loading: false, error: null });

      const session = await request(ctx, "session/new", {
        cwd: ctx.cwd,
        mcpServers: [],
      });
      sessionId = asString(session.sessionId);
      if (!sessionId) {
        fail(ctx, "The agent did not return a session id.");
        return;
      }
      const fromSession = {
        ...readModelState(session.models),
        ...readConfigOptions(session.configOptions),
      };
      const launchModeOverride =
        agent === "antigravity" &&
        ctx.launch.accessMode !== undefined &&
        ctx.launch.accessMode !== "default";
      const { accessMode: initialAccessMode, ...sessionWithoutInitialAccess } = fromSession;
      ctx.emit({
        type: "session",
        sessionId,
        ...(launchModeOverride ? sessionWithoutInitialAccess : fromSession),
      });

      antigravitySubagents?.start(ctx, sessionId);
      await applyLaunchSettings(ctx, initialAccessMode);
      ctx.emit({ type: "status", status: "idle" });
    } catch (error) {
      const record = asRecord(error);
      fail(ctx, asString(record?.message) ?? "The agent refused to start a session.");
    }
  }

  /** Honor `-m` / `--effort` / `--mode` typed at launch, over the protocol. */
  async function applyLaunchSettings(
    ctx: AdapterContext,
    fallbackAccessMode?: AgentAccessMode,
  ) {
    let requestedModel = ctx.launch.model;
    let requestedEffort = ctx.launch.effort;

    if (agent === "antigravity" && requestedModel) {
      const lowered = requestedModel.toLowerCase();
      const exact = availableModels.find((model) => model.id.toLowerCase() === lowered);
      if (exact) {
        requestedModel = exact.id;
      } else {
        const split = splitAntigravityModelEffort(requestedModel);
        if (split) {
          const base = availableModels.find(
            (model) => model.id.toLowerCase() === split.model.toLowerCase(),
          );
          if (base) {
            requestedModel = base.id;
            requestedEffort = requestedEffort ?? split.effort;
          }
        }
      }
    }

    if (requestedModel) {
      const model = requestedModel;
      await setModel(model, ctx).catch((error: unknown) => {
        const record = asRecord(error);
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Could not set model "${model}": ${asString(record?.message) ?? "rejected"}.`,
        });
      });
    }
    if (requestedEffort) {
      const effort = requestedEffort.toLowerCase();
      const efforts = availableModels.find((model) => model.id === currentModelId)?.efforts ?? [];
      if (!efforts.length && !usesConfigOptions) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: "This agent does not expose effort levels over its protocol.",
        });
      } else if (efforts.length && !efforts.includes(effort)) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown effort "${effort}". Pick ${efforts.join(", ")}.`,
        });
      } else {
        await setEffort(effort, ctx).catch((error: unknown) => {
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: `Could not set effort "${effort}": ${asString(record?.message) ?? "rejected"}.`,
          });
        });
      }
    }
    if (
      agent === "antigravity" &&
      ctx.launch.accessMode &&
      ctx.launch.accessMode !== "default"
    ) {
      const mode = ctx.launch.accessMode;
      await setAccessMode(mode, ctx).catch((error: unknown) => {
        const record = asRecord(error);
        ctx.emit({ type: "session", accessMode: fallbackAccessMode ?? "default" });
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Could not set mode "${mode}": ${asString(record?.message) ?? "rejected"}.`,
        });
      });
    }
  }

  /**
   * Emit the buffered replay of one past user turn.
   *
   * `session/load` replays a conversation as the same chunked updates a live
   * turn produces, so a single prompt can arrive as a dozen `user_message_chunk`
   * frames. Buffering them and flushing on the next non-user update keeps one
   * transcript row per message, and bumps the turn counter so the reply that
   * follows opens its own bubble instead of merging into the previous one.
   */
  function flushReplayedUser(ctx: AdapterContext) {
    if (!replayedUser) return;
    const text =
      ctx.launch.agent === "grok" ? visibleGrokReplayText(replayedUser) : replayedUser.trim();
    replayedUser = "";
    if (!text) return;
    turnSeq += 1;
    resetContentSegments();
    ctx.emit({ type: "user", text });
  }

  function beginReplay(ctx: AdapterContext) {
    replayStarted = true;
    antigravitySubagents?.reset();
    antigravityInvocations.clear();
    taskCalls.clear();
    backgroundTaskCalls.clear();
    openSyncTaskCalls.clear();
    grokTaskCallById.clear();
    activeGrokTasks.clear();
    ctx.emit({ type: "transcript" });
  }

  function handleSessionUpdate(params: Record<string, unknown>, ctx: AdapterContext) {
    const update = asRecord(params.update);
    if (!update) return;
    if (antigravitySubagents) {
      const expectedSessionId = resumeSessionId ?? sessionId;
      const updateSessionId = asString(params.sessionId);
      if (expectedSessionId && updateSessionId && expectedSessionId !== updateSessionId) return;
    }
    if (loading && !replayStarted) {
      // Keep the current conversation visible until the provider actually
      // starts replaying the selected one. A stalled or rejected load should
      // never erase a perfectly good transcript.
      beginReplay(ctx);
    }
    const kind = asString(update.sessionUpdate);

    if (kind === "user_message_chunk") {
      // Live ACP agents are allowed to echo the prompt back as user chunks.
      // The app has already emitted that prompt locally, so accepting the echo
      // would draw the same message twice (and advance `turnSeq` twice). Stored
      // session replay is the one case where no local prompt exists.
      if (loading) {
        const chunk = readContentText(update.content);
        // Grok emits its stored context records consecutively, without a
        // non-user update between them. A new wrapper is therefore also the
        // only reliable boundary between those messages. Ordinary prompt
        // chunks still concatenate exactly as ACP intends.
        if (
          ctx.launch.agent === "grok" &&
          replayedUser &&
          startsGrokReplayRecord(chunk)
        ) {
          flushReplayedUser(ctx);
        }
        replayedUser += chunk;
      }
      return;
    }
    if (loading) flushReplayedUser(ctx);

    switch (kind) {
      case "agent_message_chunk": {
        const text = readContentText(update.content);
        if (text) {
          if (goalResponsePending) {
            goalResponseText += text;
            const goal = goalAfterProviderText(currentGoal, goalResponseText);
            if (goal !== undefined) {
              currentGoal = goal;
              ctx.emit({ type: "goal", goal });
            }
          }
          turnHadContent = true;
          ctx.emit({ type: "assistant-delta", id: contentId("assistant", ctx), text });
        }
        return;
      }
      case "agent_thought_chunk": {
        const text = readContentText(update.content);
        if (text) {
          turnHadContent = true;
          ctx.emit({ type: "thinking-delta", id: contentId("thinking", ctx), text });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = asString(update.toolCallId);
        if (!callId) return;
        beginToolContentPhase(callId, ctx);
        turnHadContent = true;
        const meta = asRecord(update._meta);
        const rawTitle = asString(update.title);
        const title = rawTitle ? rawTitle.replace(/^File \/([A-Za-z]:\/)/, "File $1") : null;
        const rawToolName = asString(update.name) ?? readMetaToolName(meta);
        if (title) toolTitles.set(callId, title);
        const rawInput = asRecord(update.rawInput);
        const command = readCommandInput(rawInput);
        const status = asString(update.status);
        const { text: contentText, changes } = readToolContent(asArray(update.content));
        const rawOutputText = readRawOutputText(update.rawOutput);
        const text = contentText || rawOutputText;
        const outputThreadId = readMetaThreadId(meta, update.rawOutput);
        const outputInterrupted =
          asRecord(update.rawOutput)?.interrupted === true || meta?.interrupted === true;
        const name = title ?? toolTitles.get(callId) ?? rawToolName ?? "tool";
        const kindName = rawToolName ?? name;
        const acpKind = asString(update.kind);
        const inputTodoSteps = readTodoSteps(rawInput);
        const outputTodoSteps = text ? readTodoSteps(text) : null;
        const todoSteps = inputTodoSteps ?? outputTodoSteps;
        const isTodo =
          todoCalls.has(callId) ||
          isTodoToolTitle(kindName) ||
          (rawInput !== null && Array.isArray(rawInput.todos));
        if (isTodo) {
          todoCalls.add(callId);
          if (todoSteps) ctx.emit({ type: "plan", planType: "tasks", steps: todoSteps });
          return;
        }
        const taskMeta = readSubagentMeta(title, rawInput, rawToolName);
        if (taskMeta || toolKind(kindName, acpKind) === "task") taskCalls.add(callId);
        const isTask = taskCalls.has(callId);
        const inputTaskId = asString(rawInput?.task_id) ?? asString(rawInput?.taskId);
        if (isTask && inputTaskId) grokTaskCallById.set(inputTaskId, callId);
        const explicitAsyncInput =
          rawInput?.run_in_background === true || rawInput?.background === true;
        const launched =
          isTask &&
          (/Async agent launched successfully|Agent launched in background/i.test(text) ||
            (explicitAsyncInput &&
              status === "completed" &&
              (!text || /\b(?:launched|started|background|task[_ ]?id)\b/i.test(text))));
        if (launched) backgroundTaskCalls.add(callId);
        const waitingForResult =
          backgroundTaskCalls.has(callId) &&
          status !== "failed" &&
          !outputInterrupted &&
          (!text || launched);
        if (
          backgroundTaskCalls.has(callId) &&
          !waitingForResult &&
          (status === "completed" || status === "failed" || outputInterrupted)
        ) {
          backgroundTaskCalls.delete(callId);
        }
        const activity = isTask
          ? waitingForResult
            ? "Working"
            : outputInterrupted
              ? "Delegated work stopped"
              : text
                ? lastLine(text)
                : null
          : null;
        let toolStatus = outputInterrupted
          ? ("error" as const)
          : status && ACP_STATUS[status]
            ? waitingForResult
              ? ("running" as const)
              : ACP_STATUS[status]
            : undefined;
        let output = text;
        let childPatch: SubagentMeta | undefined;
        if (
          antigravitySubagents &&
          isAntigravityInvokeCall(agent, rawToolName, title, rawInput) &&
          !antigravityInvocations.has(callId)
        ) {
          antigravityInvocations.set(callId, false);
        }
        if (antigravitySubagents && antigravityInvocations.has(callId)) {
          const launchOnly =
            !text ||
            launched ||
            text.includes("Created the following subagent:") ||
            /subagent.*launched|started.*subagent/i.test(text);
          if (status === "completed" && launchOnly) {
            if (antigravityInvocations.get(callId)) return;
            antigravityInvocations.set(callId, true);
            const tracking = antigravitySubagents.track(callId, ctx);
            toolStatus = tracking.status;
            childPatch = tracking.subagent;
            output = "";
          } else if (status === "failed" || status === "completed") {
            antigravitySubagents.untrack(callId);
            childPatch = {
              statusUnavailable: false,
              activity:
                activity ??
                (status === "failed"
                  ? "Delegation failed"
                  : "Delegated work completed"),
            };
          }
        }
        // Re-engage Antigravity DB tracking if the parent messages a finished child
        // or immediately poll when manage_subagents kills one.
        if (antigravitySubagents) {
          const recipient = asString(rawInput?.Recipient);
          const isSendMessage =
            rawToolName === "send_message" ||
            (title !== null && /\bsend_message\b/i.test(title)) ||
            Boolean(recipient && rawInput?.Message !== undefined);
          if (isSendMessage && recipient) {
            const targetCallId = antigravitySubagents.callIdForThread(recipient);
            if (targetCallId) {
              antigravitySubagents.retrack(targetCallId, ctx);
              ctx.emit({
                type: "tool",
                callId: targetCallId,
                status: "running",
                subagent: { activity: "Working", statusUnavailable: false },
              });
            }
          }
          const isManageSubagents =
            rawToolName === "manage_subagents" ||
            (title !== null && /\bmanage_subagents\b/i.test(title));
          if (isManageSubagents && (status === "completed" || status === "failed")) {
            antigravitySubagents.pollNow();
          }
        }
        // Grok's KillTask immediately terminates a background task/subagent.
        if (
          (rawToolName?.toLowerCase() === "killtask" || title?.toLowerCase() === "killtask") &&
          status === "completed" &&
          inputTaskId
        ) {
          activeGrokTasks.delete(inputTaskId);
          const existingTask = runtimeTasks.get(inputTaskId);
          if (existingTask) {
            runtimeTasks.set(inputTaskId, { ...existingTask, status: "stopped" });
            ctx.emit({ type: "runtime-tasks", tasks: [...runtimeTasks.values()] });
          }
          const killedCallId = grokTaskCallById.get(inputTaskId);
          if (killedCallId) {
            backgroundTaskCalls.delete(killedCallId);
            openSyncTaskCalls.delete(killedCallId);
            ctx.emit({
              type: "tool",
              callId: killedCallId,
              status: "error",
              ...(taskCalls.has(killedCallId)
                ? { subagent: { activity: "Delegated work stopped" } }
                : {}),
            });
          }
        }
        if (isTask) {
          const isAsyncTracked =
            backgroundTaskCalls.has(callId) || antigravityInvocations.has(callId);
          const settledStatus = toolStatus === "done" || toolStatus === "error";
          if (isAsyncTracked || settledStatus) {
            openSyncTaskCalls.delete(callId);
          } else if (kind === "tool_call" || toolStatus === "running" || toolStatus === "pending") {
            openSyncTaskCalls.add(callId);
          }
        }
        ctx.emit({
          type: "tool",
          callId,
          // A `tool_call_update` carries only what changed. Re-deriving the
          // family from a frame that omits `kind` would downgrade a known
          // tool to "other" halfway through the call.
          ...(title ? { name: oneLine(name, 40) } : rawToolName ? { name: oneLine(rawToolName, 40) } : {}),
          ...(isTask
            ? { tool: "task" as const }
            : acpKind || rawToolName
              ? { tool: toolKind(kindName, acpKind) }
              : {}),
          ...(title ? { title: oneLine(title) } : {}),
          ...(toolStatus ? { status: toolStatus } : {}),
          ...(command ? { command } : {}),
          ...(output ? { output } : {}),
          ...(changes.length ? { changes } : {}),
          ...(isTask
            ? {
                subagent: {
                  ...taskMeta,
                  ...(outputThreadId ? { threadId: outputThreadId } : {}),
                  ...(inputTaskId ? { taskId: inputTaskId } : {}),
                  ...(activity ? { activity: oneLine(activity) } : {}),
                  ...childPatch,
                },
              }
            : {}),
        });
        return;
      }
      case "task_backgrounded": {
        const taskId = asString(update.task_id) ?? asString(update.taskId);
        const toolCallId = asString(update.tool_call_id) ?? asString(update.toolCallId);
        const description =
          asString(update.description) ??
          asString(update.monitor_description) ??
          asString(update.command) ??
          "Background task";
        if (taskId) {
          activeGrokTasks.add(taskId);
          if (toolCallId) grokTaskCallById.set(taskId, toolCallId);
          runtimeTasks.set(taskId, {
            id: taskId,
            kind: "task",
            title: oneLine(description, 80),
            status: "running",
          });
          ctx.emit({ type: "runtime-tasks", tasks: [...runtimeTasks.values()] });
        }
        if (toolCallId && taskCalls.has(toolCallId)) {
          backgroundTaskCalls.add(toolCallId);
          openSyncTaskCalls.delete(toolCallId);
          ctx.emit({
            type: "tool",
            callId: toolCallId,
            status: "running",
            subagent: {
              ...(taskId ? { taskId } : {}),
              activity: oneLine(description, 120),
            },
          });
        }
        return;
      }
      case "task_completed": {
        const snapshot = asRecord(update.task_snapshot) ?? update;
        const taskId = asString(snapshot.task_id) ?? asString(snapshot.taskId);
        const rawStatus = asString(snapshot.status)?.toLowerCase() ?? "";
        const exitCode = asNumber(snapshot.exit_code);
        const explicitlyKilled = snapshot.explicitly_killed === true;
        const signal = asString(snapshot.signal);
        const failed =
          explicitlyKilled ||
          Boolean(signal) ||
          (exitCode !== null && exitCode !== 0) ||
          rawStatus === "failed" ||
          rawStatus === "error";
        const output = asString(snapshot.output) ?? "";
        const description =
          asString(snapshot.description) ?? asString(snapshot.command) ?? "";
        if (taskId) {
          activeGrokTasks.delete(taskId);
          const existing = runtimeTasks.get(taskId);
          runtimeTasks.set(taskId, {
            id: taskId,
            kind: existing?.kind ?? "task",
            title: existing?.title ?? (description ? oneLine(description, 80) : "Background task"),
            status: explicitlyKilled ? "stopped" : failed ? "error" : "done",
          });
          ctx.emit({ type: "runtime-tasks", tasks: [...runtimeTasks.values()] });
          const targetCallId = grokTaskCallById.get(taskId);
          if (targetCallId) {
            backgroundTaskCalls.delete(targetCallId);
            openSyncTaskCalls.delete(targetCallId);
            ctx.emit({
              type: "tool",
              callId: targetCallId,
              status: failed ? "error" : "done",
              ...(output ? { output } : {}),
              ...(taskCalls.has(targetCallId)
                ? {
                    subagent: {
                      activity: explicitlyKilled
                        ? "Delegated work stopped"
                        : failed
                          ? "Delegated work failed"
                          : output.trim()
                            ? oneLine(lastLine(output) ?? output)
                            : "Delegated work completed",
                    },
                  }
                : {}),
            });
          }
        }
        if (!loading && update.will_wake === false) {
          finishTurnWhenReady(ctx);
        }
        return;
      }
      case "background_tasks": {
        const tasks = asArray(update.tasks)
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null);
        const stillRunning = new Set<string>();
        for (const task of tasks) {
          const taskId = asString(task.task_id) ?? asString(task.taskId);
          if (!taskId) continue;
          const rawStatus = asString(task.status)?.toLowerCase() ?? "running";
          const signal = asString(task.signal);
          const exitCode = asNumber(task.exit_code);
          const isRunning = rawStatus === "running" || rawStatus === "pending" || rawStatus === "in_progress";
          const failed =
            rawStatus === "failed" ||
            rawStatus === "error" ||
            Boolean(signal) ||
            (exitCode !== null && exitCode !== 0);
          const description =
            asString(task.description) ?? asString(task.command) ?? "Background task";
          if (isRunning) stillRunning.add(taskId);
          runtimeTasks.set(taskId, {
            id: taskId,
            kind: "task",
            title: oneLine(description, 80),
            status: isRunning
              ? "running"
              : signal === "killed"
                ? "stopped"
                : failed
                  ? "error"
                  : "done",
          });
          const targetCallId = grokTaskCallById.get(taskId);
          if (targetCallId && !isRunning && backgroundTaskCalls.has(targetCallId)) {
            backgroundTaskCalls.delete(targetCallId);
            openSyncTaskCalls.delete(targetCallId);
            ctx.emit({
              type: "tool",
              callId: targetCallId,
              status: failed ? "error" : "done",
              ...(taskCalls.has(targetCallId)
                ? {
                    subagent: {
                      activity:
                        signal === "killed"
                          ? "Delegated work stopped"
                          : failed
                            ? "Delegated work failed"
                            : "Delegated work completed",
                    },
                  }
                : {}),
            });
          }
        }
        for (const taskId of [...activeGrokTasks]) {
          if (!stillRunning.has(taskId)) activeGrokTasks.delete(taskId);
        }
        for (const taskId of stillRunning) activeGrokTasks.add(taskId);
        ctx.emit({ type: "runtime-tasks", tasks: [...runtimeTasks.values()] });
        return;
      }
      case "plan": {
        const steps = asArray(update.entries)
          .map((raw) => asRecord(raw))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
          .map((entry) => ({
            text: asString(entry.content) ?? asString(entry.step) ?? "",
            status:
              entry.status === "completed"
                ? ("done" as const)
                : entry.status === "in_progress"
                  ? ("running" as const)
                  : ("pending" as const),
          }))
          .filter((step) => step.text);
        if (steps.length) ctx.emit({ type: "plan", planType: "tasks", steps });
        return;
      }
      case "workflow_updated": {
        // Grok Build publishes background workflow state on
        // `_x.ai/session/update`, not ACP's standard plan notification. Lift
        // its phase rail into the shared workflow dock and keep the turn busy
        // after the foreground request has returned.
        const workflowStatus = asString(update.status)?.toLowerCase() ?? "";
        const id = workflowId(update);
        if (!loading) {
          if (workflowIsTerminal(workflowStatus)) {
            if (id === "grok-workflow") activeWorkflows.clear();
            else activeWorkflows.delete(id);
          } else {
            activeWorkflows.add(id);
          }
        }
        const steps = readWorkflowSteps(update);
        const runtimeStatus: AgentRuntimeTask["status"] = workflowIsTerminal(workflowStatus)
          ? workflowStatus === "failed" || workflowStatus === "error"
            ? "error"
            : "done"
          : workflowStatus === "blocked"
            ? "blocked"
            : "running";
        runtimeTasks.set(id, {
          id,
          kind: "workflow",
          title: asString(update.title) ?? asString(update.name) ?? "Grok workflow",
          status: runtimeStatus,
          detail: steps.length ? `${steps.filter((step) => step.status === "done").length}/${steps.length} phases` : undefined,
        });
        ctx.emit({ type: "runtime-tasks", tasks: [...runtimeTasks.values()] });
        if (steps.length) {
          turnHadContent = true;
          ctx.emit({ type: "plan", planType: "workflow", steps });
        }
        if (!loading && workflowIsTerminal(workflowStatus)) {
          finishTurnWhenReady(ctx);
        }
        return;
      }
      case "available_commands_update": {
        const commands = readCommands(update.availableCommands);
        if (commands.length) {
          ctx.emit({ type: "session", commands });
          ctx.emit({
            type: "extensions",
            extensions: extensions.map((extension) => ({ ...extension })),
            loading: false,
            error: null,
          });
        }
        return;
      }
      case "current_mode_update": {
        if (agent === "antigravity") {
          const modeId = asString(update.currentModeId);
          const accessMode = modeId ? resolveAntigravityAccessMode(modeId) : null;
          if (accessMode) ctx.emit({ type: "session", accessMode });
        }
        return;
      }
      case "usage_update": {
        const used = asNumber(update.used);
        const size = asNumber(update.size);
        if (used !== null && size !== null && size > 0 && used >= 0) {
          ctx.emit({
            type: "usage",
            usage: { contextUsed: Math.min(1, Math.max(0, used / size)) },
          });
        }
        return;
      }
      case "model_changed": {
        const model = asString(update.model_id) ?? asString(update.modelId);
        const effort =
          asString(update.reasoning_effort) ?? asString(update.reasoningEffort);
        if (model) currentModelId = model;
        if (effort) currentEffort = effort;
        if (model || effort) {
          ctx.emit({
            type: "session",
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
        }
        return;
      }
      case "config_option_update": {
        applyConfigResult(
          {
            configOptions: update.configOptions ?? params.configOptions ?? update.options,
          },
          ctx,
        );
        return;
      }
      default:
        return;
    }
  }

  /** The agent asking permission to act. */
  function handlePermissionRequest(
    id: string | number,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ) {
    if (agent === "antigravity" && fullAccessBypass) {
      const rawOptions = asArray(params.options)
        .map((raw) => asRecord(raw))
        .filter((option): option is Record<string, unknown> => option !== null)
        .filter((option) => Boolean(asString(option.optionId)));
      const allowOption =
        rawOptions.find((option) => asString(option.kind) === "allow_once") ??
        rawOptions.find((option) => asString(option.kind) === "allow_always");
      const optionId =
        asString(allowOption?.optionId) ?? (rawOptions.length === 0 ? "allow" : null);
      if (optionId) {
        ctx.send({
          jsonrpc: "2.0",
          id,
          result: { outcome: { outcome: "selected", optionId } },
        });
        return;
      }
    }

    const toolCall = asRecord(params.toolCall);
    const title = asString(toolCall?.title) ?? "The agent wants to act";
    const rawInput = asRecord(toolCall?.rawInput);
    const { changes } = readToolContent(asArray(toolCall?.content));
    const permissionId = `perm-${String(id)}`;
    permissionRequests.set(permissionId, id);

    const options = asArray(params.options)
      .map((raw) => asRecord(raw))
      .filter((option): option is Record<string, unknown> => option !== null)
      .map((option) => {
        const kind = asString(option.kind) ?? "";
        return {
          id: asString(option.optionId) ?? "",
          label: asString(option.name) ?? kind,
          kind:
            kind === "allow_always"
              ? ("allow-always" as const)
              : kind === "reject_once"
                ? ("reject" as const)
                : kind === "reject_always"
                  ? ("reject-always" as const)
                  : ("allow" as const),
        };
      })
      .filter((option) => option.id);

    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        title: oneLine(title),
        detail: null,
        command: readCommandInput(rawInput),
        changes,
        options: options.length
          ? options
          : [
              { id: "allow", label: "Allow", kind: "allow" },
              { id: "reject", label: "Reject", kind: "reject" },
            ],
      },
    });
  }

  function handleQuestionRequest(
    id: string | number,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
    const permissionId = `question-${String(id)}`;
    questionRequests.set(permissionId, id);
    const rawQuestions = asArray(params.questions);
    const source = rawQuestions.length ? rawQuestions : [params];
    const questions = source
      .map((raw) => asRecord(raw))
      .filter((question): question is Record<string, unknown> => question !== null)
      .map((question, index) => ({
        id: asString(question.id) ?? `question-${index}`,
        header: asString(question.header) ?? "Grok needs input",
        question:
          asString(question.question) ?? asString(question.prompt) ?? asString(question.message) ?? "What should Grok do?",
        multiSelect: question.multiSelect === true || question.multi_select === true,
        inputKind: question.isSecret === true ? ("secret" as const) : undefined,
        required: true,
        options: asArray(question.options)
          .map((raw, optionIndex) => {
            const option = asRecord(raw);
            const label = asString(option?.label) ?? asString(option?.name) ?? asString(raw);
            return label
              ? {
                  id: asString(option?.id) ?? asString(option?.value) ?? `${optionIndex}`,
                  label,
                  description: asString(option?.description) ?? "",
                  preview: null,
                }
              : null;
          })
          .filter((option): option is NonNullable<typeof option> => option !== null),
      }));
    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        kind: "question",
        title: "Grok needs input",
        detail: null,
        command: null,
        changes: [],
        options: [],
        questions,
      },
    });
  }

  /**
   * What the user most likely meant by `/model <arg>`: an exact id wins,
   * then the provider suffix (`haiku` → `opencode/claude-haiku-4-5`), then a
   * single unambiguous substring.
   */
  function resolveModel(arg: string): AcpModel | "ambiguous" | null {
    const lower = arg.toLowerCase();
    const exact = availableModels.find((model) => model.id.toLowerCase() === lower);
    if (exact) return exact;
    const suffix = availableModels.filter((model) => model.id.toLowerCase().endsWith(`/${lower}`));
    if (suffix.length === 1) return suffix[0];
    const partial = availableModels.filter(
      (model) => model.id.toLowerCase().includes(lower) || model.name.toLowerCase() === lower,
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1 || suffix.length > 1) return "ambiguous";
    if (agent === "antigravity") {
      const split = splitAntigravityModelEffort(arg);
      if (split) {
        const base = availableModels.find(
          (model) => model.id.toLowerCase() === split.model.toLowerCase(),
        );
        if (base) return base;
      }
    }
    return null;
  }

  /** `/model` and `/effort` over RPC; advertised names pass through. */
  function handleCommand(text: string, ctx: AdapterContext): "handled" | "prompt" {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : text.slice(space + 1).trim();

    // Advertised commands are the agent's own — it intercepts them when they
    // come back as prompt text (verified: instant, zero tokens).
    if (advertised.has(name.slice(1))) {
      if (name === "/goal") {
        goalBeforeCommand = currentGoal;
        goalResponsePending = true;
        goalResponseText = "";
        const goal = goalAfterCommand(currentGoal, text);
        if (goal !== undefined) {
          currentGoal = goal;
          ctx.emit({ type: "goal", goal });
        }
      }
      return "prompt";
    }

    ctx.emit({ type: "user", text });

    if (name === "/model") {
      if (!arg) {
        const sample = availableModels.slice(0, 8).map((model) => model.id);
        const more =
          availableModels.length > sample.length ? `, and ${availableModels.length - sample.length} more` : "";
        ctx.emit({
          type: "notice",
          tone: "info",
          text: availableModels.length
            ? `Model: ${currentModelId ?? "default"}. Available: ${sample.join(", ")}${more}.`
            : `Model: ${currentModelId ?? "default"}.`,
        });
        return "handled";
      }
      const match = resolveModel(arg);
      if (match === "ambiguous") {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `"${arg}" matches more than one model. Give the full provider/model id.`,
        });
        return "handled";
      }
      if (match === null && availableModels.length) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown model "${arg}". Try /model to list what is available.`,
        });
        return "handled";
      }
      const modelId = match === null ? arg : match.id;
      if (!sessionId) return "handled";
      void setModel(modelId, ctx)
        .then(() => {
          ctx.emit({ type: "notice", tone: "info", text: `Model set to ${modelId}.` });
        })
        .catch((error: unknown) => {
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? `The agent refused model "${modelId}".`,
          });
        });
      return "handled";
    }

    if (name === "/effort") {
      const efforts = availableModels.find((model) => model.id === currentModelId)?.efforts ?? [];
      if (!efforts.length) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: "This model does not expose effort levels over its protocol.",
        });
        return "handled";
      }
      if (!arg) {
        ctx.emit({
          type: "notice",
          tone: "info",
          text: `Effort: ${currentEffort ?? "default"}. ${currentModelId ?? "This model"} supports: ${efforts.join(", ")}.`,
        });
        return "handled";
      }
      const level = arg.toLowerCase();
      if (!efforts.includes(level)) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown effort "${arg}". Pick ${efforts.join(", ")}.`,
        });
        return "handled";
      }
      if (!sessionId) return "handled";
      void setEffort(level, ctx)
        .then(() => {
          ctx.emit({ type: "notice", tone: "info", text: `Effort set to ${level}.` });
        })
        .catch((error: unknown) => {
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? `The agent refused effort "${level}".`,
          });
        });
      return "handled";
    }

    ctx.emit({
      type: "notice",
      tone: "error",
      text: `Unknown command ${name}. It is not in this agent's command list.`,
    });
    return "handled";
  }

  function promptContent(prompt: AgentPrompt) {
    const providerText = promptTextWithLocalSkills(prompt);
    // Grok currently declines ACP image blocks but accepts the same binary
    // payload as embedded context. Keep the native block for agents that
    // advertise it, then fall back to ACP's resource representation.
    const imageContent = supportsImages
      ? prompt.images.map((image) => ({
          type: "image",
          data: imagePayloadBase64(image),
          mimeType: image.mimeType,
        }))
      : supportsEmbeddedContext
        ? prompt.images.map((image) => ({
            type: "resource",
            resource: {
              uri: `attachment://duckweed/${encodeURIComponent(image.id)}/${encodeURIComponent(image.name)}`,
              blob: imagePayloadBase64(image),
              mimeType: image.mimeType,
            },
          }))
        : [];
    return [
      ...(providerText ? [{ type: "text", text: providerText }] : []),
      ...imageContent,
      ...(supportsEmbeddedContext
        ? (prompt.parts ?? []).flatMap((part) => {
            if (part.type === "file") {
              return [{ type: "resource_link", uri: part.path, name: part.name ?? part.path }];
            }
            if (part.type === "resource") {
              return [
                {
                  type: "resource_link",
                  uri: part.uri,
                  name: part.name ?? part.uri,
                  ...(part.mimeType ? { mimeType: part.mimeType } : {}),
                },
              ];
            }
            return [];
          })
        : []),
    ];
  }

  /**
   * Grok's mid-turn inject is `_x.ai/interject`. The original `session/prompt`
   * stays open and still owns turn completion. A missing method (`-32601`)
   * or any other RPC failure returns false so the session can restore the
   * follow-up into the local queue. Do not `session/cancel`.
   */
  async function steerGrokTurn(prompt: AgentPrompt, ctx: AdapterContext): Promise<boolean> {
    if (agent !== "grok" || ctx.launch.agent !== "grok" || !sessionId || !turnOpen) {
      return false;
    }
    const content = promptContent(prompt);
    try {
      await request(ctx, "_x.ai/interject", {
        sessionId,
        text: prompt.text,
        ...(content.length ? { content } : {}),
      });
    } catch {
      return false;
    }
    ctx.emit({
      type: "user",
      text: prompt.text,
      images: prompt.images,
      sameTurn: true,
    });
    return true;
  }

  function sendPrompt(prompt: AgentPrompt, ctx: AdapterContext, sameTurn = false): void {
    if (!sessionId) return;
    stopAntigravityActivityWatch();
    pendingTurnPrompts += 1;
    if (sameTurn) {
      closeActiveContent(ctx);
      contentPhase += 1;
      slashPending = false;
    } else {
      turnSeq += 1;
      resetContentSegments();
      turnOpen = true;
      slashPending = prompt.text.startsWith("/");
      turnHadContent = false;
      // Claim the turn before emitting events that could release the next queued prompt.
      ctx.emit({ type: "status", status: "working" });
    }
    if (prompt.images.length && !supportsImages && !supportsEmbeddedContext) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: `${ctx.launch.program} does not accept image input over ACP. The text and supported context were sent without the image.`,
      });
    }
    ctx.emit({
      type: "user",
      text: prompt.text,
      images: prompt.images,
      ...(sameTurn ? { sameTurn: true } : {}),
    });
    void request(ctx, "session/prompt", {
      sessionId,
      prompt: promptContent(prompt),
    })
      .then((result) => {
        const usage = asRecord(result.usage);
        const input = asNumber(usage?.inputTokens);
        const output = asNumber(usage?.outputTokens);
        if (input !== null || output !== null) {
          if (input !== null && input > 0) totalInputTokens += input;
          if (output !== null && output > 0) totalOutputTokens += output;
          ctx.emit({
            type: "usage",
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            },
          });
        }
        pendingTurnPrompts -= 1;
        if (pendingTurnPrompts > 0) return;
        const stop = asString(result.stopReason);
        if (stop === "refusal") {
          if (goalResponsePending) {
            currentGoal = goalBeforeCommand;
            ctx.emit({ type: "goal", goal: currentGoal });
          }
          ctx.emit({ type: "notice", tone: "error", text: "The agent refused the request." });
        } else if (slashPending && !turnHadContent) {
          ctx.emit({
            type: "notice",
            tone: "info",
            text: `Ran ${oneLine(prompt.text.split(/\s/)[0], 40)}. This agent does not return its output to the custom UI.`,
          });
        }
        slashPending = false;
        goalResponsePending = false;
        goalResponseText = "";
        const force = stop === "refusal" || stop === "cancelled" || stop === "canceled";
        if (force || !watchAntigravityActivity(ctx)) finishTurnWhenReady(ctx, force);
      }, (error: unknown) => {
        pendingTurnPrompts -= 1;
        const record = asRecord(error);
        ctx.emit({
          type: "notice",
          tone: "error",
          text: asString(record?.message) ?? (sameTurn ? "Steering failed." : "The turn failed."),
        });
        if (pendingTurnPrompts > 0) return;
        slashPending = false;
        if (goalResponsePending) {
          currentGoal = goalBeforeCommand;
          ctx.emit({ type: "goal", goal: currentGoal });
        }
        goalResponsePending = false;
        goalResponseText = "";
        finishTurnWhenReady(ctx, true);
      });
  }

  return {
    // ACP carries model and session choices in its protocol, so nothing the
    // user typed becomes a command-line flag here.
    args: (_launch: AgentLaunch) => [],

    start: (ctx) => {
      void handshake(ctx);
    },

    receive: (line, ctx) => {
      const frame = parseJson(line);
      if (!frame) return;

      // A response to something we asked for.
      if (frame.id !== undefined && frame.method === undefined) {
        const id = typeof frame.id === "number" ? frame.id : Number(frame.id);
        const waiting = pending.get(id);
        if (!waiting) return;
        pending.delete(id);
        const error = asRecord(frame.error);
        if (error) waiting.reject(error);
        else waiting.resolve(asRecord(frame.result) ?? {});
        return;
      }

      const method = asString(frame.method);
      if (!method) return;
      const params = asRecord(frame.params) ?? {};

      // A request from the agent: it expects a result under the same id.
      if (frame.id !== undefined) {
        const id = frame.id as string | number;
        if (method === "session/request_permission") {
          handlePermissionRequest(id, params, ctx);
          return;
        }
        if (method === "_x.ai/ask_user_question" || method === "session/request_input") {
          handleQuestionRequest(id, params, ctx);
          return;
        }
        if (method === "_x.ai/exit_plan_mode") {
          handleQuestionRequest(
            id,
            {
              header: "Plan ready",
              question: asString(params.message) ?? "Approve this plan and begin implementation?",
              options: [
                { id: "approve", label: "Approve", description: "Begin implementation" },
                { id: "revise", label: "Revise", description: "Keep planning" },
              ],
            },
            ctx,
          );
          return;
        }
        if (handleClientFileRequest(id, method, params, ctx)) return;
        // Everything else is a capability we declared we do not have.
        ctx.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Duckweed does not implement ${method}` },
        });
        return;
      }

      if (
        method === "session/update" ||
        method === "_x.ai/session/update" ||
        method === "_x.ai/session_notification"
      ) {
        handleSessionUpdate(params, ctx);
        return;
      }
      if (method === "_x.ai/models/update") {
        // Catalog refresh. `_meta.reasoningEffort` here is the model's default,
        // not the live session effort — keep the current chip as the user set it.
        const update = readModelState(params, { sessionEffort: false });
        if (Object.keys(update).length) ctx.emit({ type: "session", ...update });
        return;
      }
      if (method === "_x.ai/mcp/servers_updated") {
        const rows = asArray(params.servers ?? params.mcpServers)
          .map((raw) => asRecord(raw))
          .filter((row): row is Record<string, unknown> => row !== null)
          .map((row) => ({
            id: `mcp:${asString(row.id) ?? asString(row.name) ?? "server"}`,
            kind: "mcp" as const,
            name: asString(row.name) ?? asString(row.id) ?? "MCP server",
            description: asString(row.description) ?? "",
            enabled: row.enabled !== false,
            callable: false,
            status: row.error ? ("error" as const) : row.enabled === false ? ("disabled" as const) : ("ready" as const),
            source: "grok",
          }));
        extensions = [...extensions.filter((extension) => extension.kind !== "mcp"), ...rows];
        ctx.emit({ type: "extensions", extensions, loading: false, error: null });
      }
    },

    prompt: sendPrompt,

    ...(agent === "grok" ? { steer: steerGrokTurn } : {}),

    ...(agent === "antigravity"
      ? {
          steer: (prompt: AgentPrompt, ctx: AdapterContext) => {
            if (!sessionId || !turnOpen || loading) return false;
            sendPrompt(prompt, ctx, true);
            return true;
          },
          configureAccess: async (mode: AgentAccessMode, ctx: AdapterContext) => {
            if (!sessionId) return false;
            await setAccessMode(mode, ctx);
            return true;
          },
        }
      : {}),

    command: handleCommand,

    configure: async (kind, value, ctx) => {
      if (kind === "model") {
        const match = resolveModel(value);
        if (match === "ambiguous") throw new Error(`"${value}" matches more than one model.`);
        if (match === null && availableModels.length) {
          throw new Error(`Unknown model "${value}".`);
        }
        const modelId = match === null ? value : match.id;
        await setModel(modelId, ctx);
        ctx.emit({ type: "notice", tone: "info", text: `Model set to ${modelId}.` });
        return true;
      }

      const efforts = availableModels.find((model) => model.id === currentModelId)?.efforts ?? [];
      const level = value.toLowerCase();
      if (efforts.length && !efforts.includes(level)) {
        throw new Error(`${currentModelId ?? "This model"} does not take "${value}" effort.`);
      }
      await setEffort(level, ctx);
      ctx.emit({ type: "notice", tone: "info", text: `Effort set to ${level}.` });
      return true;
    },

    /**
     * ACP's own resume: the agent adopts the stored session and replays it as
     * `session/update` notifications, which the handler above turns into the
     * same timeline rows a live turn produces. The conversation therefore
     * comes back with its history, not just its id.
     */
    resume: (id, ctx) => {
      if (!canLoadSession) return false;
      stopAntigravityActivityWatch();
      totalInputTokens = 0;
      totalOutputTokens = 0;
      currentGoal = null;
      goalBeforeCommand = null;
      goalResponsePending = false;
      goalResponseText = "";
      antigravitySubagents?.pause();
      resumeSessionId = id;
      loading = true;
      replayStarted = false;
      replayedUser = "";
      ctx.emit({ type: "status", status: "working" });
      const requestId = nextId++;
      resumeRequestId = requestId;
      const loadingRequest = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        ctx.send({
          jsonrpc: "2.0",
          id: requestId,
          method: "session/load",
          params: { sessionId: id, cwd: ctx.cwd, mcpServers: [] },
        });
      });
      return loadingRequest
        .then((result) => {
          sessionId = id;
          // A valid session may have no visible messages. Clear the previous
          // transcript only after the load itself has succeeded.
          if (!replayStarted) {
            beginReplay(ctx);
          }
          flushReplayedUser(ctx);
          const identity = {
            ...readModelState(result.models),
            ...readConfigOptions(result.configOptions),
          };
          ctx.emit({ type: "session", sessionId: id, ...identity });
          ctx.emit({ type: "turn-end", historyReplay: true });
          return true;
        })
        .catch((error: unknown) => {
          const record = asRecord(error);
          flushReplayedUser(ctx);
          if (asString(record?.code) !== RESUME_CANCELLED) {
            ctx.emit({
              type: "notice",
              tone: "error",
              text: asString(record?.message) ?? "The agent could not load that session.",
            });
          }
          ctx.emit({ type: "turn-end", historyReplay: true });
          return false;
        })
        .finally(() => {
          if (resumeRequestId === requestId) resumeRequestId = null;
          resumeSessionId = null;
          loading = false;
          replayStarted = false;
          if (sessionId) antigravitySubagents?.start(ctx, sessionId);
        });
    },

    interrupt: (ctx) => {
      if (resumeRequestId !== null) {
        const requestId = resumeRequestId;
        resumeRequestId = null;
        const inFlight = pending.get(requestId);
        pending.delete(requestId);
        inFlight?.reject({ code: RESUME_CANCELLED });
        notify(ctx, "$/cancelRequest", { id: requestId });
        return;
      }
      if (!sessionId || loading) return;
      notify(ctx, "session/cancel", { sessionId });
    },

    respond: (permissionId, optionId, ctx) => {
      const id = permissionRequests.get(permissionId);
      if (id === undefined) {
        const questionId = questionRequests.get(permissionId);
        if (questionId === undefined) return;
        questionRequests.delete(permissionId);
        ctx.send({ jsonrpc: "2.0", id: questionId, result: { outcome: "cancelled" } });
        ctx.emit({ type: "permission", permission: null });
        ctx.emit({ type: "status", status: "working" });
        return;
      }
      permissionRequests.delete(permissionId);
      ctx.send({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "selected", optionId } },
      });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },
    answer: (permissionId, answers: AgentQuestionAnswer[], ctx) => {
      const id = questionRequests.get(permissionId);
      if (id === undefined) return;
      questionRequests.delete(permissionId);
      const answerMap = Object.fromEntries(
        answers.map((answer) => [
          answer.questionId,
          answer.custom ?? (answer.labels.length > 1 ? answer.labels : answer.labels[0] ?? ""),
        ]),
      );
      ctx.send({ jsonrpc: "2.0", id, result: { answers: answerMap } });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },
    ...(antigravitySubagents ? {
      dispose: (ctx: AdapterContext) => {
        disposed = true;
        stopAntigravityActivityWatch();
        antigravitySubagents.dispose(ctx);
      },
    } : {}),
    refreshExtensions: () => extensions.map((extension) => ({ ...extension })),
    refreshTasks: () => [...runtimeTasks.values()].map((task) => ({ ...task })),
  };
}
