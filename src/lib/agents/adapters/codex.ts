import {
  asArray,
  asRecord,
  asString,
  imagePayloadDataUrl,
  oneLine,
  parseJson,
  type AdapterContext,
  type AgentAdapter,
  type AgentCommandResult,
} from "../adapter";
import { isAuthenticationFailure } from "../auth";
import { isCodexCapacityError } from "../capacityReply";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import {
  emptyUsage,
  makeChange,
  makePatchChange,
  toolKind,
  type AgentAccessMode,
  type AgentFileChange,
  type AgentGoalStatus,
  type AgentExtension,
  type AgentImageAttachment,
  type AgentItem,
  type AgentQuestionAnswer,
  type AgentRuntimeTask,
  type AgentSessionState,
  type AgentSideQuestion,
  type AgentStatus,
  type ToolStatus,
} from "../types";

/**
 * Codex `app-server` — JSON-RPC 2.0 with Codex's own thread/turn/item model.
 *
 * A thread is the conversation, a turn is one request, and items are the
 * things that happen inside it: agent messages, reasoning, command executions,
 * file changes. Items arrive twice — once as `item/started` with whatever was
 * known then, then as `item/completed` with the settled version — with typed
 * delta notifications in between. Mapping every item id straight onto a
 * timeline entry means both passes update the same row.
 *
 * Method and payload names follow openai/codex's published app-server schema,
 * verified against codex 0.159. There is no slash-command channel: the TUI's
 * commands are client-side, so this adapter wires the important ones itself —
 * `/model` and `/effort` are `turn/start` overrides ("for this turn and
 * subsequent turns", so they stick), `/compact` is `thread/compact/start`,
 * `/goal` uses the persisted `thread/goal/*` control plane, and `model/list`
 * supplies the valid ids and per-model effort levels.
 */

/** One row of `model/list`, trimmed to what the commands need. */
interface CodexModel {
  id: string;
  displayName: string;
  efforts: string[];
  serviceTiers: string[];
  hidden: boolean;
  isDefault: boolean;
}

interface CodexGoal {
  objective: string;
  status: AgentGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
const RESUME_PAGE_SIZE = 50;
const MAX_RESUMED_TURNS = 500;
const HISTORY_ITEM_PAGE_SIZE = 25;
const MAX_HISTORY_ITEMS = 1_000;
const MAX_HISTORY_DETAIL_BYTES = 4 * 1024 * 1024;
/** Subagent detail is lazy and intentionally bounded independently of root history. */
const CHILD_HISTORY_PAGE_SIZE = 8;
const FAST_SERVICE_TIER = "priority";
const DEFAULT_SERVICE_TIER = "default";
/** Matches the native log monitor's guard for Codex auto-continuations. */
const ROOT_COMPLETION_QUIET_MS = 800;
/** Child transcripts are detail views, not a 60 fps animation surface. */
const DEFAULT_CHILD_STREAM_PUBLISH_MS = 125;
/**
 * Codex `thread/resume` has no server-side timeout. A thread left `active`
 * with no running turn never answers, which used to leave the pane loading
 * forever. Ten seconds is long enough for a real page and short enough to
 * recover before the composer looks wedged.
 */
const RESUME_RPC_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;
const STOP_RPC_TIMEOUT_MS = 5_000;
const SIDE_DEVELOPER_INSTRUCTIONS = `You are in an ephemeral side conversation, not the main thread.
Use the inherited conversation only as reference context. Answer only the question submitted after the fork. Do not continue tasks, plans, or tool calls inherited from the parent thread. Keep the response focused and do not modify files or workspace state.`;

/** Side cards show the reply, not Codex commentary or reasoning traces. */
function pickSideAnswer(messages: Map<string, CodexSideMessage>): string {
  let lastAnswer = "";
  let lastFinal = "";
  let sawFinal = false;
  for (const item of messages.values()) {
    if (item.phase === "commentary") continue;
    if (item.phase === "final_answer") {
      lastFinal = item.text;
      sawFinal = true;
      continue;
    }
    if (!item.phase) lastAnswer = item.text;
  }
  return sawFinal ? lastFinal : lastAnswer;
}

interface CodexAdapterOptions {
  /** Test seam; account notifications are backed up by a periodic read. */
  authPollIntervalMs?: number;
  /** Test seam; production uses the same 800 ms quiet window as raw Codex. */
  completionQuietMs?: number;
  /** Test seam; production batches nested transcript reduction and paints to this cadence. */
  childStreamPublishMs?: number;
  /** Test seam for verifying that child token bursts are reduced in bounded batches. */
  childEventReducer?: (state: AgentSessionState, event: AgentEvent) => AgentSessionState;
  /**
   * How long `thread/resume` and history pages may sit unanswered before
   * Duckweed cancels them. Codex can hang forever on a stale-active thread;
   * production recovers by forking. `0` disables the timer (interrupt-only).
   */
  resumeTimeoutMs?: number;
  /** Control RPCs must not hold Stop or the Tasks panel indefinitely. */
  stopTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

const EXEC_STATUS: Record<string, ToolStatus> = {
  inProgress: "running",
  completed: "done",
  failed: "error",
  declined: "error",
};

/**
 * Codex uses different enum casing for thread/start and turn/start.
 * An empty object is important: it lets app-server resolve the user's normal
 * config/profile instead of Duckweed silently replacing it.
 */
function threadAccessParams(mode: AgentAccessMode): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
      };
    case "workspace":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      };
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "default":
      return {};
  }
}

function turnAccessParams(mode: AgentAccessMode): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly" },
      };
    case "workspace":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    case "default":
      return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readGoal(value: unknown): CodexGoal | null {
  const goal = asRecord(value);
  const objective = asString(goal?.objective);
  if (!goal || objective === null) return null;
  const rawStatus = asString(goal.status);
  const statuses: AgentGoalStatus[] = [
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ];
  const status = statuses.find((candidate) => candidate === rawStatus) ?? "active";
  return {
    objective,
    status,
    tokenBudget:
      typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)
        ? goal.tokenBudget
        : null,
    tokensUsed: numberOr(goal.tokensUsed, 0),
    timeUsedSeconds: numberOr(goal.timeUsedSeconds, 0),
  };
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatGoal(goal: CodexGoal): string {
  const status = goal.status.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const usage = [
    `${compactCount(goal.tokensUsed)} tokens`,
    `${Math.round(goal.timeUsedSeconds)}s`,
    ...(goal.tokenBudget === null ? [] : [`${compactCount(goal.tokenBudget)} token budget`]),
  ];
  return `Goal ${status}. Objective: ${goal.objective} · ${usage.join(" · ")}`;
}

const COLLAB_STATUS: Record<string, ToolStatus> = {
  inProgress: "running",
  completed: "done",
  failed: "error",
};

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Record<string, unknown>) => void;
}

type RequestKey = string | number;

const RESUME_CANCELLED = "duckweed_resume_cancelled";
const RESUME_TIMEOUT = "duckweed_resume_timeout";

interface ChildThread {
  callId: string | null;
  label: string | null;
  role: string | null;
  model: string | null;
  prompt: string | null;
  activity: string | null;
  currentTurnId: string | null;
  /** A streamed/collaboration status outranks the eventually-consistent thread/read snapshot. */
  hasLiveStatus: boolean;
  streamed: Set<string>;
  state: AgentSessionState;
}

interface PendingChildSpawn {
  callId: string;
  prompt: string | null;
  label: string;
  model: string | null;
  activity: string | null;
}

interface CodexSideMessage {
  text: string;
  /** Codex `commentary` is a thinking trace; `final_answer` is the reply. */
  phase: string | null;
}

interface CodexSideThread {
  threadId: string | null;
  currentTurnId: string | null;
  messages: Map<string, CodexSideMessage>;
  sideQuestion: AgentSideQuestion;
}

/**
 * Codex file changes: add/delete carry the raw file body, updates carry a
 * unified patch. Feeding the body through the patch renderer would paint every
 * line as context instead of the green/red the git diff uses for new/removed
 * files.
 */
function patchKind(raw: unknown): "add" | "delete" | "update" {
  if (raw === "add" || raw === "delete") return raw;
  const type = asString(asRecord(raw)?.type);
  if (type === "add" || type === "delete") return type;
  return "update";
}

