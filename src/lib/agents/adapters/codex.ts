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
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import {
  emptyUsage,
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
 * verified against codex 0.145. There is no slash-command channel: the TUI's
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
const RESUME_PAGE_SIZE = 100;
const MAX_RESUMED_TURNS = 500;
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
  /** Test seam; production uses the same 800 ms quiet window as raw Codex. */
  completionQuietMs?: number;
  /** Test seam; production batches nested transcript paints to this cadence. */
  childStreamPublishMs?: number;
  /**
   * How long `thread/resume` and history pages may sit unanswered before
   * Duckweed cancels them. Codex can hang forever on a stale-active thread;
   * production recovers by forking. `0` disables the timer (interrupt-only).
   */
  resumeTimeoutMs?: number;
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

/** Codex sends a unified patch per changed file. */
function readFileChanges(raw: unknown): AgentFileChange[] {
  return asArray(raw)
    .map((entry) => asRecord(entry))
    .filter((change): change is Record<string, unknown> => change !== null)
    .map((change) => {
      const path = asString(change.path) ?? "";
      return makePatchChange(path, asString(change.diff) ?? "");
    })
    .filter((change) => change.path);
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const completionQuietMs = options.completionQuietMs ?? ROOT_COMPLETION_QUIET_MS;
  const childStreamPublishMs =
    options.childStreamPublishMs ?? DEFAULT_CHILD_STREAM_PUBLISH_MS;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? RESUME_RPC_TIMEOUT_MS;
  let nextId = 1;
  const pending = new Map<RequestKey, Pending>();
  let threadId: string | null = null;
  let currentTurnId: string | null = null;
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
  /** Advances when a live root completion beats an in-flight resume snapshot. */
  let rootCompletionVersion = 0;
  /** Bounded memory of completions used to reject stale RPC/resume snapshots. */
  const completedRootTurnIds = new Set<string>();
  let rootCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A completion is not settled until its quiet window expires. Keeping the
   * provider turn addressable lets Stop and same-turn steering win races with
   * terminal notifications, while a new auto-continuation can cancel it.
   */
  let rootPendingCompletion: { turnId: string | null } | null = null;
  /** Same-turn input makes the first final answer non-terminal. */
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
  const approvals = new Map<string, { id: string | number; kind: "command" | "file" }>();
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
  /** One pending parent publish per streaming child. */
  const childSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let childDiscoveryInFlight: Promise<void> | null = null;
  let childDiscoveryRequested = false;
  let childDiscoveryShouldSynthesize = false;
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

  function syncChild(childThreadId: string, ctx: AdapterContext): void {
    const pendingTimer = childSyncTimers.get(childThreadId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      childSyncTimers.delete(childThreadId);
    }
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

  /**
   * Publish a child at a readable cadence while it streams. Sending the full
   * nested snapshot every animation frame made React repeatedly traverse the
   * same conversation and could grow WebView2 to several gigabytes.
   */
  function scheduleChildSync(childThreadId: string, ctx: AdapterContext): void {
    if (childStreamPublishMs <= 0) {
      syncChild(childThreadId, ctx);
      return;
    }
    if (childSyncTimers.has(childThreadId)) return;
    const timer = setTimeout(() => {
      childSyncTimers.delete(childThreadId);
      syncChild(childThreadId, ctx);
    }, childStreamPublishMs);
    childSyncTimers.set(childThreadId, timer);
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
    child.state = applyEvent(child.state, event);
    const streaming =
      event.type === "assistant-delta" ||
      event.type === "thinking-delta" ||
      (event.type === "tool" && event.outputDelta !== undefined);
    if (streaming) scheduleChildSync(childThreadId, ctx);
    else syncChild(childThreadId, ctx);
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

    const hydration = request(ctx, "thread/read", {
      threadId: childThreadId,
      includeTurns: true,
    })
      .then((result) => {
        const thread = asRecord(result.thread) ?? result;
        const child = childFor(childThreadId);
        child.label =
          asString(thread.agentNickname) ?? asString(thread.nickname) ?? child.label;
        child.role = asString(thread.agentRole) ?? asString(thread.role) ?? child.role;
        child.model = asString(thread.model) ?? child.model;
        const status = threadStatus(thread.status) ?? "idle";
        if (
          status === "working" &&
          (!child.hasLiveStatus || child.state.status === "working")
        ) {
          // The parent collaboration item independently reported this child as
          // running, so its coarse thread status is corroborated here.
          child.currentTurnId ??= hydratedTurnId(thread, true);
        } else if (!child.hasLiveStatus) {
          child.currentTurnId = null;
        }

        // A thread/read response is a replacement snapshot. Replaying it on
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
        for (const rawTurn of asArray(thread.turns)) {
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
        // Live status events can overtake thread/read. Never flash a completed
        // child back to working because an older snapshot arrived late.
        if (!child.hasLiveStatus) {
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
      void hydrateChild(childThreadId, ctx);
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
            adoptChildThread(childThread, ctx, synthesize);
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
    return requestWithId(ctx, nextId++, method, params);
  }

  function requestWithId(
    ctx: AdapterContext,
    id: RequestKey,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ctx.send({ jsonrpc: "2.0", id, method, params });
    });
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
  ): Promise<Record<string, unknown>> {
    if (resumeTimeoutMs <= 0) return requestWithId(ctx, id, method, params);
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
          notify(ctx, "$/cancelRequest", { id });
          reject({
            code: RESUME_TIMEOUT,
            message: "Codex did not resume that conversation.",
          });
        });
      }, resumeTimeoutMs);
      pending.set(id, {
        resolve: (result) => finish(() => resolve(result)),
        reject: (error) => finish(() => reject(error)),
      });
      ctx.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function resumeThreadParams(targetId: string): Record<string, unknown> {
    return {
      threadId: targetId,
      excludeTurns: true,
      initialTurnsPage: {
        limit: RESUME_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "full",
      },
    };
  }

  function notify(ctx: AdapterContext, method: string, params: unknown) {
    ctx.send({ jsonrpc: "2.0", method, params });
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
    const result = await request(ctx, "thread/backgroundTerminals/list", { threadId, limit: 100 });
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
      notify(ctx, "initialized", {});

      // thread/start succeeds without credentials. The first turn then
      // retries a 401 several times, which used to leave the UI working
      // forever. account/read detects that state before opening the thread.
      try {
        const account = await requestWithId(
          ctx,
          "duckweed-account-read",
          "account/read",
          { refreshToken: false },
        );
        if (account.requiresOpenaiAuth === true && account.account == null) {
          ctx.emit({
            type: "status",
            status: "error",
            error: "Codex is not signed in.",
          });
          return;
        }
      } catch {
        // Older app-server builds do not expose account/read. Continue and
        // catch any auth failure from the provider's normal error stream.
      }

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
      threadId = asString(started.id);
      if (!threadId) {
        ctx.emit({ type: "status", status: "error", error: "Codex did not return a thread id." });
        return;
      }
      // The response names the model and effort the thread actually got.
      // An explicit launch flag still wins: the server has not seen it yet
      // (thread/start carries no effort), so its answer here is the default,
      // and the first turn/start is what applies the request.
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
      void request(ctx, "model/list", {})
        .then((result) => {
          const advertisedModels = asArray(result.data)
            .map((raw) => asRecord(raw))
            .filter((model): model is Record<string, unknown> => model !== null)
            .map((model) => ({
              id: asString(model.id) ?? "",
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
          models = advertisedModels.filter((model) => !model.hidden);
          if (models.length) {
            const hiddenCurrent = advertisedModels.some(
              (model) =>
                model.hidden &&
                (model.id === currentModel || model.displayName === currentModel),
            );
            let repairedModel: string | undefined;
            if (hiddenCurrent) {
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
          }
        })
        .catch(() => {
          // A server too old for model/list just leaves validation lenient.
        });
    } catch (error) {
      const record = asRecord(error);
      ctx.emit({
        type: "status",
        status: "error",
        error: asString(record?.message) ?? "Codex refused to start a thread.",
      });
    }
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
        const agentPath = asString(item.agentPath);
        const agentThreadId = asString(item.agentThreadId);
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
            status: kind === "interrupted" ? "error" : kind === "started" ? "working" : "idle",
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
          status: kind === "interrupted" ? "error" : kind === "started" ? "running" : "done",
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
      // Live root output proves that an uncertain resume really rejoined work.
      // It lets the later thread-idle fallback finish the turn even if both
      // turn boundary notifications were the frames that went missing.
      rootTurnStatusConfirmed = true;
    }
    switch (method) {
      case "thread/goal/updated": {
        const goal = readGoal(params.goal);
        if (goal) {
          ctx.emit({
            type: "goal",
            goal: { objective: goal.objective, status: goal.status },
          });
        }
        return;
      }
      case "thread/goal/cleared":
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
        const continuesAfterPendingCompletion = Boolean(
          rootPendingCompletion &&
          startedTurnId &&
          startedTurnId !== currentTurnId,
        );
        if (!continuesAfterPendingCompletion && rootTurnSignalIsStale(startedTurnId)) return;
        if (startedTurnId !== currentTurnId) {
          rootTurnWasSteered = false;
          rootCompletionSeenDuringSteer = undefined;
        }
        cancelPendingRootCompletion();
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
          cancelPendingRootCompletion();
          rootTurnMayBeActive = true;
          rootTurnStatusConfirmed = true;
          ctx.emit({ type: "status", status: "working" });
        } else if (status === "idle") {
          // This is Codex's thread-level reconciliation channel. It closes the
          // turn when a start/completed notification was lost or reordered.
          const wasActive = rootTurnStatusConfirmed || currentTurnId !== null;
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
        if (
          rootTurnMayBeActive &&
          asString(item.type) === "agentMessage" &&
          asString(item.phase) === "final_answer"
        ) {
          // `final_answer` is a semantic terminal signal in the Codex schema.
          // Use it when the visible answer arrives but the turn-completed and
          // thread-idle frames are missing, which would otherwise strand the
          // pane in working and suppress both completion effects.
          if (rootSteerRequestsInFlight > 0) {
            rootCompletionSeenDuringSteer = itemTurnId;
          } else if (!rootTurnWasSteered) {
            rootCompletionVersion += 1;
            scheduleRootCompletion(itemTurnId, ctx);
          }
        }
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
      return (
        !currentTurnId ||
        eventTurnId === currentTurnId ||
        Boolean(
          rootPendingCompletion &&
          eventTurnId &&
          !completedRootTurnIds.has(eventTurnId),
        )
      );
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

  function handleUserInput(
    id: string | number,
    params: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
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

  return {
    args: (_launch: AgentLaunch) => [],

    start: (ctx) => {
      void handshake(ctx);
    },

    receive: (line, ctx) => {
      const frame = parseJson(line);
      if (!frame) return;

      if (frame.id !== undefined && frame.method === undefined) {
        const id =
          typeof frame.id === "number" || typeof frame.id === "string"
            ? frame.id
            : null;
        if (id === null) return;
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

      // A missing or expired credential is reported as a retrying `error`
      // notification after turn/start has already succeeded. Treat it as a
      // terminal auth failure immediately instead of leaving the turn active
      // through every reconnect attempt.
      if (method === "error") {
        const error = asRecord(params.error);
        const detail = [asString(error?.message), asString(error?.additionalDetails)]
          .filter((part): part is string => Boolean(part))
          .join("\n");
        if (isAuthenticationFailure(detail)) {
          ctx.emit({
            type: "status",
            status: "error",
            error: detail || "Codex authentication failed.",
          });
        }
        return;
      }

      if (frame.id !== undefined) {
        const id = frame.id as string | number;
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
      if (!notificationBelongsToRoot(method, params)) return;
      handleNotification(method, params, ctx);
    },

    prompt: (prompt, ctx) => {
      if (!threadId) return;
      cancelPendingRootCompletion();
      rootTurnWasSteered = false;
      rootCompletionSeenDuringSteer = undefined;
      ctx.emit({ type: "user", text: prompt.text, images: prompt.images });
      ctx.emit({ type: "status", status: "working" });
      rootTurnMayBeActive = true;
      // The request is optimistic. A start response/notification, live item,
      // or active thread status must confirm it before thread-idle is allowed
      // to close this turn.
      rootTurnStatusConfirmed = false;
      const generation = ++rootTurnGeneration;
      void request(ctx, "turn/start", {
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
      })
        .then((result) => {
          const responseTurnId = asString(asRecord(result.turn)?.id);
          if (!responseTurnId) return;
          if (generation !== rootTurnGeneration || !rootTurnMayBeActive) {
            // A completion/status fallback won the race. Remember the late
            // response's id so it cannot be mistaken for a later fast turn.
            rememberRootTurnCompleted(responseTurnId);
            return;
          }
          if (!completedRootTurnIds.has(responseTurnId)) {
            // The response is a second authoritative source for the ID. This
            // keeps interrupt and completion matching correct if the matching
            // `turn/started` notification was missed.
            currentTurnId ??= responseTurnId;
            rootTurnStatusConfirmed = true;
          }
        })
        .catch((error: unknown) => {
          if (generation !== rootTurnGeneration) return;
          cancelPendingRootCompletion();
          settleRootTurn(null);
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? "Codex could not start the turn.",
          });
          ctx.emit({ type: "turn-end" });
        });
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
     * the transcript, so hydrate bounded full-detail pages before replaying it.
     *
     * Codex can leave a thread `active` with no running turn after an aborted
     * session. `thread/resume` then never answers. Time out, fork a copy (the
     * idle fork resumes immediately), and still paint whatever history pages
     * arrived so the composer does not sit on "Loading conversation" forever.
     */
    resume: (sessionId, ctx) => {
      cancelPendingRootCompletion();
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
        while (cursor && turns.length < MAX_RESUMED_TURNS) {
          throwIfResumeAborted();
          const pageRequestId = nextId++;
          resumeRequestId = pageRequestId;
          try {
            const page = await requestWithTimeout(ctx, pageRequestId, "thread/turns/list", {
              threadId,
              cursor,
              limit: Math.min(RESUME_PAGE_SIZE, MAX_RESUMED_TURNS - turns.length),
              sortDirection: "desc",
              itemsView: "full",
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
        if (!completionAlreadyObserved) {
          ctx.emit({
            type: "status",
            status: rootTurnMayBeActive ? "working" : "idle",
          });
        }
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
      if (resumeRequestId !== null || hydratingResume) {
        resumeAborted = true;
      }
      if (resumeRequestId !== null) {
        const requestId = resumeRequestId;
        resumeRequestId = null;
        const inFlight = pending.get(requestId);
        pending.delete(requestId);
        inFlight?.reject({ code: RESUME_CANCELLED });
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
        ctx.emit({ type: "turn-end" });
        return;
      }
      const turnId = currentTurnId;
      void request(ctx, "turn/interrupt", { threadId, turnId })
        .then(() => {
          if (currentTurnId !== turnId) return;
          currentTurnId = null;
          ctx.emit({ type: "turn-end" });
        })
        .catch(() => {
          // The turn may have finished between the click and the call. Either
          // way, keeping the local session marked as working would be stale.
          if (currentTurnId !== turnId) return;
          currentTurnId = null;
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
      ctx.send({ jsonrpc: "2.0", id: approval.id, result: { decision: optionId } });
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
      await request(ctx, "thread/backgroundTerminals/terminate", { threadId, processId });
      return true;
    },
  };
}