function readFileChanges(raw: unknown): AgentFileChange[] {
  return asArray(raw)
    .map((entry) => asRecord(entry))
    .filter((change): change is Record<string, unknown> => change !== null)
    .map((change) => {
      const path = asString(change.path) ?? "";
      const diff = asString(change.diff) ?? "";
      const kind = patchKind(change.kind);
      if (kind === "add") return makeChange(path, null, diff);
      if (kind === "delete") return makeChange(path, diff, null);
      return makePatchChange(path, diff);
    })
    .filter((change) => change.path);
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const completionQuietMs = options.completionQuietMs ?? ROOT_COMPLETION_QUIET_MS;
  const childStreamPublishMs =
    options.childStreamPublishMs ?? DEFAULT_CHILD_STREAM_PUBLISH_MS;
  const reduceChildEvent = options.childEventReducer ?? applyEvent;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? RESUME_RPC_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_RPC_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  let stoppedByUser = false;
  let currentGoal: CodexGoal | null = null;
  let stopRecovery: { generation: number; promise: Promise<boolean> } | null = null;
  let disposed = false;
  let initialized = false;
  let authenticationRequired = false;
  let accountSignature: string | null = null;
  let accountGeneration = 0;
  let accountUpdateVersion = 0;
  let accountCachesDirty = false;
  let rejectedAuthVersion: number | null = null;
  let loginId: string | null = null;
  let authOperation = false;
  let authPollTimer: ReturnType<typeof setInterval> | null = null;
  let accountRead: Promise<void> | null = null;
  let accountSignedIn = false;
  let usesOpenaiAuth = true;
  let modelProvider: string | null = null;
  let accountReloadDeferred = false;
  let openingThread: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<RequestKey, Pending>();
  let threadId: string | null = null;
  let currentTurnId: string | null = null;
  let rootStartRequestId: RequestKey | null = null;
  /**
   * True from the moment Duckweed asks Codex to start/rejoin root work until
   * either completion channel settles it. `turn/started` is normally first,
   * but app-server notifications and RPC responses use separate paths, so a
   * fast or resumed turn can complete before that notification is observed.
   */
  let rootTurnMayBeActive = false;
  /** A start response/notification or active status proved root work exists. */
  let rootTurnStatusConfirmed = false;
  /** Invalidates late `turn/start` responses after the represented turn ended. */
  let rootTurnGeneration = 0;
  /** `rootTurnGeneration` whose turn/start was stopped before its id arrived. */
  let stopRequestedForGeneration: number | null = null;
  /** Advances when a live root completion beats an in-flight resume snapshot. */
  let rootCompletionVersion = 0;
  /** Bounded memory of completions used to reject stale RPC/resume snapshots. */
  const completedRootTurnIds = new Set<string>();
  /**
   * The subset Codex itself reported finished (`turn/completed`) or that an
   * acknowledged interrupt stopped. Other retirements are local inferences,
   * such as a thread-idle fallback, and live output for them proves the turn
   * is still running.
   */
  const finishedRootTurnIds = new Set<string>();
  let rootCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A completion is not settled until its quiet window expires. Keeping the
   * provider turn addressable lets Stop and same-turn steering win races with
   * terminal notifications, while a new auto-continuation can cancel it.
   */
  let rootPendingCompletion: { turnId: string | null } | null = null;
  /** A provider boundary survives cancellation of the UI's completion timer. */
  let rootTurnCompletionObserved = false;
  /** Keep provider completion addressable while same-turn input is pending. */
  let rootSteerRequestsInFlight = 0;
  let rootTurnWasSteered = false;
  let rootCompletionSeenDuringSteer: string | null | undefined;
  /** The resume RPC currently occupying the pane, so Stop can cancel it too. */
  let resumeRequestId: RequestKey | null = null;
  /**
   * True from the first resume emit until `thread/resume` and its transcript
   * pages have settled. `threadId` is claimed earlier so a live completion
   * cannot be misrouted; side forks must still wait for that hydration.
   */
  let hydratingResume = false;
  /** Stop pressed while resume RPCs were in flight or between recovery steps. */
  let resumeAborted = false;
  /**
   * The model and effort turns run with. Seeded from the launch flags,
   * corrected by the `thread/start` response, and moved by /model and
   * /effort — `turn/start` overrides persist server-side, but keeping our
   * own copy means the header and every request always agree.
   */
  let currentModel: string | null = null;
  let currentEffort: string | null = null;
  let currentServiceTier: string | null = null;
  /**
   * Fast Mode is a preference, but not every model accepts the `priority`
   * service tier. Keep the preference active and run incompatible models on
   * the default tier so switching models never turns into a rejected turn.
   */
  function serviceTierParamsFor(modelId: string | null): { serviceTier?: string } {
    if (currentServiceTier !== FAST_SERVICE_TIER) {
      return currentServiceTier ? { serviceTier: currentServiceTier } : {};
    }
    const model = models.find(
      (candidate) => candidate.id === modelId || candidate.displayName === modelId,
    );
    return {
      serviceTier:
        model && !model.serviceTiers.includes(FAST_SERVICE_TIER)
          ? DEFAULT_SERVICE_TIER
          : currentServiceTier,
    };
  }
  /**
   * `/fast` only changes the service tier. Codex still announces the thread's
   * stored effort in `thread/settings/updated`, and that value is often the
   * model default (`low`) because `/effort` is a local `turn/start` override.
   * While a Fast Mode write is in flight, keep the effort the user already has.
   */
  let preserveEffortDuringFastToggle = false;
  let currentAccess: AgentAccessMode = "default";
  /** `model/list`, once it lands; empty until then, so validation is lenient. */
  let models: CodexModel[] = [];
  /**
   * Item ids whose body already arrived as deltas. A completed item repeats
   * the whole text, so without this the transcript would show it twice — and
   * an item that never streamed (a resumed thread, a fast reply) would show
   * nothing at all if we only ever trusted the deltas.
   */
  const streamed = new Set<string>();
  /** Permission id → the JSON-RPC id Codex is waiting on, and its shape. */
  const approvals = new Map<string, { id: string | number; kind: "command" | "file" | "permissions"; permissions?: Record<string, unknown> }>();
  const questions = new Map<
    string,
    {
      id: string | number;
      kind: "user-input" | "mcp-form" | "mcp-url";
      fields?: Map<string, { type: string; choices: Map<string, unknown> }>;
    }
  >();
  /** Child thread id to its live, independently reduced transcript. */
  const children = new Map<string, ChildThread>();
  /** Spawn rows that arrived before app-server exposed their child thread id. */
  const pendingChildSpawns = new Map<string, PendingChildSpawn>();
  /** Avoid issuing the same automatic transcript reconciliation more than once. */
  const hydratedChildren = new Set<string>();
  /** Coalesce focus, discovery, and completion reads for the same child. */
  const hydratingChildren = new Map<string, Promise<boolean>>();
  /** Queue one explicit refresh when focus arrives during an automatic read. */
  const queuedChildRefreshes = new Map<string, Promise<boolean>>();
  /**
   * Token deltas waiting to be reduced, grouped by child and logical stream.
   * Reducing every token immediately repeatedly copied the growing string for
   * every active child. With a busy Codex fleet that quadratic allocation was
   * enough to exhaust WebView2's renderer before the paint throttle helped.
   */
  const pendingChildStreamEvents = new Map<string, Map<string, AgentEvent>>();
  /** One shared timer keeps a fleet on one cadence instead of N staggered timers. */
  let childStreamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let childDiscoveryInFlight: Promise<void> | null = null;
  let childDiscoveryRequested = false;
  let childDiscoveryShouldSynthesize = false;
  /**
   * Replaying persisted collaboration items must not recursively fetch every
   * referenced child. A resumed fleet can contain many large transcripts, and
   * the old eager `thread/read(includeTurns: true)` path loaded all of them at
   * once before the user opened a single detail panel.
   */
  let persistedHistoryReplayDepth = 0;
  /** Ephemeral `/side` and `/btw` forks, kept outside the main transcript. */
  const sideThreads = new Map<string, CodexSideThread>();
  let pendingSideThread: CodexSideThread | null = null;
  let activeSideThreadId: string | null = null;
  let sideSequence = 0;

  function rememberRootTurnCompleted(turnId: string | null): void {
    if (!turnId) return;
    completedRootTurnIds.add(turnId);
    if (completedRootTurnIds.size > 64) {
      const oldest = completedRootTurnIds.values().next().value;
      if (oldest) completedRootTurnIds.delete(oldest);
    }
  }

  /** Record proof only; the turn is still retired by settling it. */
  function rememberRootTurnFinished(turnId: string | null): void {
    if (!turnId) return;
    finishedRootTurnIds.add(turnId);
    if (finishedRootTurnIds.size > 64) {
      const oldest = finishedRootTurnIds.values().next().value;
      if (oldest) finishedRootTurnIds.delete(oldest);
    }
  }

  /**
   * Make `turnId` the live root turn again. Codex keeps one active turn per
   * thread and folds a `turn/start` sent while it runs into that same turn,
   * without a new `turn/started`. If Duckweed had closed the turn early, every
   * later frame looked stale and the pane froze on the Thinking placeholder
   * while Codex kept working.
   */
  function adoptRootTurn(turnId: string, ctx: AdapterContext): void {
    if (currentTurnId && currentTurnId !== turnId) rememberRootTurnCompleted(currentTurnId);
    completedRootTurnIds.delete(turnId);
    cancelPendingRootCompletion();
    currentTurnId = turnId;
    rootTurnCompletionObserved = false;
    rootTurnMayBeActive = true;
    rootTurnStatusConfirmed = true;
    rootTurnWasSteered = false;
    rootCompletionSeenDuringSteer = undefined;
    ctx.emit({ type: "status", status: "working" });
  }

  /**
   * A queued follow-up can start before every terminal notification from the
   * previous turn has drained from app-server. Never let one of those late
   * frames settle the new turn or append its final answer after the new user
   * message.
   */
  function rootTurnSignalIsStale(turnId: string | null): boolean {
    if (!turnId) return false;
    if (completedRootTurnIds.has(turnId)) return true;
    return currentTurnId !== null && currentTurnId !== turnId;
  }

  function settleRootTurn(turnId: string | null): void {
    rememberRootTurnCompleted(turnId ?? currentTurnId);
    currentTurnId = null;
    rootTurnMayBeActive = false;
    rootTurnStatusConfirmed = false;
    rootPendingCompletion = null;
    rootTurnCompletionObserved = false;
    rootSteerRequestsInFlight = 0;
    rootTurnWasSteered = false;
    rootCompletionSeenDuringSteer = undefined;
  }

  function cancelPendingRootCompletion(): void {
    if (rootCompletionTimer !== null) {
      clearTimeout(rootCompletionTimer);
      rootCompletionTimer = null;
    }
    rootPendingCompletion = null;
  }

  function scheduleRootCompletion(turnId: string | null, ctx: AdapterContext): void {
    cancelPendingRootCompletion();
    rootPendingCompletion = { turnId };
    const finish = () => {
      rootCompletionTimer = null;
      const completion = rootPendingCompletion;
      rootPendingCompletion = null;
      if (!completion || rootTurnSignalIsStale(completion.turnId)) return;
      settleRootTurn(completion.turnId);
      ctx.emit({ type: "turn-end" });
    };
    if (completionQuietMs <= 0) {
      finish();
      return;
    }
    rootCompletionTimer = setTimeout(finish, completionQuietMs);
  }

  function newChildState(childThreadId: string): AgentSessionState {
    return {
      termId: `subagent:${childThreadId}`,
      agent: "codex",
      program: "codex",
      label: "Subagent",
      mark: "C",
      accent: "#10a37f",
      status: "starting",
      workStartedAt: null,
      lastWorkedForMs: null,
      cwd: "",
      model: null,
      effort: null,
      serviceTier: null,
      accessMode: "default",
      models: [],
      sessionId: childThreadId,
      goal: null,
      items: [],
      pending: [],
      permission: null,
      usage: emptyUsage(),
      error: null,
      commands: [],
      started: false,
      exitArmed: false,
    };
  }

  function childFor(childThreadId: string): ChildThread {
    const known = children.get(childThreadId);
    if (known) return known;
    const child: ChildThread = {
      callId: null,
      label: null,
      role: null,
      model: null,
      prompt: null,
      activity: null,
      currentTurnId: null,
      hasLiveStatus: false,
      streamed: new Set<string>(),
      state: newChildState(childThreadId),
    };
    children.set(childThreadId, child);
    return child;
  }

  function lastChildActivity(items: AgentItem[]): string | null {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "assistant" || item.kind === "thinking") {
        const text = oneLine(item.text, 120);
        if (text) return text;
      }
      if (item.kind === "tool") {
        return oneLine(
          `${item.status === "done" ? "Completed" : item.status === "error" ? "Failed" : "Running"}: ${item.title}`,
          120,
        );
      }
      if (item.kind === "plan") {
        const active = item.steps.find((step) => step.status === "running");
        if (active) return oneLine(active.text, 120);
      }
      if (item.kind === "notice" && item.text.trim()) return oneLine(item.text, 120);
    }
    return null;
  }

  function childToolStatus(status: AgentStatus): ToolStatus {
    if (status === "error" || status === "exited") return "error";
    if (status === "idle") return "done";
    if (status === "working" || status === "waiting") return "running";
    return "pending";
  }

  function publishChild(childThreadId: string, ctx: AdapterContext): void {
    const child = children.get(childThreadId);
    if (!child?.callId) return;
    const status = childToolStatus(child.state.status);
    const activity =
      lastChildActivity(child.state.items) ??
      child.activity ??
      (status === "pending"
        ? "Pending initialization"
        : status === "running"
          ? "Working"
          : status === "error"
            ? child.state.error ?? "Delegated work failed"
            : "Delegated work completed");
    ctx.emit({
      type: "tool",
      callId: child.callId,
      status,
      subagent: {
        threadId: childThreadId,
        ...(child.label ? { label: child.label } : {}),
        ...(child.role ? { role: child.role } : {}),
        ...(child.model ? { model: child.model } : {}),
        ...(child.prompt ? { prompt: child.prompt } : {}),
        activity,
        items: child.state.items,
      },
    });
  }

  function childStreamEventKey(event: AgentEvent): string | null {
    if (event.type === "assistant-delta" || event.type === "thinking-delta") {
      return `${event.type}:${event.id}`;
    }
    if (event.type === "tool" && event.outputDelta !== undefined) {
      return `tool-output:${event.callId}`;
    }
    return null;
  }

  function mergeChildStreamEvent(
    previous: AgentEvent | undefined,
    event: AgentEvent,
  ): AgentEvent {
    if (!previous || previous.type !== event.type) return event;
    if (
      (event.type === "assistant-delta" || event.type === "thinking-delta") &&
      (previous.type === "assistant-delta" || previous.type === "thinking-delta")
    ) {
      return { ...event, text: previous.text + event.text };
    }
    if (event.type === "tool" && previous.type === "tool") {
      return {
        ...event,
        outputDelta: (previous.outputDelta ?? "") + (event.outputDelta ?? ""),
      };
    }
    return event;
  }

  /** Apply one child's queued token burst without publishing intermediate states. */
  function reducePendingChildStream(childThreadId: string): boolean {
    const events = pendingChildStreamEvents.get(childThreadId);
    if (!events) return false;
    pendingChildStreamEvents.delete(childThreadId);
    const child = childFor(childThreadId);
    for (const event of events.values()) {
      child.state = reduceChildEvent(child.state, event);
    }
    return true;
  }

  function cancelEmptyChildStreamTimer(): void {
    if (pendingChildStreamEvents.size > 0 || childStreamFlushTimer === null) return;
    clearTimeout(childStreamFlushTimer);
    childStreamFlushTimer = null;
  }

  function flushChildStreams(ctx: AdapterContext): void {
    if (childStreamFlushTimer !== null) {
      clearTimeout(childStreamFlushTimer);
      childStreamFlushTimer = null;
    }
    const childThreadIds = [...pendingChildStreamEvents.keys()];
    for (const childThreadId of childThreadIds) {
      if (reducePendingChildStream(childThreadId)) publishChild(childThreadId, ctx);
    }
  }

  /** Flush pending deltas before snapshots or metadata publish the same child. */
  function syncChild(childThreadId: string, ctx: AdapterContext): void {
    reducePendingChildStream(childThreadId);
    cancelEmptyChildStreamTimer();
    publishChild(childThreadId, ctx);
  }

  /**
   * Reduce and publish all streaming children at a readable shared cadence.
   * Besides keeping React away from token frequency, this makes the number of
   * timers and paint opportunities independent of the fleet size.
   */
  function scheduleChildStream(
    childThreadId: string,
    key: string,
    event: AgentEvent,
    ctx: AdapterContext,
  ): void {
    let streams = pendingChildStreamEvents.get(childThreadId);
    if (!streams) {
      streams = new Map();
      pendingChildStreamEvents.set(childThreadId, streams);
    }
    streams.set(key, mergeChildStreamEvent(streams.get(key), event));
    if (childStreamPublishMs <= 0) {
      flushChildStreams(ctx);
      return;
    }
    if (childStreamFlushTimer !== null) return;
    childStreamFlushTimer = setTimeout(() => {
      childStreamFlushTimer = null;
      flushChildStreams(ctx);
    }, childStreamPublishMs);
  }

  function emitChild(
    childThreadId: string,
    event: AgentEvent,
    ctx: AdapterContext,
  ): void {
    const child = childFor(childThreadId);
    if (event.type === "status" || event.type === "turn-end") {
      child.hasLiveStatus = true;
    }
    const streamKey = childStreamEventKey(event);
    if (streamKey) {
      scheduleChildStream(childThreadId, streamKey, event, ctx);
      return;
    }
    // Preserve protocol order: a completion must settle text that arrived
    // immediately before it, even if the cadence timer has not fired yet.
    reducePendingChildStream(childThreadId);
    cancelEmptyChildStreamTimer();
    child.state = reduceChildEvent(child.state, event);
    publishChild(childThreadId, ctx);
  }

  function childContext(childThreadId: string, ctx: AdapterContext): AdapterContext {
    return {
      ...ctx,
      emit: (event) => emitChild(childThreadId, event, ctx),
    };
  }

  function threadStatus(value: unknown): AgentStatus | null {
    const record = asRecord(value);
    const raw = asString(record?.type) ?? asString(value);
    if (raw === "idle") return "idle";
    if (raw === "active" || raw === "running" || raw === "inProgress") return "working";
    if (raw === "error" || raw === "failed") return "error";
    return null;
  }

  function hydratedTurnId(
    thread: Record<string, unknown>,
    trustThreadStatus = false,
  ): string | null {
    const explicit =
      asString(thread.currentTurnId) ??
      asString(thread.activeTurnId) ??
      asString(asRecord(thread.activeTurn)?.id);
    if (explicit) return explicit;

    const turns = asArray(thread.turns)
      .map((turn) => asRecord(turn))
      .filter((turn): turn is Record<string, unknown> => turn !== null);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (threadStatus(turns[index].status) === "working") {
        return asString(turns[index].id);
      }
    }
    // A persisted thread-level `active` bit can outlive the turn that set it.
    // Never turn the last completed turn into an interrupt target just because
    // that coarse status is stale.
    return trustThreadStatus && threadStatus(thread.status) === "working"
      ? asString(turns.at(-1)?.id)
      : null;
  }

  function hydrateChild(
    childThreadId: string,
    ctx: AdapterContext,
    force = false,
    queueIfActive = false,
  ): Promise<boolean> {
    if (persistedHistoryReplayDepth > 0) return Promise.resolve(false);
    if (!force && hydratedChildren.has(childThreadId)) return Promise.resolve(true);
    const active = hydratingChildren.get(childThreadId);
    if (active) {
      if (!force || !queueIfActive) return active;
      const queued = queuedChildRefreshes.get(childThreadId);
      if (queued) return queued;
      const refresh = active
        .then(() => hydrateChild(childThreadId, ctx, true))
        .finally(() => {
          queuedChildRefreshes.delete(childThreadId);
        });
      queuedChildRefreshes.set(childThreadId, refresh);
      return refresh;
    }

    const metadataRequestId = nextId++;
    const hydration = requestWithTimeout(ctx, metadataRequestId, "thread/read", {
      threadId: childThreadId,
      includeTurns: false,
    })
      .then(async (result) => {
        const thread = asRecord(result.thread) ?? result;
        const child = childFor(childThreadId);
        child.label =
          asString(thread.agentNickname) ?? asString(thread.nickname) ?? child.label;
        child.role = asString(thread.agentRole) ?? asString(thread.role) ?? child.role;
        child.model = asString(thread.model) ?? child.model;

        let turns = asArray(thread.turns);
        if (turns.length === 0) {
          const pageRequestId = nextId++;
          const page = await requestWithTimeout(ctx, pageRequestId, "thread/turns/list", {
            threadId: childThreadId,
            limit: CHILD_HISTORY_PAGE_SIZE,
            sortDirection: "desc",
            itemsView: "full",
          });
          turns = asArray(page.data).reverse();
        }
        const status = threadStatus(thread.status);
        if (
          status === "working" &&
          (!child.hasLiveStatus || child.state.status === "working")
        ) {
          // The parent collaboration item independently reported this child as
          // running, so its coarse thread status is corroborated here.
          child.currentTurnId ??= hydratedTurnId({ ...thread, turns }, true);
        } else if (!child.hasLiveStatus) {
          child.currentTurnId = null;
        }

        // The metadata read plus bounded page form a replacement snapshot. Replaying it on
        // top of the existing state appended every historical message again
        // each time completion, status, or focus requested a refresh. Build a
        // fresh state so repeated reads are idempotent, then publish once.
        let hydratedState = newChildState(childThreadId);
        const hydratedStreamed = new Set<string>();
        const nested: AdapterContext = {
          ...ctx,
          emit: (event) => {
            hydratedState = applyEvent(hydratedState, event);
          },
        };
        persistedHistoryReplayDepth += 1;
        try {
          for (const rawTurn of turns) {
            const turn = asRecord(rawTurn);
            if (!turn) continue;
            for (const rawItem of asArray(turn.items)) {
              const item = asRecord(rawItem);
              if (!item) continue;
              if (replayUserMessage(item, nested)) continue;
              handleItem(item, true, nested, hydratedStreamed);
              const itemId = asString(item.id);
              if (itemId && item.type === "agentMessage") {
                hydratedStreamed.add(`am-${itemId}`);
              } else if (itemId && item.type === "reasoning") {
                hydratedStreamed.add(`rs-${itemId}`);
              }
            }
          }
        } finally {
          persistedHistoryReplayDepth -= 1;
        }
        // Live status events can overtake thread/read. Never flash a completed
        // child back to working because an older snapshot arrived late.
        if (!child.hasLiveStatus && status) {
          hydratedState = applyEvent(hydratedState, { type: "status", status });
        } else {
          hydratedState = {
            ...hydratedState,
            status: child.state.status,
            error: child.state.error,
            workStartedAt: child.state.workStartedAt,
            lastWorkedForMs: child.state.lastWorkedForMs,
          };
        }
        child.state = hydratedState;
        child.streamed = hydratedStreamed;
        syncChild(childThreadId, ctx);
        hydratedChildren.add(childThreadId);
        return true;
      })
      .catch(() => {
        // Live child notifications remain the source of truth when this
        // app-server build does not expose thread/read for delegated threads.
        return false;
      })
      .finally(() => {
        hydratingChildren.delete(childThreadId);
      });
    hydratingChildren.set(childThreadId, hydration);
    return hydration;
  }

  function childPromptKey(value: string | null): string {
    return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  }

  function pendingSpawnForPrompt(prompt: string | null): PendingChildSpawn | null {
    const key = childPromptKey(prompt);
    if (key) {
      const exact = [...pendingChildSpawns.values()].find(
        (spawn) => childPromptKey(spawn.prompt) === key,
      );
      if (exact) return exact;
    }
    return pendingChildSpawns.size === 1
      ? (pendingChildSpawns.values().next().value ?? null)
      : null;
  }

  function unboundChildForPrompt(prompt: string | null): [string, ChildThread] | null {
    const key = childPromptKey(prompt);
    if (!key) return null;
    return (
      [...children.entries()].find(
        ([, child]) => !child.callId && childPromptKey(child.prompt) === key,
      ) ?? null
    );
  }

  function adoptChildThread(
    rawThread: Record<string, unknown>,
    ctx: AdapterContext,
    synthesizeMissing: boolean,
    liveStatus = false,
    hydrateTranscript = true,
  ): string | null {
    const childThreadId = asString(rawThread.id);
    if (!childThreadId || childThreadId === threadId) return null;

    const child = childFor(childThreadId);
    const preview = asString(rawThread.preview);
    child.label =
      asString(rawThread.agentNickname) ??
      asString(rawThread.nickname) ??
      child.label ??
      (preview ? oneLine(preview, 80) : null);
    child.role = asString(rawThread.agentRole) ?? asString(rawThread.role) ?? child.role;
    child.model = asString(rawThread.model) ?? child.model;
    child.prompt = preview ?? child.prompt;

    const status = threadStatus(rawThread.status);
    if (status && (liveStatus || !child.hasLiveStatus)) {
      if (liveStatus) child.hasLiveStatus = true;
      child.state = applyEvent(child.state, { type: "status", status });
    }

    if (!child.callId) {
      const pendingSpawn = pendingSpawnForPrompt(child.prompt);
      if (pendingSpawn) {
        child.callId = pendingSpawn.callId;
        child.label ??= pendingSpawn.label;
        child.prompt ??= pendingSpawn.prompt;
        child.model ??= pendingSpawn.model;
        child.activity ??= pendingSpawn.activity;
        pendingChildSpawns.delete(pendingSpawn.callId);
      } else if (synthesizeMissing) {
        child.callId = `codex-child:${childThreadId}`;
        const label = child.label ?? child.prompt ?? "Subagent";
        ctx.emit({
          type: "tool",
          callId: child.callId,
          name: "subagent",
          tool: "task",
          title: `Subagent: ${oneLine(label, 80)}`,
          status: childToolStatus(child.state.status),
          subagent: {
            threadId: childThreadId,
            label: oneLine(label, 80),
            ...(child.role ? { role: child.role } : {}),
            ...(child.model ? { model: child.model } : {}),
            ...(child.prompt ? { prompt: child.prompt } : {}),
            activity: child.activity ?? "Loading conversation",
          },
        });
      }
    }

    if (child.callId) {
      syncChild(childThreadId, ctx);
      if (hydrateTranscript) void hydrateChild(childThreadId, ctx);
    }
    return childThreadId;
  }

  function discoverChildThreads(
    ctx: AdapterContext,
    synthesizeMissing = false,
  ): Promise<void> {
    if (!threadId) return Promise.resolve();
    childDiscoveryRequested = true;
    childDiscoveryShouldSynthesize ||= synthesizeMissing;
    if (childDiscoveryInFlight) return childDiscoveryInFlight;

    const discover = async () => {
      while (childDiscoveryRequested && threadId) {
        childDiscoveryRequested = false;
        const synthesize = childDiscoveryShouldSynthesize;
        childDiscoveryShouldSynthesize = false;
        const parentThreadId = threadId;
        try {
          const result = await request(ctx, "thread/list", {
            parentThreadId,
            limit: 100,
            sortKey: "created_at",
            sortDirection: "asc",
          });
          for (const rawThread of asArray(result.data)) {
            const childThread = asRecord(rawThread);
            if (!childThread) continue;
            // Treat the server-side filter as a convenience, not a trust
            // boundary. Adopting an unrelated thread here would fetch its
            // transcript and can multiply resume traffic dramatically.
            if (asString(childThread.parentThreadId) !== parentThreadId) continue;
            adoptChildThread(childThread, ctx, synthesize, false, !synthesize);
          }
        } catch {
          // Older app-server builds can stream child events without supporting
          // the experimental parentThreadId filter.
        }
      }
    };

    childDiscoveryInFlight = discover().finally(() => {
      childDiscoveryInFlight = null;
    });
    return childDiscoveryInFlight;
  }

  function request(
    ctx: AdapterContext,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    return requestWithTimeout(ctx, nextId++, method, params, rpcTimeoutMs);
  }

  function requestWithId(
    ctx: AdapterContext,
    id: RequestKey,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendRequest(ctx, id, method, params);
    });
  }

  function sendRequest(ctx: AdapterContext, id: RequestKey, method: string, params: unknown): void {
    const failed = (error: unknown) => {
      const waiting = pending.get(id);
      pending.delete(id);
      waiting?.reject(asRecord(error) ?? { message: String(error) });
    };
    try {
      const sending = ctx.send({ jsonrpc: "2.0", id, method, params });
      if (sending) void Promise.resolve(sending).catch(failed);
    } catch (error: unknown) {
      failed(error);
    }
  }

  function resumeErrorCode(error: unknown): string | null {
    return asString(asRecord(error)?.code);
  }

  function throwIfResumeAborted(): void {
    if (!resumeAborted) return;
    throw { code: RESUME_CANCELLED };
  }

  /**
   * Same as `requestWithId`, but a silent Codex hang cannot occupy the pane
   * forever. The timer is a client watchdog: app-server has none for resume.
   */
  function requestWithTimeout(
    ctx: AdapterContext,
    id: RequestKey,
    method: string,
    params: unknown,
    timeoutMs = resumeTimeoutMs,
  ): Promise<Record<string, unknown>> {
    if (disposed) return Promise.reject({ code: "duckweed_closed", message: "Codex connection closed." });
    if (timeoutMs <= 0) return requestWithId(ctx, id, method, params);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        pending.delete(id);
        action();
      };
      timer = setTimeout(() => {
        finish(() => {
          const cancelledBeforeDelivery = ctx.cancelPendingSend?.(id) === true;
          notify(ctx, "$/cancelRequest", { id });
          reject({
            cancelledBeforeDelivery,
            code: method === "thread/resume" || method === "thread/fork" || method === "thread/turns/list" ? RESUME_TIMEOUT : "duckweed_rpc_timeout",
            message: `Codex did not answer ${method}.`,
          });
        });
      }, timeoutMs);
      pending.set(id, {
        resolve: (result) => finish(() => resolve(result)),
        reject: (error) => finish(() => reject(error)),
      });
      sendRequest(ctx, id, method, params);
    });
  }

  function resumeThreadParams(targetId: string): Record<string, unknown> {
    return {
      threadId: targetId,
      excludeTurns: true,
      initialTurnsPage: {
        limit: RESUME_PAGE_SIZE,
        sortDirection: "desc",
        // Conversation summaries retain user messages and final answers without
        // replaying megabytes of tool output through the native line limit.
        itemsView: "summary",
      },
    };
  }

  function notify(ctx: AdapterContext, method: string, params: unknown) {
    try {
      const sending = ctx.send({ jsonrpc: "2.0", method, params });
      if (sending) void Promise.resolve(sending).catch(() => {});
    } catch {
      // The waiting RPC's watchdog still settles when the transport is gone.
    }
  }

  function extensionRows(result: Record<string, unknown>, kind: AgentExtension["kind"]): AgentExtension[] {
    const source =
      kind === "skill"
        ? asArray(result.data).flatMap((entry) => asArray(asRecord(entry)?.skills))
        : kind === "app"
          ? asArray(result.data)
          : kind === "plugin"
            ? asArray(result.marketplaces).flatMap((entry) => asArray(asRecord(entry)?.plugins))
            : kind === "hook"
              ? asArray(result.data).flatMap((entry) => asArray(asRecord(entry)?.hooks))
              : asArray(result.data ?? result.servers);
    return source
      .map((raw) => asRecord(raw))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => {
        const info = asRecord(row.interface) ?? asRecord(row.serverInfo);
        const id = asString(row.id) ?? asString(row.name) ?? asString(row.key) ?? "";
        const name =
          (kind === "skill" ? asString(row.name) : null) ??
          asString(info?.displayName) ??
          asString(info?.title) ??
          asString(row.runtimeName) ??
          asString(row.name) ??
          asString(row.key) ??
          id;
        const runtimeStatus = asString(row.runtimeStatus);
        const enabled =
          row.enabled !== false &&
          row.isEnabled !== false &&
          row.isAccessible !== false &&
          runtimeStatus !== "disabled";
        return {
          id: `${kind}:${id}`,
          kind,
          name,
          description:
            asString(row.description) ??
            asString(row.shortDescription) ??
            asString(info?.shortDescription) ??
            asString(info?.longDescription) ??
            (runtimeStatus ? `Status: ${runtimeStatus}` : ""),
          enabled,
          callable:
            kind === "skill" ? enabled : kind === "app" ? enabled : false,
          status:
            runtimeStatus === "failed"
              ? "error"
              : runtimeStatus === "starting"
                ? "connecting"
                : enabled
                  ? "ready"
                  : "disabled",
          path: asString(row.path) ?? asString(row.sourcePath) ?? undefined,
          uri: kind === "app" ? `app://${id}` : undefined,
          source: asString(row.scope) ?? asString(row.pluginId) ?? undefined,
        } satisfies AgentExtension;
      })
      .filter((row) => {
        if (!row.id || !row.name) return false;
        // Computer Use was deliberately excluded from Duckweed's custom UI.
        // Keep it out of both the callable picker and the provider inventory.
        const identity = `${row.id} ${row.name}`.toLowerCase().replace(/[\s_]+/g, "-");
        return !identity.includes("computer-use");
      });
  }

  async function listExtensions(ctx: AdapterContext): Promise<AgentExtension[]> {
    const calls: [AgentExtension["kind"], Promise<Record<string, unknown>>][] = [
      ["skill", request(ctx, "skills/list", { cwds: [ctx.cwd], forceReload: false })],
      ["app", request(ctx, "app/list", { forceRefetch: false, threadId })],
      ["plugin", request(ctx, "plugin/list", { cwds: [ctx.cwd], forceRefetch: false })],
      ["hook", request(ctx, "hooks/list", { cwds: [ctx.cwd] })],
      ["mcp", request(ctx, "mcpServerStatus/list", { threadId })],
    ];
    const settled = await Promise.allSettled(calls.map(([, call]) => call));
    return settled.flatMap((result, index) =>
      result.status === "fulfilled" ? extensionRows(result.value, calls[index][0]) : [],
    );
  }

  async function listRuntimeTasks(ctx: AdapterContext): Promise<AgentRuntimeTask[]> {
    if (!threadId) return [];
    const result = await requestWithTimeout(ctx, nextId++, "thread/backgroundTerminals/list", { threadId, limit: 100 }, stopTimeoutMs);
    return asArray(result.data)
      .map((raw) => asRecord(raw))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => ({
        id: asString(row.processId) ?? asString(row.itemId) ?? "",
        kind: "terminal" as const,
        title: asString(row.command) ?? "Background terminal",
        status: "running" as const,
        command: asString(row.command) ?? undefined,
        cwd: asString(row.cwd) ?? undefined,
        detail:
          typeof row.osPid === "number"
            ? `PID ${row.osPid}${typeof row.cpuPercent === "number" ? `, ${row.cpuPercent.toFixed(1)}% CPU` : ""}`
            : undefined,
      }))
      .filter((task) => Boolean(task.id));
  }

  function emitSide(side: CodexSideThread, ctx: AdapterContext): void {
    ctx.emit({ type: "side-question", sideQuestion: { ...side.sideQuestion } });
  }

  function noteSideMessage(
    side: CodexSideThread,
    itemId: string,
    patch: { text?: string; phase?: string | null; append?: boolean },
  ): CodexSideMessage {
    const current = side.messages.get(itemId) ?? { text: "", phase: null };
    if (patch.phase) current.phase = patch.phase;
    if (patch.text) {
      current.text = patch.append ? current.text + patch.text : patch.text;
    }
    side.messages.set(itemId, current);
    return current;
  }

  function publishSideAnswer(side: CodexSideThread, ctx: AdapterContext): void {
    const next = pickSideAnswer(side.messages);
    if (next === side.sideQuestion.answer) return;
    side.sideQuestion.answer = next;
    emitSide(side, ctx);
  }

  function finishSide(
    sideThreadId: string,
    status: "answered" | "error",
    ctx: AdapterContext,
    fallback?: string,
  ): void {
    const side = sideThreads.get(sideThreadId);
    if (!side) return;
    side.currentTurnId = null;
    side.sideQuestion.status = status;
    side.sideQuestion.answer = pickSideAnswer(side.messages);
    if (!side.sideQuestion.answer.trim() && fallback) side.sideQuestion.answer = fallback;
    if (status === "answered" && !side.sideQuestion.answer.trim()) {
      side.sideQuestion.status = "error";
      side.sideQuestion.answer = "Codex did not return a side-conversation response.";
    }
    emitSide(side, ctx);
    if (activeSideThreadId === sideThreadId) activeSideThreadId = null;
    void request(ctx, "thread/unsubscribe", { threadId: sideThreadId })
      .catch(() => {
        // Ephemeral threads are in-memory only. A failed unsubscribe does not
        // affect the parent conversation or make the side reply persistent.
      })
      .finally(() => sideThreads.delete(sideThreadId));
  }

  function handleSideNotification(
    sideThreadId: string,
    method: string,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
    const side = sideThreads.get(sideThreadId);
    if (!side) return;
    switch (method) {
      case "turn/started":
        side.currentTurnId = asString(asRecord(params.turn)?.id);
        return;
      case "item/started": {
        const item = asRecord(params.item);
        const itemId = asString(item?.id);
        if (!item || asString(item.type) !== "agentMessage" || !itemId) return;
        noteSideMessage(side, itemId, { phase: asString(item.phase) });
        publishSideAnswer(side, ctx);
        return;
      }
      case "item/agentMessage/delta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        noteSideMessage(side, itemId, {
          text: delta,
          phase: asString(params.phase),
          append: true,
        });
        publishSideAnswer(side, ctx);
        return;
      }
      case "item/completed": {
        const item = asRecord(params.item);
        const itemId = asString(item?.id);
        if (!item || asString(item.type) !== "agentMessage" || !itemId) return;
        noteSideMessage(side, itemId, {
          text: asString(item.text) ?? "",
          phase: asString(item.phase),
        });
        publishSideAnswer(side, ctx);
        return;
      }
      case "turn/completed": {
        const error = asRecord(asRecord(params.turn)?.error);
        if (error) {
          finishSide(
            sideThreadId,
            "error",
            ctx,
            asString(error.message) ?? "The side conversation failed.",
          );
        } else {
          finishSide(sideThreadId, "answered", ctx);
        }
        return;
      }
      case "thread/status/changed": {
        const status = threadStatus(params.status);
        if (status === "error") {
          finishSide(sideThreadId, "error", ctx, "The side conversation failed.");
        } else if (
          status === "idle" &&
          (side.currentTurnId || side.sideQuestion.answer.trim() || side.messages.size > 0)
        ) {
          // Thread-level idle is Codex's reconciliation channel. Side forks
          // often receive this without a matching turn/completed, which would
          // otherwise leave the card asking and reject later /side and /btw.
          finishSide(sideThreadId, "answered", ctx);
        }
        return;
      }
      default:
        return;
    }
  }

  function startSideQuestion(
    command: "/side" | "/btw",
    question: string,
    ctx: AdapterContext,
    images: AgentImageAttachment[] = [],
  ): void {
    if (!question && images.length === 0) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: `Usage: ${command} <your question or attached image>`,
      });
      return;
    }
    if (!threadId) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: "A side conversation is not available until the Codex thread is ready.",
      });
      return;
    }
    if (pendingSideThread || activeSideThreadId) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: "A side conversation is already in progress.",
      });
      return;
    }

    sideSequence += 1;
    const side: CodexSideThread = {
      threadId: null,
      currentTurnId: null,
      messages: new Map(),
      sideQuestion: {
        id: `codex-side-${sideSequence}`,
        command,
        question,
        images: [...images],
        answer: "",
        status: "asking",
      },
    };
    pendingSideThread = side;
    emitSide(side, ctx);
    const parentThreadId = threadId;
    void request(ctx, "thread/fork", {
      threadId: parentThreadId,
      ephemeral: true,
      excludeTurns: true,
      developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
      ...threadAccessParams("read-only"),
      ...(currentModel ? { model: currentModel } : {}),
    })
      .then(async (result) => {
        const forked = asRecord(result.thread) ?? result;
        const sideThreadId = asString(forked.id);
        if (!sideThreadId) throw new Error("Codex did not return a side thread id.");
        side.threadId = sideThreadId;
        pendingSideThread = null;
        activeSideThreadId = sideThreadId;
        sideThreads.set(sideThreadId, side);
        const started = await request(ctx, "turn/start", {
          threadId: sideThreadId,
          input: [
            ...(question ? [{ type: "text", text: question }] : []),
            ...images.map((image) => ({
              type: "image",
              url: imagePayloadDataUrl(image),
            })),
          ],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          ...(currentModel ? { model: currentModel } : {}),
          ...(currentEffort ? { effort: currentEffort } : {}),
          ...serviceTierParamsFor(currentModel),
        });
        side.currentTurnId = asString(asRecord(started.turn)?.id) ?? side.currentTurnId;
      })
      .catch((error: unknown) => {
        pendingSideThread = null;
        if (side.threadId && activeSideThreadId === side.threadId) activeSideThreadId = null;
        if (side.threadId) sideThreads.delete(side.threadId);
        const record = asRecord(error);
        side.sideQuestion.status = "error";
        side.sideQuestion.answer =
          asString(record?.message) ?? "Codex could not start the side conversation.";
        emitSide(side, ctx);
        if (side.threadId) {
          void request(ctx, "thread/unsubscribe", { threadId: side.threadId }).catch(() => {});
        }
      });
  }

  async function handshake(ctx: AdapterContext) {
    try {
      await request(ctx, "initialize", {
        clientInfo: { name: "duckweed", title: "Duckweed", version: "0.1.0" },
        // `thread/settings/update` is currently part of app-server's
        // experimental surface. Fast Mode uses that method to change the
        // service tier without starting a throwaway turn, so opt in during
        // capability negotiation before sending any thread requests.
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      if (disposed) return;
      notify(ctx, "initialized", {});
      initialized = true;

      // thread/start succeeds without credentials. The first turn then
      // retries a 401 several times, which used to leave the UI working
      // forever. account/read detects that state before opening the thread.
      try {
        const account = await requestWithTimeout(
          ctx,
          "duckweed-account-read",
          "account/read",
          { refreshToken: false },
          5_000,
        );
        if (disposed) return;
        usesOpenaiAuth = account.requiresOpenaiAuth !== false;
        applyAccount(account, ctx);
      } catch {
        // Older app-server builds do not expose account/read. Continue and
        // catch any auth failure from the provider's normal error stream.
      }
      const interval = options.authPollIntervalMs ?? 5_000;
      if (interval > 0) authPollTimer = setInterval(() => {
        void refreshAccount(ctx, true);
        void refreshRuntimeProcesses(ctx);
      }, interval);
      if (authenticationRequired) {
        ctx.emit({ type: "status", status: "idle" });
        return;
      }
      await ensureThread(ctx);
    } catch (error) {
      if (!disposed) ctx.emit({ type: "status", status: "error", error: asString(asRecord(error)?.message) ?? "Codex refused to initialize." });
    }
  }

  function ensureThread(ctx: AdapterContext): Promise<void> {
    if (disposed || authenticationRequired || threadId) return Promise.resolve();
    if (!openingThread) openingThread = openThread(ctx).finally(() => { openingThread = null; });
    return openingThread;
  }

  async function openThread(ctx: AdapterContext) {
    try {
      currentModel = ctx.launch.model;
      currentEffort = ctx.launch.effort;
      currentServiceTier = null;
      currentAccess = ctx.launch.accessMode ?? "default";
      const thread = await request(ctx, "thread/start", {
        cwd: ctx.cwd,
        ...threadAccessParams(currentAccess),
        ...(currentModel ? { model: currentModel } : {}),
      });
      const started = asRecord(thread.thread) ?? thread;
      if (disposed) return;
      threadId = asString(started.id);
      if (!threadId) {
        ctx.emit({ type: "status", status: "error", error: "Codex did not return a thread id." });
        return;
      }
      // The response names the model and effort the thread actually got.
      // An explicit launch flag still wins: the server has not seen it yet
      // (thread/start carries no effort), so its answer here is the default,
      // and the first turn/start is what applies the request.
      modelProvider = asString(thread.modelProvider);
      currentModel = ctx.launch.model ?? asString(thread.model) ?? currentModel;
      currentEffort = ctx.launch.effort ?? asString(thread.reasoningEffort) ?? currentEffort;
      currentServiceTier = asString(thread.serviceTier);
      ctx.emit({
        type: "session",
        sessionId: asString(started.sessionId) ?? threadId,
        ...(currentModel ? { model: currentModel } : {}),
        ...(currentEffort ? { effort: currentEffort } : {}),
        serviceTier: currentServiceTier,
        capabilities: {
          inputs: {
            text: true,
            image: true,
            file: true,
            embeddedContext: true,
            skill: true,
            appMention: true,
          },
          interactions: { approvals: true, questions: true, forms: true, links: true },
          extensions: {
            skills: true,
            apps: true,
            plugins: true,
            mcp: true,
            hooks: true,
            workflows: true,
          },
          runtime: {
            backgroundTasks: true,
            terminals: true,
            worktrees: true,
            checkpointing: false,
            nativeFallback: true,
          },
        },
      });
      ctx.emit({ type: "status", status: "idle" });

      // Not awaited: /model and /effort validate leniently until this lands.
      void refreshModels(ctx);
    } catch (error) {
      const record = asRecord(error);
      if (!disposed) ctx.emit({
        type: "status",
        status: "error",
        error: asString(record?.message) ?? "Codex refused to start a thread.",
      });
    }
  }

  function refreshModels(ctx: AdapterContext): Promise<void> {
    const generation = accountGeneration;
    return request(ctx, "model/list", {})
      .then(async (result) => {
        const data = [...asArray(result.data)];
        const cursors = new Set<string>();
        let cursor = asString(result.nextCursor);
        while (cursor && !cursors.has(cursor) && cursors.size < 20) {
          if (disposed || generation !== accountGeneration) return;
          cursors.add(cursor);
          result = await request(ctx, "model/list", { cursor });
          data.push(...asArray(result.data));
          cursor = asString(result.nextCursor);
        }
        if (disposed || generation !== accountGeneration) return;
        const advertisedModels = data
          .map((raw) => asRecord(raw))
          .filter((model): model is Record<string, unknown> => model !== null)
          .map((model) => ({
            id: asString(model.model) ?? asString(model.id) ?? "",
            displayName: asString(model.displayName) ?? asString(model.id) ?? "",
            efforts: asArray(model.supportedReasoningEfforts)
              .map((raw) => asRecord(raw))
              .filter((effort): effort is Record<string, unknown> => effort !== null)
              .map((effort) => asString(effort.reasoningEffort) ?? "")
              .filter(Boolean),
            serviceTiers: [
              ...asArray(model.serviceTiers)
                .map((raw) => asRecord(raw))
                .filter((tier): tier is Record<string, unknown> => tier !== null)
                .map((tier) => asString(tier.id) ?? ""),
              ...asArray(model.additionalSpeedTiers).map((tier) => asString(tier) ?? ""),
            ].filter((tier, index, all) => Boolean(tier) && all.indexOf(tier) === index),
            hidden: model.hidden === true,
            isDefault: model.isDefault === true,
          }))
          .filter((model) => model.id);
        // CLIProxy aggregates every provider into /models. Keep this harness on
        // its OpenAI model family while retaining the CLI's effort metadata.
        // Other custom endpoints may intentionally serve their own model names.
        models = advertisedModels.filter((model) => !model.hidden &&
          (modelProvider?.toLowerCase() !== "cliproxy" || /^(?:openai\/)?(?:gpt-|o\d(?:-|$)|codex(?:-|$))/i.test(model.id)));
        const hiddenCurrent = advertisedModels.some(
          (model) =>
            model.hidden &&
            (model.id === currentModel || model.displayName === currentModel),
        );
        let repairedModel: string | undefined;
        if (hiddenCurrent && models.length) {
          repairedModel = (models.find((model) => model.isDefault) ?? models[0]).id;
          currentModel = repairedModel;
        }
        ctx.emit({
          type: "session",
          ...(repairedModel ? { model: repairedModel } : {}),
          models: models.map((model) => ({
            id: model.id,
            label: model.displayName || model.id,
            efforts: [...model.efforts],
          })),
        });
      })
      .catch(() => {
        // A server too old for model/list just leaves validation lenient.
      });
  }
  function applyAccount(account: Record<string, unknown>, ctx: AdapterContext): boolean {
    const signature = JSON.stringify([account.account ?? null, account.workspaceRouting ?? null, account.requiresOpenaiAuth]);
    const changed = signature !== accountSignature;
    const wasRequired = authenticationRequired;
    accountSignedIn = account.account != null;
    authenticationRequired = account.requiresOpenaiAuth === true && account.account == null;
    accountSignature = signature;
    if (wasRequired && !authenticationRequired) ctx.emit({ type: "status", status: "starting" });
    ctx.emit({ type: "authentication", required: authenticationRequired });
    if (changed) {
      accountGeneration += 1;
      models = [];
      ctx.emit({ type: "session", models: [] });
      ctx.emit({ type: "extensions", extensions: [], extensionsLoaded: false, loading: false });
    }
    if (authenticationRequired && (!wasRequired || changed)) {
      if (threadId && currentTurnId) void request(ctx, "turn/interrupt", { threadId, turnId: currentTurnId }).catch(() => {});
      cancelPendingRootCompletion();
      // Deliberately stopped: its trailing frames must not reopen the pane.
      rememberRootTurnFinished(currentTurnId);
      settleRootTurn(currentTurnId);
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "notice", tone: "info", text: "Codex is signed out. Use /login or sign in from the Codex CLI to continue." });
      if (threadId) ctx.emit({ type: "status", status: "idle" });
    }
    return changed;
  }

  function refreshAccount(ctx: AdapterContext, synchronize = false): Promise<void> {
    if (!initialized || disposed || authOperation) return Promise.resolve();
    if (accountRead) return accountRead;
    const version = accountUpdateVersion;
    const read = () => requestWithTimeout(ctx, "duckweed-account-sync", "account/read", { refreshToken: false }, 5_000);
    accountRead = (synchronize && usesOpenaiAuth && ctx.syncAccount ? ctx.syncAccount(accountSignedIn)
      .then((result) => {
        if (disposed || result === "restarted") return null;
        if (result === "deferred") {
          if (!accountReloadDeferred) ctx.emit({ type: "notice", tone: "info", text: "The Codex account changed in the CLI. The shared service will reload after active turns and background terminals finish." });
          accountReloadDeferred = true;
          // The running daemon still owns valid credentials. Keep its active
          // turn and steer usable until the shared service can safely reload.
          return read();
        }
        accountReloadDeferred = false;
        return read();
      }) : read())
      .then(async (account) => {
        if (!account || disposed || version !== accountUpdateVersion) return;
        if (rejectedAuthVersion === version) return;
        usesOpenaiAuth = account.requiresOpenaiAuth !== false;
        const changed = applyAccount(account, ctx) || accountCachesDirty;
        accountCachesDirty = false;
        if (authenticationRequired) return;
        const hadThread = Boolean(threadId);
        await ensureThread(ctx);
        if (changed && hadThread) {
          void refreshModels(ctx);
          void publishExtensions(ctx);
          if (!rootTurnMayBeActive) ctx.emit({ type: "status", status: "idle" });
        }
      })
      .catch(() => { /* A transient or unsupported account read must not end a running turn. */ })
      .finally(() => {
        accountRead = null;
        if (!disposed && version !== accountUpdateVersion) void refreshAccount(ctx);
      });
    return accountRead;
  }

  async function authenticate(action: "login" | "logout", ctx: AdapterContext, device = false): Promise<boolean> {
    if (!initialized || disposed || authOperation) return true;
    authOperation = true;
    try {
      if (loginId) {
        await requestWithTimeout(ctx, nextId++, "account/login/cancel", { loginId }, 5_000);
        loginId = null;
      }
      if (action === "logout") {
        await requestWithTimeout(ctx, nextId++, "account/logout", {}, 5_000);
      } else {
        const result = await requestWithTimeout(ctx, nextId++, "account/login/start", { type: device ? "chatgptDeviceCode" : "chatgpt" }, 15_000);
        if (disposed) return true;
        loginId = asString(result.loginId);
        const url = asString(result.authUrl) ?? asString(result.verificationUrl);
        const code = asString(result.userCode);
        ctx.emit({ type: "notice", tone: "info", text: code ? `Open ${url ?? "the Codex sign-in page"} and enter code ${code}.` : `Complete Codex sign-in in your browser.${url ? `\n${url}` : ""}` });
        if (url && ctx.openUrl) await ctx.openUrl(url).catch(() => {
          ctx.emit({ type: "notice", tone: "error", text: "Could not open the sign-in page. Open the link above in your browser." });
        });
      }
    } catch (error) {
      if (asRecord(error)?.code === -32601) return false;
      if (!disposed) ctx.emit({ type: "notice", tone: "error", text: asString(asRecord(error)?.message) ?? `Codex could not ${action === "login" ? "start sign-in" : "sign out"}.` });
    } finally {
      authOperation = false;
      if (!disposed) void refreshAccount(ctx);
    }
    return true;
  }

  let publishingExtensions: Promise<void> | null = null;
  function publishExtensions(ctx: AdapterContext): Promise<void> {
    if (publishingExtensions) return publishingExtensions;
    const generation = accountGeneration;
    publishingExtensions = listExtensions(ctx).then((extensions) => {
      if (!disposed && generation === accountGeneration) ctx.emit({ type: "extensions", extensions, extensionsLoaded: true, loading: false });
    }).catch(() => {}).finally(() => {
      publishingExtensions = null;
      if (!disposed && !authenticationRequired && generation !== accountGeneration) void publishExtensions(ctx);
    });
    return publishingExtensions;
  }

  let runtimeProcessRead: Promise<void> | null = null;
  let runtimeProcessesSupported = true;
  function refreshRuntimeProcesses(ctx: AdapterContext): Promise<void> {
    if (!ctx.runtimeProcesses || disposed || !threadId || !runtimeProcessesSupported) return Promise.resolve();
    if (runtimeProcessRead) return runtimeProcessRead;
    const parent = threadId;
    const threads = [parent, ...children.keys()];
    runtimeProcessRead = Promise.all(threads.map((threadId) =>
      requestWithTimeout(ctx, nextId++, "thread/backgroundTerminals/list", { threadId, limit: 100 }, 5_000)
    )).then(async (results) => {
      if (disposed || parent !== threadId) return;
      const pids = results.flatMap((result) => asArray(result.data).map((row) => asRecord(row)?.osPid))
        .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0);
      await ctx.runtimeProcesses?.([...new Set(pids)]);
    }).catch((error) => {
      if (asRecord(error)?.code === -32601) runtimeProcessesSupported = false;
    }).finally(() => { runtimeProcessRead = null; });
    return runtimeProcessRead;
  }

  /** One thread item, in whichever state it arrived. */
  function handleItem(
    item: Record<string, unknown>,
    settled: boolean,
    ctx: AdapterContext,
    streamedItems = streamed,
  ) {
    const id = asString(item.id);
    const type = asString(item.type);
    if (!id || !type) return;

    switch (type) {
      case "agentMessage": {
        if (!settled) return;
        const text = asString(item.text) ?? "";
        if (text && !streamedItems.has(`am-${id}`)) {
          ctx.emit({ type: "assistant-delta", id: `am-${id}`, text });
        }
        ctx.emit({ type: "assistant-end", id: `am-${id}` });
        return;
      }
      case "reasoning": {
        if (!settled) return;
        const text = [...asArray(item.content), ...asArray(item.summary)]
          .map((part) => asString(part) ?? "")
          .filter(Boolean)
          .join("\n");
        if (text && !streamedItems.has(`rs-${id}`)) {
          ctx.emit({ type: "thinking-delta", id: `rs-${id}`, text });
        }
        ctx.emit({ type: "thinking-end", id: `rs-${id}` });
        return;
      }
      case "commandExecution": {
        const command = asString(item.command) ?? "";
        const status = asString(item.status) ?? "";
        const output = asString(item.aggregatedOutput);
        ctx.emit({
          type: "tool",
          callId: id,
          name: "shell",
          tool: "execute",
          title: oneLine(command || "shell"),
          command: command || null,
          ...(EXEC_STATUS[status] ? { status: EXEC_STATUS[status] } : {}),
          ...(output ? { output } : {}),
        });
        return;
      }
      case "fileChange": {
        const changes = readFileChanges(item.changes);
        const status = asString(item.status) ?? "";
        const title =
          changes.length === 1
            ? changes[0].path
            : `${changes.length} files`;
        ctx.emit({
          type: "tool",
          callId: id,
          name: "apply_patch",
          tool: "edit",
          title: oneLine(title),
          status:
            status === "completed"
              ? "done"
              : status === "failed" || status === "declined"
                ? "error"
                : "running",
          changes,
        });
        return;
      }
      case "mcpToolCall":
      case "dynamicToolCall": {
        const tool = asString(item.tool) ?? "tool";
        const server = asString(item.server);
        const status = asString(item.status) ?? "";
        const name = server ? `${server}/${tool}` : tool;
        ctx.emit({
          type: "tool",
          callId: id,
          name,
          tool: toolKind(tool),
          title: oneLine(name),
          status: status === "completed" ? "done" : status === "failed" ? "error" : "running",
        });
        return;
      }
      case "collabAgentToolCall": {
        const collabTool = asString(item.tool) ?? "agent";
        const isSpawn = collabTool === "spawnAgent";
        const status = asString(item.status) ?? "";
        const prompt = asString(item.prompt);
        const model = asString(item.model);
        const effort = asString(item.reasoningEffort);
        const explicitReceiverIds = asArray(item.receiverThreadIds)
          .map((entry) => asString(entry) ?? "")
          .filter(Boolean);
        const states = asRecord(item.agentsStates);
        const stateEntries = states ? Object.entries(states) : [];
        let receiverIds = [
          ...new Set([
            ...explicitReceiverIds,
            ...(isSpawn ? stateEntries.map(([agentId]) => agentId) : []),
          ]),
        ];
        if (isSpawn && receiverIds.length === 0) {
          const unboundChild = unboundChildForPrompt(prompt);
          if (unboundChild) receiverIds = [unboundChild[0]];
        }
        const stateLines = stateEntries.length
          ? stateEntries.map(([agentId, raw]) => {
              const state = asRecord(raw);
              const agentStatus = asString(state?.status) ?? "unknown";
              const message = asString(state?.message);
              return `${agentId} · ${agentStatus}${message ? ` · ${oneLine(message)}` : ""}`;
            })
          : [];
        const operation =
          collabTool === "spawnAgent"
            ? "Spawned subagent"
            : collabTool === "sendInput"
              ? "Sent input to subagent"
              : collabTool === "resumeAgent"
                ? "Resumed subagent"
                : collabTool === "wait"
                  ? "Waiting for subagents"
                  : collabTool === "closeAgent"
                    ? "Closed subagent"
                    : "Subagent activity";
        const detail = [
          model ? `Model: ${model}${effort ? ` · ${effort}` : ""}` : "",
          receiverIds.length ? `Threads: ${receiverIds.join(", ")}` : "",
          prompt ? `Prompt: ${prompt}` : "",
          ...stateLines,
        ]
          .filter(Boolean)
          .join("\n");
        const primaryStateRaw =
          receiverIds
            .map((receiverId) => asRecord(states?.[receiverId]))
            .find((state) => state !== null) ??
          asRecord(stateEntries[0]?.[1]);
        const primaryState = asString(primaryStateRaw?.status);
        const primaryMessage = asString(primaryStateRaw?.message);
        const activity =
          primaryMessage?.trim() ||
          (primaryState
            ? primaryState === "pendingInit"
              ? "Pending initialization"
              : primaryState === "running" || primaryState === "active"
                ? "Working"
                : primaryState === "completed" || primaryState === "idle"
                  ? "Delegated work completed"
                  : `Status: ${primaryState.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`
            : "");
        const childStatus: ToolStatus | null =
          primaryState === "pendingInit" || primaryState === "pending"
            ? "pending"
            : primaryState === "running" || primaryState === "active"
              ? "running"
              : primaryState === "completed" || primaryState === "idle"
                ? "done"
                : primaryState === "failed" || primaryState === "error"
                  ? "error"
                  : null;
        if (isSpawn) {
          if (receiverIds.length === 0) {
            pendingChildSpawns.set(id, {
              callId: id,
              prompt,
              label: prompt ? oneLine(prompt, 80) : operation,
              model,
              activity: activity ? oneLine(activity, 120) : null,
            });
          } else {
            pendingChildSpawns.delete(id);
          }
          for (const receiverId of receiverIds) {
            const child = childFor(receiverId);
            child.callId = id;
            child.label = prompt ? oneLine(prompt, 80) : child.label;
            child.model = model ?? child.model;
            child.prompt = prompt ?? child.prompt;
            child.activity = activity ? oneLine(activity, 120) : child.activity;
            if (childStatus && childStatus !== "pending") {
              child.hasLiveStatus = true;
              child.state = applyEvent(child.state, {
                type: "status",
                status:
                  childStatus === "done"
                    ? "idle"
                    : childStatus === "error"
                      ? "error"
                      : "working",
              });
            }
          }
        }
        ctx.emit({
          type: "tool",
          callId: id,
          name: `collab/${collabTool}`,
          tool: isSpawn ? "task" : "other",
          title: prompt ? `${operation}: ${oneLine(prompt)}` : operation,
          status:
            isSpawn && receiverIds.length
              ? childStatus ??
                childToolStatus(childFor(receiverIds[0]).state.status)
              : COLLAB_STATUS[status] ?? (settled ? "done" : "running"),
          ...(detail ? { output: detail } : {}),
          ...(isSpawn
            ? {
                subagent: {
                  label: prompt ? oneLine(prompt, 80) : operation,
                  ...(receiverIds.length === 1 ? { threadId: receiverIds[0] } : {}),
                  ...(model ? { model } : {}),
                  ...(prompt ? { prompt } : {}),
                  ...(activity ? { activity: oneLine(activity) } : {}),
                },
              }
            : {}),
        });
        if (isSpawn) {
          for (const receiverId of receiverIds) {
            syncChild(receiverId, ctx);
            void hydrateChild(receiverId, ctx, settled);
          }
          if (receiverIds.length === 0) void discoverChildThreads(ctx);
        }
        return;
      }
      case "subAgentActivity": {
        const kind = asString(item.kind) ?? "interacted";
        const activityStatus: ToolStatus =
          kind === "completed" || kind === "finished"
            ? "done"
            : kind === "interrupted" || kind === "failed"
              ? "error"
              : "running";
        const agentPath = asString(item.agentPath);
        const agentThreadId = asString(item.agentThreadId);
        // Codex also reports activity for the root participant during a
        // collaboration run. Registering that row as a child makes every
        // later root event look nested and used to trigger a full root-history
        // read for each fleet update.
        if (agentThreadId === threadId || agentPath === "/root" || agentPath === "/") return;
        if (agentThreadId) {
          adoptChildThread(
            {
              id: agentThreadId,
              ...(agentPath ? { agentRole: agentPath } : {}),
            },
            ctx,
            false,
          );
          const child = childFor(agentThreadId);
          child.activity = kind.replace(/([a-z])([A-Z])/g, "$1 $2");
          child.hasLiveStatus = true;
          child.state = applyEvent(child.state, {
            type: "status",
            status: activityStatus === "error" ? "error" : activityStatus === "done" ? "idle" : "working",
          });
          if (child.callId) {
            syncChild(agentThreadId, ctx);
            void hydrateChild(agentThreadId, ctx, true);
            return;
          }

          // Multi-agent v2 can surface the child through subAgentActivity
          // without a preceding spawnAgent collaboration item. Bind this
          // fallback row to the child immediately so its persisted nickname
          // can replace agentPath without waiting for the user to inspect it.
          child.callId = id;
        }
        ctx.emit({
          type: "tool",
          callId: id,
          name: "subagent",
          tool: "task",
          title: agentPath ? `Subagent ${agentPath}` : "Subagent activity",
          status: activityStatus,
          output: [
            agentThreadId ? `Thread: ${agentThreadId}` : "",
            kind ? `Activity: ${kind}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          subagent: {
            label: agentPath ? oneLine(agentPath, 80) : "Subagent activity",
            ...(agentPath ? { role: agentPath } : {}),
            ...(agentThreadId ? { threadId: agentThreadId } : {}),
            activity: kind.replace(/([a-z])([A-Z])/g, "$1 $2"),
          },
        });
        if (agentThreadId) void hydrateChild(agentThreadId, ctx, true);
        return;
      }
      case "webSearch": {
        ctx.emit({
          type: "tool",
          callId: id,
          name: "web_search",
          tool: "fetch",
          title: oneLine(asString(item.query) ?? "web search"),
          status: settled ? "done" : "running",
        });
        return;
      }
      case "contextCompaction": {
        if (settled) {
          ctx.emit({ type: "notice", tone: "info", text: "Context compacted." });
        }
        return;
      }
      default:
        return;
    }
  }

  function replayImage(
    part: Record<string, unknown>,
    itemId: string,
    index: number,
  ): AgentImageAttachment | null {
    if (asString(part.type) !== "image") return null;
    const dataUrl = asString(part.url);
    const match = dataUrl?.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/is);
    if (!dataUrl || !match) return null;
    const mimeType = match[1].toLowerCase() as AgentImageAttachment["mimeType"];
    const encoded = match[2];
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
    return {
      id: `history-${itemId}-${index}`,
      name: `image-${index + 1}.${extension}`,
      mimeType,
      dataUrl,
      size: Math.max(0, Math.floor((encoded.length * 3) / 4) - padding),
    };
  }

  function replayUserMessage(item: Record<string, unknown>, ctx: AdapterContext): boolean {
    if (asString(item.type) !== "userMessage") return false;
    const itemId = asString(item.id) ?? "user";
    const content = asArray(item.content)
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const text = content
      .filter((entry) => asString(entry.type) === "text")
      .map((entry) => asString(entry.text) ?? "")
      .filter(Boolean)
      .join("\n");
    const images = content
      .map((entry, index) => replayImage(entry, itemId, index))
      .filter((image): image is AgentImageAttachment => image !== null);
    if (text || images.length) {
      ctx.emit({ type: "user", id: `history-user-${itemId}`, text, images });
    }
    return true;
  }

  /** Rebuild the visible transcript returned by Codex's resume pagination. */
  function replayTurns(turns: unknown[], ctx: AdapterContext) {
    ctx.emit({ type: "transcript" });
    streamed.clear();

    persistedHistoryReplayDepth += 1;
    try {
      for (const rawTurn of turns) {
        const turn = asRecord(rawTurn);
        if (!turn) continue;
        for (const rawItem of asArray(turn.items)) {
          const item = asRecord(rawItem);
          if (!item) continue;
          if (replayUserMessage(item, ctx)) continue;
          handleItem(item, true, ctx);
        }
      }
    } finally {
      persistedHistoryReplayDepth -= 1;
    }
  }

  /** Tool details are optional hydration, never a prerequisite for continuing. */
  async function hydrateResumedItems(
    turns: unknown[],
    targetId: string,
    generation: number,
    ctx: AdapterContext,
  ): Promise<void> {
    if (!turns.some((turn) => asRecord(turn)?.itemsView === "summary")) return;
    const completionVersion = rootCompletionVersion;
    const stillCurrent = () => threadId === targetId && rootTurnGeneration === generation &&
      rootCompletionVersion === completionVersion && !rootTurnMayBeActive && !hydratingResume;
    const entries: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let bytes = 0;
    try {
      do {
        if (!stillCurrent()) return;
        const page = await requestWithTimeout(ctx, nextId++, "thread/items/list", {
          threadId: targetId, cursor, limit: HISTORY_ITEM_PAGE_SIZE, sortDirection: "desc",
        });
        if (!stillCurrent()) return;
        const data = asArray(page.data);
        bytes += JSON.stringify(data).length;
        if (bytes > MAX_HISTORY_DETAIL_BYTES) break;
        for (const entry of data) {
          const record = asRecord(entry);
          if (record) entries.push(record);
        }
        cursor = asString(page.nextCursor);
        if (cursor && cursors.has(cursor)) break;
        if (cursor) cursors.add(cursor);
      } while (cursor && entries.length < MAX_HISTORY_ITEMS);
    } catch {
      // Old servers or oversized tool items can fail independently of resume.
    }
    if (!stillCurrent() || !entries.length) return;
    const byTurn = new Map<string, unknown[]>();
    for (const entry of entries.reverse()) {
      const turnId = asString(entry.turnId);
      const item = asRecord(entry.item);
      if (!turnId || !item) continue;
      const items = byTurn.get(turnId) ?? [];
      items.push(item);
      byTurn.set(turnId, items);
    }
    replayTurns(turns.map((rawTurn) => {
      const turn = asRecord(rawTurn);
      const items = byTurn.get(asString(turn?.id) ?? "");
      if (!turn || !items) return rawTurn;
      const ids = new Set(items.map((item) => asRecord(item)?.id));
      // A bounded detail page can stop in the middle of an older turn. Keep
      // its summary prompts even when their full items are outside the page.
      const missing = asArray(turn.items).filter((item) => !ids.has(asRecord(item)?.id));
      return { ...turn, items: [...missing, ...items] };
    }), ctx);
  }

  function handleNotification(method: string, params: Record<string, unknown>, ctx: AdapterContext) {
    const notificationTurnId = asString(params.turnId);
    if (
      (method.startsWith("item/") || method === "turn/plan/updated") &&
      rootTurnSignalIsStale(notificationTurnId)
    ) {
      return;
    }
    if (
      rootTurnMayBeActive &&
      (method.startsWith("item/") || method === "turn/plan/updated")
    ) {
      // A final message can introduce a question or be followed by more work.
      // Only provider boundaries remain authoritative once live output resumes.
      if (!rootTurnCompletionObserved) cancelPendingRootCompletion();
      // Live root output proves that an uncertain resume really rejoined work.
      // It lets the later thread-idle fallback finish the turn even if both
      // turn boundary notifications were the frames that went missing.
      rootTurnStatusConfirmed = true;
    }
    switch (method) {
      case "thread/goal/updated": {
        const goal = readGoal(params.goal);
        currentGoal = goal;
        if (goal) {
          ctx.emit({
            type: "goal",
            goal: { objective: goal.objective, status: goal.status },
          });
        }
        return;
      }
      case "thread/goal/cleared":
        currentGoal = null;
        ctx.emit({ type: "goal", goal: null });
        return;
      case "thread/started": {
        const thread = asRecord(params.thread);
        const id = asString(thread?.id);
        if (id) {
          threadId = id;
          ctx.emit({ type: "session", sessionId: asString(thread?.sessionId) ?? id });
        }
        return;
      }
      case "turn/started": {
        // Codex goals can auto-continue a few milliseconds after the previous
        // turn completed. Keep the original user-owned stretch open.
        const turn = asRecord(params.turn);
        const startedTurnId = asString(turn?.id);
        if (startedTurnId && completedRootTurnIds.has(startedTurnId)) return;
        if (
          startedTurnId && threadId && (stoppedByUser || (!rootTurnMayBeActive &&
          stopRequestedForGeneration === rootTurnGeneration))
        ) {
          // The turn Stop could not address yet. Interrupt it now instead of
          // reopening the pane for work the user already cancelled.
          stopRequestedForGeneration = null;
          rememberRootTurnCompleted(startedTurnId);
          void stopTurn(threadId, startedTurnId, ctx, rootTurnGeneration)
            .then((stopped) => { if (stopped) rememberRootTurnFinished(startedTurnId); });
          return;
        }
        if (startedTurnId !== currentTurnId) {
          rememberRootTurnCompleted(currentTurnId);
          rootTurnWasSteered = false;
          rootCompletionSeenDuringSteer = undefined;
        }
        cancelPendingRootCompletion();
        rootTurnCompletionObserved = false;
        currentTurnId = startedTurnId;
        rootTurnMayBeActive = true;
        rootTurnStatusConfirmed = true;
        ctx.emit({ type: "status", status: "working" });
        return;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const completedTurnId = asString(turn?.id);
        if (rootTurnSignalIsStale(completedTurnId)) return;
        rememberRootTurnFinished(completedTurnId);
        if (stoppedByUser) return;
        rootTurnCompletionObserved = true;
        const error = asRecord(turn?.error);
        if (error) {
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(error.message) ?? "The turn failed.",
          });
        }
        if (rootSteerRequestsInFlight > 0) {
          rootCompletionSeenDuringSteer = completedTurnId;
        } else {
          rootCompletionVersion += 1;
          scheduleRootCompletion(completedTurnId, ctx);
        }
        return;
      }
      case "thread/status/changed": {
        const status = threadStatus(params.status);
        if (status === "working") {
          if (stoppedByUser) return;
          cancelPendingRootCompletion();
          rootTurnMayBeActive = true;
          rootTurnStatusConfirmed = true;
          ctx.emit({ type: "status", status: "working" });
        } else if (status === "idle") {
          if (stoppedByUser) return;
          // This is Codex's thread-level reconciliation channel. It closes the
          // turn when a start/completed notification was lost or reordered.
          const wasActive = currentTurnId !== null ||
            (rootStartRequestId === null && rootTurnStatusConfirmed);
          // Sending turn/start only proves that Duckweed asked for work. Until
          // Codex acknowledges that turn, a thread-idle frame can still belong
          // to the turn that just released a queued follow-up.
          if (rootTurnMayBeActive && !wasActive) return;
          if (wasActive && rootSteerRequestsInFlight > 0) {
            rootCompletionSeenDuringSteer = currentTurnId;
          } else if (wasActive) {
            rootCompletionVersion += 1;
            scheduleRootCompletion(currentTurnId, ctx);
          } else if (rootCompletionTimer === null) {
            settleRootTurn(null);
            ctx.emit({ type: "status", status: "idle" });
          }
        } else if (status === "error") {
          cancelPendingRootCompletion();
          settleRootTurn(null);
          ctx.emit({ type: "status", status: "error" });
        }
        return;
      }
      case "item/started":
        handleItem(asRecord(params.item) ?? {}, false, ctx);
        return;
      case "item/completed": {
        const item = asRecord(params.item) ?? {};
        const itemTurnId = asString(params.turnId);
        if (rootTurnSignalIsStale(itemTurnId)) return;
        handleItem(item, true, ctx);
        // A completed message is not a completed turn. In particular,
        // request_user_input_async emits final_answer with delivery: "async"
        // while tools keep running, without a blocking request in questions.
        // Retiring its turn id here would silently discard all later output
        // and route the user's reply to turn/start instead of turn/steer.
        // Only turn/completed or thread idle may schedule root completion.
        return;
      }
      case "item/agentMessage/delta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        streamed.add(`am-${itemId}`);
        ctx.emit({ type: "assistant-delta", id: `am-${itemId}`, text: delta });
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        streamed.add(`rs-${itemId}`);
        ctx.emit({ type: "thinking-delta", id: `rs-${itemId}`, text: delta });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (itemId && delta) ctx.emit({ type: "tool", callId: itemId, outputDelta: delta });
        return;
      }
      case "item/fileChange/patchUpdated": {
        const itemId = asString(params.itemId);
        const changes = readFileChanges(params.changes);
        if (itemId && changes.length) ctx.emit({ type: "tool", callId: itemId, changes });
        return;
      }
      case "turn/plan/updated": {
        const steps = asArray(params.plan)
          .map((raw) => asRecord(raw))
          .filter((step): step is Record<string, unknown> => step !== null)
          .map((step) => ({
            text: asString(step.step) ?? "",
            status:
              step.status === "completed"
                ? ("done" as const)
                : step.status === "inProgress"
                  ? ("running" as const)
                  : ("pending" as const),
          }))
          .filter((step) => step.text);
        if (steps.length) ctx.emit({ type: "plan", planType: "tasks", steps });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = asRecord(params.tokenUsage);
        const total = asRecord(usage?.total);
        const window = usage?.modelContextWindow;
        const number = (value: unknown) => (typeof value === "number" ? value : 0);
        ctx.emit({
          type: "usage",
          usage: {
            inputTokens: number(total?.inputTokens) + number(total?.cachedInputTokens),
            outputTokens: number(total?.outputTokens),
            contextUsed:
              typeof window === "number" && window > 0
                ? Math.min(1, number(total?.totalTokens) / window)
                : null,
          },
        });
        return;
      }
      case "model/rerouted": {
        const model = asString(params.model) ?? asString(params.to);
        if (model) {
          currentModel = model;
          ctx.emit({ type: "session", model });
        }
        return;
      }
      case "thread/settings/updated": {
        // Codex confirming (or another client making) a model, effort, or
        // service-tier change.
        const settings = asRecord(params.threadSettings);
        const model = asString(settings?.model);
        const effort = asString(settings?.effort);
        const hasServiceTier = Boolean(
          settings && Object.prototype.hasOwnProperty.call(settings, "serviceTier"),
        );
        const applyEffort = Boolean(effort) && !preserveEffortDuringFastToggle;
        if (model) currentModel = model;
        if (applyEffort) currentEffort = effort;
        if (hasServiceTier) currentServiceTier = asString(settings?.serviceTier);
        if (model || applyEffort || hasServiceTier) {
          ctx.emit({
            type: "session",
            ...(model ? { model } : {}),
            ...(applyEffort ? { effort } : {}),
            ...(hasServiceTier ? { serviceTier: currentServiceTier } : {}),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  function notificationThreadId(
    method: string,
    params: Record<string, unknown>,
  ): string | null {
    const nested = method === "thread/started" ? asRecord(params.thread) : null;
    return asString(params.threadId) ?? asString(nested?.id);
  }

  function notificationBelongsToRoot(
    method: string,
    params: Record<string, unknown>,
  ): boolean {
    const eventThreadId = notificationThreadId(method, params);
    if (threadId && eventThreadId && eventThreadId !== threadId) return false;

    const turn = asRecord(params.turn);
    const eventTurnId = asString(params.turnId) ?? asString(turn?.id);
    if (method === "turn/started") {
      // A new root start is authoritative even when the preceding completion
      // was missed. Retired IDs still protect against delayed old starts.
      return !eventTurnId || !completedRootTurnIds.has(eventTurnId);
    }
    if (currentTurnId && eventTurnId && eventTurnId !== currentTurnId) return false;
    if (method === "turn/completed" && !currentTurnId && eventTurnId) {
      // The RPC response and notifications travel independently. Accept a
      // root completion without its start ID only while this adapter knows it
      // asked for or rejoined live work. Once settled, duplicates stay out.
      return rootTurnMayBeActive && !completedRootTurnIds.has(eventTurnId);
    }
    return true;
  }

  function handleChildNotification(
    childThreadId: string,
    method: string,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
    const nested = childContext(childThreadId, ctx);
    switch (method) {
      case "thread/started": {
        const thread = asRecord(params.thread);
        if (thread) adoptChildThread(thread, ctx, false, true);
        return;
      }
      case "turn/started": {
        const child = childFor(childThreadId);
        child.activity = null;
        child.currentTurnId = asString(asRecord(params.turn)?.id);
        emitChild(childThreadId, { type: "status", status: "working" }, ctx);
        return;
      }
      case "turn/completed": {
        childFor(childThreadId).currentTurnId = null;
        const turn = asRecord(params.turn);
        const error = asRecord(turn?.error);
        if (error) {
          emitChild(
            childThreadId,
            {
              type: "status",
              status: "error",
              error: asString(error.message) ?? "Delegated work failed.",
            },
            ctx,
          );
        } else {
          emitChild(childThreadId, { type: "turn-end" }, ctx);
        }
        void hydrateChild(childThreadId, ctx, true);
        return;
      }
      case "thread/status/changed": {
        const status = threadStatus(params.status);
        if (status === "working") childFor(childThreadId).activity = null;
        if (status === "idle" || status === "error") {
          childFor(childThreadId).currentTurnId = null;
        }
        if (status) emitChild(childThreadId, { type: "status", status }, ctx);
        if (status === "idle" || status === "error") {
          void hydrateChild(childThreadId, ctx, true);
        }
        return;
      }
      case "item/started":
        handleItem(
          asRecord(params.item) ?? {},
          false,
          nested,
          childFor(childThreadId).streamed,
        );
        return;
      case "item/completed":
        handleItem(
          asRecord(params.item) ?? {},
          true,
          nested,
          childFor(childThreadId).streamed,
        );
        return;
      case "item/agentMessage/delta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        childFor(childThreadId).streamed.add(`am-${itemId}`);
        emitChild(childThreadId, { type: "assistant-delta", id: `am-${itemId}`, text: delta }, ctx);
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        childFor(childThreadId).streamed.add(`rs-${itemId}`);
        emitChild(childThreadId, { type: "thinking-delta", id: `rs-${itemId}`, text: delta }, ctx);
        return;
      }
      case "item/commandExecution/outputDelta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (itemId && delta) {
          emitChild(childThreadId, { type: "tool", callId: itemId, outputDelta: delta }, ctx);
        }
        return;
      }
      case "item/fileChange/patchUpdated": {
        const itemId = asString(params.itemId);
        const changes = readFileChanges(params.changes);
        if (itemId && changes.length) {
          emitChild(childThreadId, { type: "tool", callId: itemId, changes }, ctx);
        }
        return;
      }
      case "turn/plan/updated": {
        const steps = asArray(params.plan)
          .map((raw) => asRecord(raw))
          .filter((step): step is Record<string, unknown> => step !== null)
          .map((step) => ({
            text: asString(step.step) ?? "",
            status:
              step.status === "completed"
                ? ("done" as const)
                : step.status === "inProgress"
                  ? ("running" as const)
                  : ("pending" as const),
          }))
          .filter((step) => step.text);
        if (steps.length) {
          emitChild(childThreadId, { type: "plan", planType: "tasks", steps }, ctx);
        }
        return;
      }
      default:
        return;
    }
  }

  function handleApproval(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ) {
    const isCommand = method === "item/commandExecution/requestApproval";
    const permissionId = `perm-${String(id)}`;
    approvals.set(permissionId, { id, kind: isCommand ? "command" : "file" });
    const command = asString(params.command);
    const reason = asString(params.reason);
    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        title: isCommand ? "Run a command" : "Apply file changes",
        detail: reason,
        command: command ?? null,
        changes: [],
        options: [
          { id: "accept", label: "Approve", kind: "allow" },
          { id: "acceptForSession", label: "Always in this session", kind: "allow-always" },
          { id: "decline", label: "Decline", kind: "reject" },
        ],
      },
    });
  }

  function handlePermissionsApproval(id: RequestKey, params: Record<string, unknown>, ctx: AdapterContext): void {
    const requested = asRecord(params.permissions) ?? {};
    const permissions = Object.fromEntries(Object.entries(requested).filter(([key, value]) =>
      (key === "network" || key === "fileSystem") && value !== null,
    ));
    const fileSystem = asRecord(permissions.fileSystem);
    const detail = [asString(params.reason),
      asRecord(permissions.network)?.enabled === true ? "Network access" : null,
      ...asArray(fileSystem?.read).map((path) => `Read: ${String(path)}`),
      ...asArray(fileSystem?.write).map((path) => `Write: ${String(path)}`),
      ...asArray(fileSystem?.entries).map((entry) => {
        const rule = asRecord(entry);
        const path = asRecord(rule?.path);
        const special = asRecord(path?.value);
        const location = asString(path?.path) ?? asString(path?.pattern) ?? asString(path?.value) ?? asString(special?.kind) ?? "requested location";
        return `${asString(rule?.access) ?? "Access"}: ${location}`;
      }),
    ].filter(Boolean).join("\n");
    const permissionId = `perm-${String(id)}`;
    approvals.set(permissionId, { id, kind: "permissions", permissions });
    ctx.emit({ type: "permission", permission: {
      id: permissionId, title: "Allow additional access", detail, command: null, changes: [],
      options: [
        { id: "accept", label: "Allow for this turn", kind: "allow" },
        { id: "acceptForSession", label: "Allow for this session", kind: "allow-always" },
        { id: "decline", label: "Decline", kind: "reject" },
      ],
    } });
  }

  function handleUserInput(
    id: string | number,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
    cancelPendingRootCompletion();
    const permissionId = `question-${String(id)}`;
    questions.set(permissionId, { id, kind: "user-input" });
    const items = asArray(params.questions)
      .map((raw) => asRecord(raw))
      .filter((question): question is Record<string, unknown> => question !== null)
      .map((question, index) => ({
        id: asString(question.id) ?? `question-${index}`,
        header: asString(question.header) ?? "Input",
        question: asString(question.question) ?? "What should Codex use?",
        multiSelect: false,
        inputKind: question.isSecret === true ? ("secret" as const) : undefined,
        required: true,
        options: asArray(question.options)
          .map((raw) => asRecord(raw))
          .filter((option): option is Record<string, unknown> => option !== null)
          .map((option, optionIndex) => ({
            id: `${optionIndex}`,
            label: asString(option.label) ?? `Option ${optionIndex + 1}`,
            description: asString(option.description) ?? "",
            preview: null,
          })),
      }));
    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        kind: "question",
        title: "Codex needs input",
        detail: null,
        command: null,
        changes: [],
        options: [],
        questions: items,
      },
    });
  }

  function handleMcpElicitation(
    id: string | number,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
    cancelPendingRootCompletion();
    const permissionId = `mcp-${String(id)}`;
    const mode = asString(params.mode);
    const schema = asRecord(params.requestedSchema);
    const properties = asRecord(schema?.properties) ?? {};
    const required = new Set(asArray(schema?.required).map((value) => asString(value)).filter(Boolean));
    const fieldTypes = new Map<string, { type: string; choices: Map<string, unknown> }>();

    const choicesFor = (field: Record<string, unknown>) => {
      const type = asString(field.type);
      const items = type === "array" ? asRecord(field.items) : null;
      const source = items ?? field;
      const titled = asArray(source.oneOf ?? source.anyOf)
        .map((raw) => asRecord(raw))
        .filter((option): option is Record<string, unknown> => option !== null)
        .map((option) => ({
          label: asString(option.title) ?? String(option.const ?? ""),
          value: option.const,
        }))
        .filter((option) => option.label !== "");
      if (titled.length) return titled;
      const names = asArray(source.enumNames).map((value) => String(value));
      return asArray(source.enum).map((value, index) => ({
        label: names[index] ?? String(value),
        value,
      }));
    };

    const formQuestions = Object.entries(properties).map(([key, raw], index) => {
      const field = asRecord(raw) ?? {};
      const type = asString(field.type) ?? "string";
      const choices =
        type === "boolean"
          ? [
              { label: "True", value: true },
              { label: "False", value: false },
            ]
          : choicesFor(field);
      fieldTypes.set(key, {
        type,
        choices: new Map(choices.map((choice) => [choice.label, choice.value])),
      });
      const defaultValue = field.default;
      const inputKind =
        asString(field.format) === "password"
          ? ("secret" as const)
          : type === "number"
            ? ("number" as const)
            : type === "integer"
              ? ("integer" as const)
              : type === "array"
                ? ("multiselect" as const)
                : choices.length
                  ? ("select" as const)
                  : ("text" as const);
      return {
        id: key,
        header: asString(field.title) ?? key,
        question: asString(field.description) ?? asString(field.title) ?? key,
        multiSelect: type === "array",
        inputKind,
        required: required.has(key),
        allowCustom: choices.length === 0,
        placeholder:
          defaultValue === undefined || defaultValue === null
            ? undefined
            : Array.isArray(defaultValue)
              ? defaultValue.map(String).join(", ")
              : String(defaultValue),
        minimum: typeof field.minimum === "number" ? field.minimum : undefined,
        maximum: typeof field.maximum === "number" ? field.maximum : undefined,
        options: choices.map((choice, choiceIndex) => ({
          id: `${index}-${choiceIndex}`,
          label: choice.label,
          description: "",
          preview: null,
        })),
      };
    });
    const url = asString(params.url);
    questions.set(permissionId, {
      id,
      kind: mode === "url" ? "mcp-url" : "mcp-form",
      fields: mode === "url" ? undefined : fieldTypes,
    });
    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        kind: "question",
        title: `${asString(params.serverName) ?? "MCP server"} needs input`,
        detail: url ?? asString(params.message),
        command: null,
        changes: [],
        options: [],
        questions:
          mode === "url"
            ? [
                {
                  id: "confirmation",
                  header: "Authorization",
                  question: asString(params.message) ?? "Complete authorization in the linked page.",
                  multiSelect: false,
                  inputKind: "url",
                  required: true,
                  placeholder: url ?? undefined,
                  options: [
                    { id: "accept", label: "Completed", description: url ?? "", preview: null },
                  ],
                },
              ]
            : formQuestions.length
              ? formQuestions
              : [
                  {
                    id: "confirmation",
                    header: "Confirmation",
                    question: asString(params.message) ?? "Allow this MCP server to continue?",
                    multiSelect: false,
                    inputKind: "select",
                    required: true,
                    options: [
                      { id: "accept", label: "Continue", description: "Allow the request", preview: null },
                    ],
                  },
                ],
      },
    });
  }

  function goalError(error: unknown, fallback: string, ctx: AdapterContext): void {
    const record = asRecord(error);
    const message = asString(record?.message);
    ctx.emit({
      type: "notice",
      tone: "error",
      text:
        message?.includes("Method not found") || message?.includes("not supported")
          ? "This Codex version does not support persistent goals."
          : message ?? fallback,
    });
  }

  function showGoalResult(result: Record<string, unknown>, ctx: AdapterContext): void {
    const goal = readGoal(result.goal);
    currentGoal = goal;
    ctx.emit({
      type: "goal",
      goal: goal ? { objective: goal.objective, status: goal.status } : null,
    });
    ctx.emit({
      type: "notice",
      tone: "info",
      text: goal
        ? formatGoal(goal)
        : "No goal is currently set. Use /goal <objective> to create one.",
    });
  }

  function getGoal(ctx: AdapterContext): void {
    if (!threadId) return;
    void request(ctx, "thread/goal/get", { threadId })
      .then((result) => showGoalResult(result, ctx))
      .catch((error: unknown) => goalError(error, "Codex could not read the goal.", ctx));
  }

  function clearGoal(ctx: AdapterContext): void {
    if (!threadId) return;
    void request(ctx, "thread/goal/clear", { threadId })
      .then((result) => {
        currentGoal = null;
        ctx.emit({ type: "goal", goal: null });
        ctx.emit({
          type: "notice",
          tone: "info",
          text: result.cleared === false ? "No goal was set." : "Goal cleared.",
        });
      })
      .catch((error: unknown) => goalError(error, "Codex could not clear the goal.", ctx));
  }

  function setGoalStatus(status: "active" | "paused", ctx: AdapterContext): void {
    if (!threadId) return;
    if (status === "active") { stoppedByUser = false; rootTurnGeneration += 1; }
    void request(ctx, "thread/goal/set", { threadId, status })
      .then((result) => showGoalResult(result, ctx))
      .catch((error: unknown) =>
        goalError(
          error,
          status === "active" ? "Codex could not resume the goal." : "Codex could not pause the goal.",
          ctx,
        ),
      );
  }

  function editGoal(objective: string, ctx: AdapterContext): void {
    if (!threadId) return;
    void request(ctx, "thread/goal/get", { threadId })
      .then((result) => {
        const current = readGoal(result.goal);
        if (!current) {
          ctx.emit({
            type: "notice",
            tone: "error",
            text: "No goal is currently set. Use /goal <objective> to create one.",
          });
          return null;
        }
        const keepStatus = ["active", "paused", "blocked", "usageLimited"].includes(current.status);
        return request(ctx, "thread/goal/set", {
          threadId,
          objective,
          status: keepStatus ? current.status : "active",
        });
      })
      .then((result) => {
        if (result) showGoalResult(result, ctx);
      })
      .catch((error: unknown) => goalError(error, "Codex could not edit the goal.", ctx));
  }

  function replaceGoal(objective: string, ctx: AdapterContext): void {
    if (!threadId) return;
    stoppedByUser = false;
    rootTurnGeneration += 1;
    // A new `/goal <objective>` starts fresh accounting, matching Codex's TUI.
    void request(ctx, "thread/goal/clear", { threadId })
      .then(() =>
        request(ctx, "thread/goal/set", {
          threadId,
          objective,
          status: "active",
        }),
      )
      .then((result) => showGoalResult(result, ctx))
      .catch((error: unknown) => goalError(error, "Codex could not set the goal.", ctx));
  }

  function handleGoalCommand(arg: string, ctx: AdapterContext): boolean {
    if (!arg) {
      getGoal(ctx);
      return false;
    }
    const action = arg.toLowerCase();
    if (action === "clear") {
      clearGoal(ctx);
      return false;
    }
    if (action === "pause") {
      setGoalStatus("paused", ctx);
      return false;
    }
    if (action === "resume") {
      setGoalStatus("active", ctx);
      return true;
    }
    if (action === "edit" || action === "help") {
      ctx.emit({
        type: "notice",
        tone: "info",
        text:
          "Usage: /goal <objective>, /goal edit <objective>, /goal pause, /goal resume, or /goal clear.",
      });
      return false;
    }

    const edit = /^edit\s+([\s\S]+)$/i.exec(arg);
    const objective = (edit?.[1] ?? arg).trim();
    if (Array.from(objective).length > MAX_GOAL_OBJECTIVE_CHARS) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: `Goal objectives can be at most ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString("en-US")} characters. Put longer instructions in a file and refer to it from the goal.`,
      });
      return false;
    }
    if (edit) editGoal(objective, ctx);
    else replaceGoal(objective, ctx);
    // An active goal is provider-owned work: Codex starts its turn from the
    // goal RPC rather than from adapter.prompt(), so the session must retain
    // completion ownership until that turn settles.
    return true;
  }

  /** Codex TUI controls that Duckweed maps onto app-server requests. */
  function handleFastCommand(arg: string, ctx: AdapterContext): void {
    const normalized = arg.toLowerCase();
    if (normalized && normalized !== "on" && normalized !== "off") {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: "Usage: /fast, /fast on, or /fast off.",
      });
      return;
    }

    const enabled = currentServiceTier === FAST_SERVICE_TIER;
    const shouldEnable = normalized === "on" ? true : normalized === "off" ? false : !enabled;
    if (shouldEnable === enabled) {
      ctx.emit({
        type: "notice",
        tone: "info",
        text: `Fast Mode is already ${enabled ? "enabled" : "disabled"}.`,
      });
      return;
    }

    if (shouldEnable) {
      const active = models.find((model) => model.id === currentModel);
      if (active && !active.serviceTiers.includes(FAST_SERVICE_TIER)) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `${currentModel ?? "This model"} does not support Fast Mode.`,
        });
        return;
      }
    }

    if (!threadId) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: "Fast Mode is not available until the Codex session is ready.",
      });
      return;
    }

    // Match Codex's native /fast behavior: update this thread and persist the
    // selection for chats opened later. `default` is an explicit off state;
    // clearing only the thread override would expose an older global `priority`
    // value again as soon as a new chat starts. Send the current effort with
    // the tier so a config reload cannot put the model default back.
    const serviceTier = shouldEnable ? FAST_SERVICE_TIER : DEFAULT_SERVICE_TIER;
    const effortToKeep = currentEffort;
    preserveEffortDuringFastToggle = true;
    void Promise.all([
      request(ctx, "thread/settings/update", {
        threadId,
        serviceTier,
        ...(effortToKeep ? { effort: effortToKeep } : {}),
      }),
      request(ctx, "config/batchWrite", {
        edits: [
          {
            keyPath: "service_tier",
            value: shouldEnable ? "fast" : DEFAULT_SERVICE_TIER,
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      }),
    ])
      .then(() => {
        currentServiceTier = serviceTier;
        if (effortToKeep) currentEffort = effortToKeep;
        ctx.emit({
          type: "session",
          serviceTier,
          ...(effortToKeep ? { effort: effortToKeep } : {}),
        });
        ctx.emit({
          type: "notice",
          tone: "info",
          text: `Fast Mode ${shouldEnable ? "enabled" : "disabled"}.`,
        });
      })
      .catch((error: unknown) => {
        const record = asRecord(error);
        ctx.emit({
          type: "notice",
          tone: "error",
          text: asString(record?.message) ?? "Codex could not change Fast Mode.",
        });
      })
      .finally(() => {
        preserveEffortDuringFastToggle = false;
      });
  }

  function handleCommand(
    text: string,
    ctx: AdapterContext,
    images: AgentImageAttachment[] = [],
  ): AgentCommandResult {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : text.slice(space + 1).trim();
    if (name === "/side" || name === "/btw") {
      startSideQuestion(name, arg, ctx, images);
      return "handled";
    }
    ctx.emit({ type: "user", text });

    if (name === "/model") {
      if (!arg) {
        const list = models.length
          ? models
              .map((model) => (model.id === currentModel ? `${model.id} (current)` : model.id))
              .join(", ")
          : "the model list has not loaded yet";
        ctx.emit({
          type: "notice",
          tone: "info",
          text: `Model: ${currentModel ?? "default"}. Available: ${list}.`,
        });
        return "handled";
      }
      const known = models.find((model) => model.id === arg || model.displayName === arg);
      if (models.length && !known) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown model "${arg}". Available: ${models.map((model) => model.id).join(", ")}.`,
        });
        return "handled";
      }
      currentModel = (known ?? { id: arg }).id;
      ctx.emit({ type: "session", model: currentModel });
      ctx.emit({ type: "notice", tone: "info", text: `Model set to ${currentModel}.` });
      return "handled";
    }

    if (name === "/effort") {
      const active = models.find((model) => model.id === currentModel);
      const options = active?.efforts ?? [];
      if (!arg) {
        ctx.emit({
          type: "notice",
          tone: "info",
          text: options.length
            ? `Effort: ${currentEffort ?? "default"}. ${currentModel} supports: ${options.join(", ")}.`
            : `Effort: ${currentEffort ?? "default"}.`,
        });
        return "handled";
      }
      const level = arg.toLowerCase();
      if (options.length && !options.includes(level)) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `${currentModel ?? "This model"} does not take "${arg}" effort. Pick ${options.join(", ")}.`,
        });
        return "handled";
      }
      currentEffort = level;
      ctx.emit({ type: "session", effort: level });
      ctx.emit({ type: "notice", tone: "info", text: `Effort set to ${level}.` });
      return "handled";
    }

    if (name === "/fast") {
      handleFastCommand(arg, ctx);
      return "handled";
    }

    if (name === "/compact") {
      if (threadId) {
        void request(ctx, "thread/compact/start", { threadId })
          .then(() => ctx.emit({ type: "notice", tone: "info", text: "Compacting the conversation…" }))
          .catch((error: unknown) => {
            const record = asRecord(error);
            ctx.emit({
              type: "notice",
              tone: "error",
              text: asString(record?.message) ?? "Codex could not compact the conversation.",
            });
          });
      }
      return "handled";
    }

    if (name === "/goal") {
      return handleGoalCommand(arg, ctx) ? "handled-turn" : "handled";
    }

    ctx.emit({
      type: "notice",
      tone: "error",
      text: `Unknown command ${name}. Codex knows /model, /effort, /fast, /compact, /goal, /side, and /btw.`,
    });
    return "handled";
  }

  function recoverStop(ctx: AdapterContext, generation: number): Promise<boolean> {
    if (disposed || generation !== rootTurnGeneration || !stoppedByUser) return Promise.resolve(false);
    if (stopRecovery?.generation === generation) return stopRecovery.promise;
    const promise = Promise.resolve().then(() => {
      if (!ctx.interruptFallback) throw new Error("Codex did not confirm that the work stopped.");
      return ctx.interruptFallback();
    }).then(() => {
      if (disposed || generation !== rootTurnGeneration || !stoppedByUser) return false;
      rememberRootTurnFinished(currentTurnId);
      cancelPendingRootCompletion();
      settleRootTurn(null);
      ctx.emit({ type: "runtime-tasks", tasks: [] });
      ctx.emit({ type: "turn-end" });
      return true;
    }).catch((error: unknown) => {
      if (disposed || generation !== rootTurnGeneration || !stoppedByUser) return false;
      cancelPendingRootCompletion();
      ctx.emit({ type: "notice", tone: "error", text:
        asString(asRecord(error)?.message) ?? (typeof error === "string" ? error : "Codex did not confirm that the work stopped.") });
      ctx.emit({ type: "status", status: "error", error: "Codex did not confirm that the work stopped." });
      ctx.emit({ type: "turn-end" });
      return false;
    });
    stopRecovery = { generation, promise };
    return promise;
  }

  function stopTurn(targetThread: string, turn: string, ctx: AdapterContext, generation: number): Promise<boolean> {
    return requestWithTimeout(ctx, nextId++, "turn/interrupt", { threadId: targetThread, turnId: turn }, stopTimeoutMs)
      .then(() => true).catch(() => recoverStop(ctx, generation));
  }

  function stopBackgroundWork(ctx: AdapterContext, generation: number): Promise<boolean>[] {
    const work: Promise<boolean>[] = [];
    const targets = new Set([threadId, ...children.keys(), ...sideThreads.keys()]);
    if (threadId && currentGoal?.status === "active") {
      const goal = currentGoal;
      work.push(requestWithTimeout(ctx, nextId++, "thread/goal/set", { threadId, status: "paused" }, stopTimeoutMs)
        .then(() => {
          if (disposed || generation !== rootTurnGeneration) return false;
          currentGoal = { ...goal, status: "paused" };
          ctx.emit({ type: "goal", goal: { objective: goal.objective, status: "paused" } });
          return true;
        }).catch(() => recoverStop(ctx, generation)));
    }
    for (const target of targets) {
      if (!target) continue;
      const childTurn = children.get(target)?.currentTurnId ?? sideThreads.get(target)?.currentTurnId;
      if (childTurn) work.push(stopTurn(target, childTurn, ctx, generation));
      work.push(requestWithTimeout(ctx, nextId++, "thread/backgroundTerminals/clean", { threadId: target }, stopTimeoutMs)
        .then(() => {
          if (!disposed && generation === rootTurnGeneration && target === threadId) {
            ctx.emit({ type: "runtime-tasks", tasks: [] });
          }
          return true;
        }).catch(() => recoverStop(ctx, generation)));
    }
    return work;
  }

  return {
    args: (_launch: AgentLaunch) => [],

    start: (ctx) => {
      void handshake(ctx);
    },

    authenticate,

    dispose: async (ctx) => {
      if (disposed) return;
      disposed = true;
      if (authPollTimer !== null) clearInterval(authPollTimer);
      if (childStreamFlushTimer !== null) clearTimeout(childStreamFlushTimer);
      cancelPendingRootCompletion();
      const active = [
        { threadId, turnId: currentTurnId },
        ...[...children].map(([threadId, child]) => ({ threadId, turnId: child.currentTurnId })),
        ...[...sideThreads].map(([threadId, side]) => ({ threadId, turnId: side.currentTurnId })),
      ];
      const sends: Promise<void>[] = [];
      const sendCleanup = (method: string, params: unknown) => {
        try {
          sends.push(Promise.resolve(ctx.send({ jsonrpc: "2.0", id: nextId++, method, params })));
        } catch {
          // Native teardown owns the backstop when the transport is gone.
        }
      };
      if (loginId) sendCleanup("account/login/cancel", { loginId });
      for (const entry of active) {
        if (!entry.threadId) continue;
        sendCleanup("thread/goal/set", { threadId: entry.threadId, status: "paused" });
        if (entry.turnId) sendCleanup("turn/interrupt", entry);
        sendCleanup("thread/backgroundTerminals/clean", { threadId: entry.threadId });
        sendCleanup("thread/unsubscribe", { threadId: entry.threadId });
      }
      for (const [id, waiting] of [...pending]) {
        ctx.cancelPendingSend?.(id);
        waiting.reject({ code: "duckweed_closed", message: "Codex connection closed." });
      }
      pending.clear();
      // Never wait indefinitely on a full pipe before the session invokes the
      // native teardown. Its separate control connection can finish cleanup.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(sends),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, stopTimeoutMs); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },

    receive: (line, ctx) => {
      if (disposed) return;
      const frame = parseJson(line);
      if (!frame) return;

      if (frame.id !== undefined && frame.method === undefined) {
        const id =
          typeof frame.id === "number" || typeof frame.id === "string"
            ? frame.id
            : null;
        if (id === null) return;
        ctx.acknowledgeSend?.(id);
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

      if (method === "account/updated") {
        accountUpdateVersion += 1;
        // Invalidates account-scoped caches even when two workspaces have the
        // same email and plan in account/read.
        accountGeneration += 1;
        accountCachesDirty = true;
        models = [];
        ctx.emit({ type: "session", models: [] });
        ctx.emit({ type: "extensions", extensions: [], extensionsLoaded: false, loading: false });
        void refreshAccount(ctx);
        return;
      }
      if (method === "account/login/completed") {
        if (loginId && asString(params.loginId) === loginId) {
          loginId = null;
          if (params.success !== true) ctx.emit({ type: "notice", tone: "error", text: asString(params.error) ?? "Codex sign-in did not complete." });
          else ctx.emit({ type: "notice", tone: "info", text: "Codex sign-in completed." });
        }
        void refreshAccount(ctx);
        return;
      }
      if (method === "skills/changed" || method === "app/list/updated" || method === "mcpServer/oauthLogin/completed" || method === "mcpServer/startupStatus/updated") {
        const target = asString(params.threadId);
        if (target && threadId && target !== threadId) return;
        if (params.failureReason === "reauthenticationRequired") ctx.emit({ type: "notice", tone: "error", text: `${asString(params.name) ?? "An MCP server"} needs to be reconnected because its sign-in expired.` });
        if (!authenticationRequired) void publishExtensions(ctx);
        return;
      }

      // A missing or expired credential is reported as a retrying `error`
      // notification after turn/start has already succeeded. Treat it as a
      // terminal auth failure immediately instead of leaving the turn active
      // through every reconnect attempt.
      if (method === "error") {
        const target = asString(params.threadId);
        if (target && target !== threadId && !children.has(target) && !sideThreads.has(target)) return;
        const error = asRecord(params.error);
        const detail = [asString(error?.message), asString(error?.additionalDetails)]
          .filter((part): part is string => Boolean(part))
          .join("\n");
        if (isAuthenticationFailure(detail)) {
          rejectedAuthVersion = accountUpdateVersion;
          const cachedSignedIn = accountSignedIn;
          applyAccount({ account: null, requiresOpenaiAuth: true }, ctx);
          accountSignedIn = cachedSignedIn;
          ctx.emit({ type: "notice", tone: "error", text: detail || "Codex authentication failed." });
          ctx.emit({ type: "status", status: "idle" });
        }
        return;
      }

      if (frame.id !== undefined) {
        const id = frame.id as string | number;
        if (method === "currentTime/read") {
          ctx.send({ jsonrpc: "2.0", id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
          return;
        }
        if (method === "item/permissions/requestApproval") {
          handlePermissionsApproval(id, params, ctx);
          return;
        }
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          handleApproval(id, method, params, ctx);
          return;
        }
        if (method === "item/tool/requestUserInput") {
          handleUserInput(id, params, ctx);
          return;
        }
        if (method === "mcpServer/elicitation/request") {
          handleMcpElicitation(id, params, ctx);
          return;
        }
        ctx.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Duckweed does not implement ${method}` },
        });
        return;
      }

      const eventThreadId = notificationThreadId(method, params);
      if (eventThreadId && sideThreads.has(eventThreadId)) {
        handleSideNotification(eventThreadId, method, params, ctx);
        return;
      }
      const nestedThread =
        method === "thread/started" ? asRecord(params.thread) : null;
      const parentThreadId = asString(nestedThread?.parentThreadId);
      const isChildThread =
        Boolean(eventThreadId) &&
        eventThreadId !== threadId &&
        (children.has(eventThreadId as string) || parentThreadId === threadId);
      if (eventThreadId && isChildThread) {
        handleChildNotification(eventThreadId, method, params, ctx);
        return;
      }
      // A notification from the conversation Duckweed just switched away
      // from is neither the new root nor one of its children.
      if (eventThreadId && threadId && eventThreadId !== threadId) return;
      // A continuation can emit items before turn/started (or lose that frame).
      // Reconcile its identity before the stale-turn filter discards live work.
      // A user prompt also clears the previous completion flags, so an
      // unconfirmed new turn has to be adopted the same way or its items stay
      // dropped and the pane freezes on the empty Thinking placeholder.
      const incomingTurnId = asString(params.turnId) ?? asString(asRecord(params.turn)?.id);
      const awaitingUnconfirmedRootTurn =
        rootTurnMayBeActive && currentTurnId === null;
      const liveOutput = method.startsWith("item/") || method === "turn/plan/updated";
      if (
        incomingTurnId && incomingTurnId !== currentTurnId &&
        !finishedRootTurnIds.has(incomingTurnId)
      ) {
        const rootTurnUnsettled = Boolean(
          rootPendingCompletion || rootTurnCompletionObserved || awaitingUnconfirmedRootTurn,
        );
        const continuesNewTurn =
          !completedRootTurnIds.has(incomingTurnId) &&
          rootTurnUnsettled &&
          (liveOutput || method === "turn/started");
        // Only a local fallback retired this turn, so new output means it was
        // still running. A finishing turn can still record leftover steered
        // input after the next one started, so user echoes prove nothing.
        const revivesClosedTurn =
          completedRootTurnIds.has(incomingTurnId) &&
          (currentTurnId === null || rootTurnUnsettled) &&
          liveOutput &&
          asString(asRecord(params.item)?.type) !== "userMessage";
        if (!stoppedByUser && (continuesNewTurn || revivesClosedTurn)) adoptRootTurn(incomingTurnId, ctx);
      }
      if (
        method === "turn/completed" && incomingTurnId && currentTurnId &&
        incomingTurnId !== currentTurnId
      ) {
        // Codex publishes thread idle just before turn/completed. When both
        // belong to a turn that was already replaced, the idle fallback armed
        // a completion for the newer turn, which is still running.
        if (!finishedRootTurnIds.has(incomingTurnId) && !rootTurnCompletionObserved) {
          if (rootPendingCompletion) cancelPendingRootCompletion();
          rootCompletionSeenDuringSteer = undefined;
        }
        rememberRootTurnCompleted(incomingTurnId);
        rememberRootTurnFinished(incomingTurnId);
      }
      if (!notificationBelongsToRoot(method, params)) return;
      handleNotification(method, params, ctx);
      if (rootStartRequestId !== null && currentTurnId && rootTurnStatusConfirmed &&
          (method === "turn/started" || liveOutput)) {
        ctx.acknowledgeSend?.(rootStartRequestId);
      }
    },

    prompt: (prompt, ctx) => {
      if (!threadId || authenticationRequired || disposed) return;
      stoppedByUser = false;
      cancelPendingRootCompletion();
      rootTurnCompletionObserved = false;
      rootTurnWasSteered = false;
      rootCompletionSeenDuringSteer = undefined;
      // Retire the previous turn immediately. Leaving its id current while
      // this request is unconfirmed makes every item from the new turn look
      // stale, which freezes the transcript on the empty Thinking stage.
      if (currentTurnId) rememberRootTurnCompleted(currentTurnId);
      currentTurnId = null;
      ctx.emit({ type: "user", text: prompt.text, images: prompt.images });
      ctx.emit({ type: "status", status: "working" });
      rootTurnMayBeActive = true;
      // The request is optimistic. A start response/notification, live item,
      // or active thread status must confirm it before thread-idle is allowed
      // to close this turn.
      rootTurnStatusConfirmed = false;
      const generation = ++rootTurnGeneration;
      const requestId = nextId++;
      rootStartRequestId = requestId;
      void requestWithTimeout(ctx, requestId, "turn/start", {
        threadId,
        input: [
          ...(prompt.text ? [{ type: "text", text: prompt.text }] : []),
          ...prompt.images.map((image) => ({
            type: "image",
            url: imagePayloadDataUrl(image),
          })),
          ...(prompt.parts ?? []).flatMap((part) => {
            if (part.type === "skill") {
              return part.path ? [{ type: "skill", name: part.name, path: part.path }] : [];
            }
            if (part.type === "app") {
              return [{ type: "mention", name: part.name, path: part.uri ?? `app://${part.id}` }];
            }
            if (part.type === "file") {
              return [{ type: "mention", name: part.name ?? part.path, path: part.path }];
            }
            if (part.type === "resource") {
              return [{ type: "mention", name: part.name ?? part.uri, path: part.uri }];
            }
            return [];
          }),
        ],
        ...turnAccessParams(currentAccess),
        ...(currentModel ? { model: currentModel } : {}),
        // Same sticky override semantics as `model`, and the same casing
        // discipline: `effort` is the exact field name in TurnStartParams.
        ...(currentEffort ? { effort: currentEffort } : {}),
        ...serviceTierParamsFor(currentModel),
      }, rpcTimeoutMs)
        .then((result) => {
          const responseTurn = asRecord(result.turn);
          const responseTurnId = asString(responseTurn?.id);
          if (!responseTurnId?.trim()) {
            if (generation !== rootTurnGeneration || !rootTurnMayBeActive ||
                (currentTurnId && rootTurnStatusConfirmed)) return;
            throw { code: "duckweed_invalid_turn", message: "Codex did not confirm the start of this message. Your message has been kept for retry." };
          }
          if (generation !== rootTurnGeneration || !rootTurnMayBeActive) {
            // A completion/status fallback won the race. Remember the late
            // response's id so it cannot be mistaken for a later fast turn.
            rememberRootTurnCompleted(responseTurnId);
            if (
              stopRequestedForGeneration === generation &&
              generation === rootTurnGeneration &&
              !finishedRootTurnIds.has(responseTurnId) &&
              threadId
            ) {
              // Stop arrived before the id did. Without this the turn kept
              // running unseen and swallowed the next prompt.
              stopRequestedForGeneration = null;
              void stopTurn(threadId, responseTurnId, ctx, generation)
                .then((stopped) => { if (stopped) rememberRootTurnFinished(responseTurnId); });
            }
            return;
          }
          if (finishedRootTurnIds.has(responseTurnId)) return;
          if (["completed", "interrupted", "failed"].includes(asString(responseTurn?.status) ?? "")) {
            currentTurnId = responseTurnId;
            rootTurnStatusConfirmed = true;
            handleNotification("turn/completed", { threadId, turn: responseTurn }, ctx);
            return;
          }
          if (completedRootTurnIds.has(responseTurnId)) {
            // On a busy thread Codex steers this input into the running turn
            // and answers with that turn's id, without a new turn/started.
            // Duckweed had closed it early, so it must become live again.
            adoptRootTurn(responseTurnId, ctx);
            return;
          }
          // The response is a second authoritative source for the ID. This
          // keeps interrupt and completion matching correct if the matching
          // `turn/started` notification was missed.
          currentTurnId ??= responseTurnId;
          rootTurnStatusConfirmed = true;
        })
        .catch((error: unknown) => {
          if (disposed || generation !== rootTurnGeneration || stoppedByUser || !rootTurnMayBeActive) return;
          // Coarse thread status does not prove this message was accepted. A
          // turn identity with live notifications does, even if its reply was lost.
          if (resumeErrorCode(error) === "duckweed_rpc_timeout" &&
              asRecord(error)?.cancelledBeforeDelivery !== true && currentTurnId && rootTurnStatusConfirmed) return;
          stoppedByUser = true;
          stopRequestedForGeneration = generation;
          cancelPendingRootCompletion();
          settleRootTurn(null);
          const record = asRecord(error);
          // Capacity errors confirm delivery and have their own optional follow-up flow.
          if (!isCodexCapacityError(asString(record?.message) ?? "")) {
            ctx.emit({ type: "prompt-failed", prompt });
          }
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? "Codex could not start the turn.",
          });
          ctx.emit({ type: "turn-end" });
          if (["duckweed_rpc_timeout", "duckweed_invalid_turn"].includes(resumeErrorCode(error) ?? "") && ctx.interruptFallback) {
            void recoverStop(ctx, generation);
          }
        })
        .finally(() => { if (rootStartRequestId === requestId) rootStartRequestId = null; });
    },

    steer: async (prompt, ctx) => {
      if (!threadId || !currentTurnId) return false;
      rootSteerRequestsInFlight += 1;
      // A terminal notification may already have armed the quiet window.
      // Steering means that boundary is no longer the end of the turn.
      const completionBeforeSteer = rootPendingCompletion;
      cancelPendingRootCompletion();
      try {
        await request(ctx, "turn/steer", {
          threadId,
          expectedTurnId: currentTurnId,
          input: [
            ...(prompt.text ? [{ type: "text", text: prompt.text }] : []),
            ...prompt.images.map((image) => ({
              type: "image",
              url: imagePayloadDataUrl(image),
            })),
          ],
        });
        rootTurnWasSteered = true;
        rootCompletionSeenDuringSteer = undefined;
        ctx.emit({
          type: "user",
          text: prompt.text,
          images: prompt.images,
          sameTurn: true,
        });
        return true;
      } catch {
        // If Codex rejected the steer after a terminal signal landed, restore
        // that boundary so the unmodified turn does not stay working forever.
        const pendingCompletion =
          rootCompletionSeenDuringSteer !== undefined
            ? { turnId: rootCompletionSeenDuringSteer }
            : completionBeforeSteer;
        if (
          rootSteerRequestsInFlight === 1 &&
          !rootTurnWasSteered &&
          pendingCompletion
        ) {
          rootCompletionVersion += 1;
          scheduleRootCompletion(pendingCompletion.turnId, ctx);
          rootCompletionSeenDuringSteer = undefined;
        }
        return false;
      } finally {
        rootSteerRequestsInFlight = Math.max(0, rootSteerRequestsInFlight - 1);
      }
    },

    inspectSubagent: async (callId, childThreadId, ctx) => {
      if (childThreadId) {
        const child = childFor(childThreadId);
        child.callId ??= callId;
        syncChild(childThreadId, ctx);
        return hydrateChild(childThreadId, ctx, true, true);
      }

      await discoverChildThreads(ctx);
      const linked = [...children.entries()].find(([, child]) => child.callId === callId);
      if (!linked) return false;
      return hydrateChild(linked[0], ctx, true, true);
    },

    promptSubagent: async (childThreadId, prompt, ctx) => {
      const child = children.get(childThreadId);
      if (!child || !prompt.text.trim()) return false;
      const input = [{ type: "text", text: prompt.text.trim() }];
      try {
        if (
          (child.state.status === "working" || child.state.status === "waiting") &&
          child.currentTurnId
        ) {
          await request(ctx, "turn/steer", {
            threadId: childThreadId,
            expectedTurnId: child.currentTurnId,
            input,
          });
        } else if (child.state.status === "idle") {
          hydratedChildren.delete(childThreadId);
          await request(ctx, "turn/start", {
            threadId: childThreadId,
            input,
            ...turnAccessParams(currentAccess),
            ...(child.model ? { model: child.model } : {}),
            ...(currentEffort ? { effort: currentEffort } : {}),
            ...serviceTierParamsFor(child.model),
          });
        } else {
          return false;
        }
        emitChild(childThreadId, { type: "user", text: prompt.text.trim() }, ctx);
        return true;
      } catch {
        emitChild(
          childThreadId,
          {
            type: "notice",
            tone: "error",
            text: "The message could not be delivered to this subagent.",
          },
          ctx,
        );
        return false;
      }
    },

    command: handleCommand,

    commandSupportsImages: (text) => /^\/(?:side|btw)(?:\s|$)/i.test(text.trim()),

    commandAvailableDuringTurn: (text) => {
      const trimmed = text.trim();
      // `/goal pause` has to land while the provider is working. `/side` and
      // `/btw` also run during a turn, but not while resume is still hydrating:
      // the session is `working` then, and a fork would race `thread/resume`.
      if (/^\/goal(?:\s|$)/i.test(trimmed)) return true;
      if (hydratingResume) return false;
      return /^\/(?:side|btw)(?:\s|$)/i.test(trimmed);
    },

    configureAccess: (mode, ctx) => {
      currentAccess = mode;
      ctx.emit({ type: "session", accessMode: mode });
      const label =
        mode === "default"
          ? "Agent default"
          : mode === "read-only"
            ? "Read only"
            : mode === "workspace"
              ? "Workspace"
              : "Full access";
      ctx.emit({
        type: "notice",
        tone: "info",
        text:
          mode === "default"
            ? "Access now inherits the Codex configuration. It applies to the next turn."
            : `Access set to ${label}. It applies to the next turn.`,
      });
      return true;
    },

    /**
     * `thread/resume` keeps the running process. Newer app-server builds page
     * the transcript. Load conversation summaries first and fetch tool details
     * in small item pages after the composer is available.
     *
     * Codex can leave a thread `active` with no running turn after an aborted
     * session. `thread/resume` then never answers. Time out, fork a copy (the
     * idle fork resumes immediately), and still paint whatever history pages
     * arrived so the composer does not sit on "Loading conversation" forever.
     */
    resume: (sessionId, ctx) => {
      stoppedByUser = false;
      currentGoal = null;
      cancelPendingRootCompletion();
      rootTurnCompletionObserved = false;
      hydratingResume = true;
      resumeAborted = false;
      ctx.emit({ type: "history-loading", loading: true });
      ctx.emit({ type: "status", status: "working" });
      ctx.emit({ type: "goal", goal: null });
      const previousThreadId = threadId;
      let targetId = sessionId;
      // Claim the target before awaiting `thread/resume`. A live resumed turn
      // can finish while that request or its transcript pages are in flight;
      // leaving the old id here used to route the real completion as a child.
      threadId = targetId;
      currentTurnId = null;
      rootTurnMayBeActive = true;
      rootTurnStatusConfirmed = false;
      const resumeGeneration = ++rootTurnGeneration;
      const resumeCompletionVersion = rootCompletionVersion;

      const callResume = (id: string): Promise<Record<string, unknown>> => {
        throwIfResumeAborted();
        const requestId = nextId++;
        resumeRequestId = requestId;
        return requestWithTimeout(ctx, requestId, "thread/resume", resumeThreadParams(id));
      };

      const recoverHungResume = async (hungId: string): Promise<Record<string, unknown>> => {
        throwIfResumeAborted();
        const forkRequestId = nextId++;
        resumeRequestId = forkRequestId;
        const forked = await requestWithTimeout(ctx, forkRequestId, "thread/fork", {
          threadId: hungId,
          excludeTurns: true,
          cwd: ctx.cwd,
          ...threadAccessParams(currentAccess),
          ...(currentModel ? { model: currentModel } : {}),
        });
        const copyId =
          asString(asRecord(forked.thread)?.id) ?? asString(forked.id);
        if (!copyId) throw { message: "Codex could not copy that thread." };
        threadId = copyId;
        targetId = copyId;
        return callResume(copyId);
      };

      const load = async (): Promise<boolean> => {
        let result: Record<string, unknown>;
        let recoveredFromHang = false;
        try {
          result = await callResume(targetId);
        } catch (error: unknown) {
          if (resumeErrorCode(error) !== RESUME_TIMEOUT) throw error;
          result = await recoverHungResume(targetId);
          recoveredFromHang = true;
        }
        throwIfResumeAborted();
        const thread = asRecord(result.thread) ?? result;
        threadId = asString(thread.id) ?? targetId;

        const initialPage = asRecord(result.initialTurnsPage);
        const paginated = initialPage !== null;
        const turns = paginated ? asArray(initialPage.data) : asArray(thread.turns);
        let cursor = paginated
          ? asString(initialPage?.nextCursor)
          : asString(result.turnsBackwardsCursor);
        const descending = paginated || cursor !== null;
        const seenCursors = new Set<string>();
        while (cursor && turns.length < MAX_RESUMED_TURNS) {
          throwIfResumeAborted();
          if (seenCursors.has(cursor)) break;
          seenCursors.add(cursor);
          const pageRequestId = nextId++;
          resumeRequestId = pageRequestId;
          try {
            const page = await requestWithTimeout(ctx, pageRequestId, "thread/turns/list", {
              threadId,
              cursor,
              limit: Math.min(RESUME_PAGE_SIZE, MAX_RESUMED_TURNS - turns.length),
              sortDirection: "desc",
              itemsView: "summary",
            });
            turns.push(...asArray(page.data));
            cursor = asString(page.nextCursor);
          } catch (error: unknown) {
            if (resumeErrorCode(error) === RESUME_CANCELLED) throw error;
            // A hung or unsupported page must not keep the composer locked.
            // Replay whatever already arrived.
            cursor = null;
          }
        }

        // Descending pagination starts at the newest turn. The transcript
        // renderer expects natural conversation order from oldest to newest.
        const chronologicalTurns = descending ? turns.reverse() : turns;
        replayTurns(chronologicalTurns, ctx);
        void discoverChildThreads(ctx, true);
        if (recoveredFromHang) {
          ctx.emit({
            type: "notice",
            tone: "info",
            text: "Codex did not resume that conversation, so Duckweed opened a copy of it.",
          });
        }
        const hydrated = hydratedTurnId({ ...thread, turns: chronologicalTurns });
        const hydratedActiveTurn =
          hydrated && !completedRootTurnIds.has(hydrated) ? hydrated : null;
        const completionAlreadyObserved = rootCompletionTimer !== null;
        const completionBeatSnapshot = rootCompletionVersion !== resumeCompletionVersion;
        if (completionBeatSnapshot) {
          // A live notification is newer than the resume snapshot. In
          // particular, do not let a hydrated idle consume the user-owned
          // working stretch before its quiet-window turn end is emitted, or
          // resurrect a finished turn after that turn end has fired.
          if (!rootTurnMayBeActive) {
            currentTurnId = null;
            rootTurnStatusConfirmed = false;
          }
        } else if (rootTurnGeneration !== resumeGeneration) {
          currentTurnId = null;
          rootTurnMayBeActive = false;
          rootTurnStatusConfirmed = false;
        } else if (rootTurnStatusConfirmed) {
          // Preserve activity observed while pages were loading, including a
          // working status that did not carry a turn id.
          currentTurnId ??= hydratedActiveTurn;
          rootTurnMayBeActive = true;
        } else {
          currentTurnId = hydratedActiveTurn;
          // The persisted thread status can lag behind its turns. Only an
          // unfinished hydrated turn proves background work is still live.
          rootTurnMayBeActive = currentTurnId !== null;
          rootTurnStatusConfirmed = rootTurnMayBeActive;
        }
        // `thread/start` reports the model beside the thread, `thread/resume`
        // inside it; neither is guaranteed, so take whichever is there.
        const model = asString(result.model) ?? asString(thread.model);
        if (model) currentModel = model;
        currentServiceTier = asString(result.serviceTier);
        ctx.emit({
          type: "session",
          sessionId: asString(thread.sessionId) ?? threadId,
          ...(model ? { model } : {}),
          serviceTier: currentServiceTier,
        });
        ctx.emit({ type: "goal", goal: null });
        void request(ctx, "thread/goal/get", { threadId })
          .then((goalResult) => {
            const goal = readGoal(goalResult.goal);
            currentGoal = goal;
            ctx.emit({
              type: "goal",
              goal: goal ? { objective: goal.objective, status: goal.status } : null,
            });
          })
          .catch(() => {
            // Older app-server builds can resume threads without goal support.
          });
        // A thread can still own a live background turn when it is resumed.
        // Preserve that turn id so follow-ups steer the resumed work instead
        // of being rejected and queued against the temporary blank thread.
        // Drop the hydration gate before the status emit so a queued `/side`
        // released on idle, or one typed against a live resumed turn, can
        // fork the now-complete thread instead of racing it.
        hydratingResume = false;
        const detailGeneration = rootTurnGeneration;
        if (!completionAlreadyObserved) {
          ctx.emit({
            type: "status",
            status: rootTurnMayBeActive ? "working" : "idle",
          });
        }
        void hydrateResumedItems(chronologicalTurns, threadId!, detailGeneration, ctx);
        return true;
      };

      return load()
        .catch((error: unknown) => {
          hydratingResume = false;
          if (rootTurnGeneration === resumeGeneration) {
            threadId = previousThreadId;
            settleRootTurn(null);
          }
          const record = asRecord(error);
          if (resumeErrorCode(error) !== RESUME_CANCELLED) {
            ctx.emit({
              type: "notice",
              tone: "error",
              text:
                resumeErrorCode(error) === RESUME_TIMEOUT
                  ? "Codex did not resume that conversation."
                  : asString(record?.message) ?? "Codex could not resume that thread.",
            });
          }
          ctx.emit({ type: "status", status: "idle" });
          return false;
        })
        .finally(() => {
          resumeRequestId = null;
          hydratingResume = false;
          ctx.emit({ type: "history-loading", loading: false });
        });
    },

    interrupt: (ctx) => {
      cancelPendingRootCompletion();
      if (rootStartRequestId !== null && ctx.cancelPendingSend?.(rootStartRequestId)) {
        const id = rootStartRequestId;
        rootStartRequestId = null;
        pending.get(id)?.reject({ code: "duckweed_prompt_cancelled" });
      }
      if (resumeRequestId !== null || hydratingResume) {
        resumeAborted = true;
      }
      if (resumeRequestId !== null) {
        const requestId = resumeRequestId;
        resumeRequestId = null;
        const inFlight = pending.get(requestId);
        pending.delete(requestId);
        inFlight?.reject({ code: RESUME_CANCELLED });
        ctx.cancelPendingSend?.(requestId);
        notify(ctx, "$/cancelRequest", { id: requestId });
        return;
      }
      if (hydratingResume) {
        // Gap between a timed-out resume RPC and the fork that recovers it.
        // load() sees `resumeAborted` on the next step and settles.
        return;
      }
      if (!threadId || !currentTurnId) {
        // Working without an interruptible turn is stale adapter state. Let the
        // session recover instead of leaving a Stop button that cannot work.
        // A pending turn/start still interrupts its turn once the id arrives.
        if (rootTurnMayBeActive) {
          stoppedByUser = true;
          stopRequestedForGeneration = rootTurnGeneration;
          stopBackgroundWork(ctx, rootTurnGeneration);
          if (ctx.interruptFallback) {
            void recoverStop(ctx, rootTurnGeneration);
            return;
          }
        }
        settleRootTurn(null);
        ctx.emit({ type: "turn-end" });
        return;
      }
      const turnId = currentTurnId;
      const generation = rootTurnGeneration;
      stoppedByUser = true;
      const work = stopBackgroundWork(ctx, generation);
      work.push(stopTurn(threadId, turnId, ctx, generation));
      void Promise.all(work).then((stopped) => {
        if (stopped.some((result) => !result) || disposed || generation !== rootTurnGeneration || currentTurnId !== turnId) return;
        rememberRootTurnFinished(turnId);
        cancelPendingRootCompletion();
        settleRootTurn(turnId);
        ctx.emit({ type: "turn-end" });
      });
    },

    respond: (permissionId, optionId, ctx) => {
      const approval = approvals.get(permissionId);
      if (!approval) {
        const pendingQuestion = questions.get(permissionId);
        if (!pendingQuestion) return;
        questions.delete(permissionId);
        ctx.send({
          jsonrpc: "2.0",
          id: pendingQuestion.id,
          result:
            pendingQuestion.kind === "user-input"
              ? { answers: {} }
              : {
                  action: optionId === "deny" ? "decline" : "cancel",
                  content: null,
                  _meta: null,
                },
        });
        ctx.emit({ type: "permission", permission: null });
        ctx.emit({ type: "status", status: "working" });
        return;
      }
      approvals.delete(permissionId);
      ctx.send({ jsonrpc: "2.0", id: approval.id, result: approval.kind === "permissions" ? {
        permissions: optionId === "accept" || optionId === "acceptForSession" ? approval.permissions ?? {} : {},
        scope: optionId === "acceptForSession" ? "session" : "turn",
      } : { decision: optionId } });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },

    answer: (permissionId, answers: AgentQuestionAnswer[], ctx) => {
      const pendingQuestion = questions.get(permissionId);
      if (!pendingQuestion) return;
      questions.delete(permissionId);
      if (pendingQuestion.kind === "user-input") {
        const payload = Object.fromEntries(
          answers.map((answer) => [
            answer.questionId,
            { answers: [...answer.labels, ...(answer.custom ? [answer.custom] : [])] },
          ]),
        );
        ctx.send({ jsonrpc: "2.0", id: pendingQuestion.id, result: { answers: payload } });
      } else if (pendingQuestion.kind === "mcp-url") {
        const accepted = answers.some((answer) => answer.labels.length || answer.custom);
        ctx.send({
          jsonrpc: "2.0",
          id: pendingQuestion.id,
          result: { action: accepted ? "accept" : "cancel", content: null, _meta: null },
        });
      } else {
        const entries: [string, unknown][] = answers.flatMap((answer) => {
          const field = pendingQuestion.fields?.get(answer.questionId);
          if (!field) return [] as [string, unknown][];
          const rawValues = [
            ...answer.labels,
            ...(answer.custom !== null ? [answer.custom] : []),
          ];
          if (rawValues.length === 0) return [] as [string, unknown][];
          const valueFor = (raw: string): unknown =>
            field.choices.has(raw) ? field.choices.get(raw) : raw;
          if (field.type === "array") {
            return [[answer.questionId, rawValues.map(valueFor)] as [string, unknown]];
          }
          const raw = answer.custom ?? answer.labels[0];
          if (raw === undefined) return [] as [string, unknown][];
          const selected = valueFor(raw);
          if (field.type === "boolean") {
            const value =
              typeof selected === "boolean"
                ? selected
                : String(selected).toLowerCase() === "true";
            return [[answer.questionId, value] as [string, unknown]];
          }
          if (field.type === "number" || field.type === "integer") {
            const value = Number(selected);
            const valid = Number.isFinite(value) && (field.type !== "integer" || Number.isInteger(value));
            return valid ? [[answer.questionId, value] as [string, unknown]] : [];
          }
          return [[answer.questionId, selected] as [string, unknown]];
        });
        const content = Object.fromEntries(entries);
        ctx.send({
          jsonrpc: "2.0",
          id: pendingQuestion.id,
          result: { action: "accept", content, _meta: null },
        });
      }
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },

    refreshExtensions: listExtensions,
    refreshTasks: listRuntimeTasks,
    stopTask: async (processId, ctx) => {
      if (!threadId) return false;
      await requestWithTimeout(ctx, nextId++, "thread/backgroundTerminals/terminate", { threadId, processId }, stopTimeoutMs);
      return true;
    },
  };
}
