import {
  asArray,
  asRecord,
  asString,
  imagePayloadDataUrl,
  oneLine,
  parseJson,
  type AdapterContext,
  type AgentAdapter,
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
  type AgentItem,
  type AgentSessionState,
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

interface ChildThread {
  callId: string | null;
  label: string | null;
  role: string | null;
  model: string | null;
  prompt: string | null;
  activity: string | null;
  currentTurnId: string | null;
  state: AgentSessionState;
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

export function createCodexAdapter(): AgentAdapter {
  let nextId = 1;
  const pending = new Map<RequestKey, Pending>();
  let threadId: string | null = null;
  let currentTurnId: string | null = null;
  /**
   * The model and effort turns run with. Seeded from the launch flags,
   * corrected by the `thread/start` response, and moved by /model and
   * /effort — `turn/start` overrides persist server-side, but keeping our
   * own copy means the header and every request always agree.
   */
  let currentModel: string | null = null;
  let currentEffort: string | null = null;
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
  /** Child thread id to its live, independently reduced transcript. */
  const children = new Map<string, ChildThread>();
  /** Avoid issuing the same final transcript reconciliation more than once. */
  const hydratedChildren = new Set<string>();

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

  function emitChild(
    childThreadId: string,
    event: AgentEvent,
    ctx: AdapterContext,
  ): void {
    const child = childFor(childThreadId);
    child.state = applyEvent(child.state, event);
    syncChild(childThreadId, ctx);
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

  function hydratedTurnId(thread: Record<string, unknown>): string | null {
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
    return threadStatus(thread.status) === "working"
      ? asString(turns.at(-1)?.id)
      : null;
  }

  function hydrateChild(childThreadId: string, ctx: AdapterContext): void {
    if (hydratedChildren.has(childThreadId)) return;
    hydratedChildren.add(childThreadId);
    void request(ctx, "thread/read", { threadId: childThreadId, includeTurns: true })
      .then((result) => {
        const thread = asRecord(result.thread) ?? result;
        const child = childFor(childThreadId);
        child.label =
          asString(thread.agentNickname) ?? asString(thread.nickname) ?? child.label;
        child.role = asString(thread.agentRole) ?? asString(thread.role) ?? child.role;
        child.model = asString(thread.model) ?? child.model;
        const status = threadStatus(thread.status) ?? "idle";
        if (status === "working") {
          child.currentTurnId ??= hydratedTurnId(thread);
        } else {
          child.currentTurnId = null;
        }

        const nested = childContext(childThreadId, ctx);
        emitChild(childThreadId, { type: "transcript" }, ctx);
        for (const rawTurn of asArray(thread.turns)) {
          const turn = asRecord(rawTurn);
          if (!turn) continue;
          for (const rawItem of asArray(turn.items)) {
            const item = asRecord(rawItem);
            if (!item) continue;
            if (asString(item.type) === "userMessage") {
              const text = asArray(item.content)
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => entry !== null)
                .filter((entry) => asString(entry.type) === "text")
                .map((entry) => asString(entry.text) ?? "")
                .filter(Boolean)
                .join("\n");
              if (text) nested.emit({ type: "user", text });
              continue;
            }
            handleItem(item, true, nested);
          }
        }
        emitChild(
          childThreadId,
          {
            type: "status",
            status,
          },
          ctx,
        );
      })
      .catch(() => {
        // Live child notifications remain the source of truth when this
        // app-server build does not expose thread/read for delegated threads.
      });
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

  function notify(ctx: AdapterContext, method: string, params: unknown) {
    ctx.send({ jsonrpc: "2.0", method, params });
  }

  async function handshake(ctx: AdapterContext) {
    try {
      await request(ctx, "initialize", {
        clientInfo: { name: "duckweed", title: "Duckweed", version: "0.1.0" },
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
      ctx.emit({
        type: "session",
        sessionId: asString(started.sessionId) ?? threadId,
        ...(currentModel ? { model: currentModel } : {}),
        ...(currentEffort ? { effort: currentEffort } : {}),
      });
      ctx.emit({ type: "status", status: "idle" });

      // Not awaited: /model and /effort validate leniently until this lands.
      void request(ctx, "model/list", {})
        .then((result) => {
          models = asArray(result.data)
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
              isDefault: model.isDefault === true,
            }))
            .filter((model) => model.id);
          if (models.length) {
            ctx.emit({
              type: "session",
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
  function handleItem(item: Record<string, unknown>, settled: boolean, ctx: AdapterContext) {
    const id = asString(item.id);
    const type = asString(item.type);
    if (!id || !type) return;

    switch (type) {
      case "agentMessage": {
        if (!settled) return;
        const text = asString(item.text) ?? "";
        if (text && !streamed.has(`am-${id}`)) {
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
        if (text && !streamed.has(`rs-${id}`)) {
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
        const receiverIds = asArray(item.receiverThreadIds)
          .map((entry) => asString(entry) ?? "")
          .filter(Boolean);
        const states = asRecord(item.agentsStates);
        const stateEntries = states ? Object.entries(states) : [];
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
          for (const receiverId of receiverIds) {
            const child = childFor(receiverId);
            child.callId = id;
            child.label = prompt ? oneLine(prompt, 80) : child.label;
            child.model = model ?? child.model;
            child.prompt = prompt ?? child.prompt;
            child.activity = activity ? oneLine(activity, 120) : child.activity;
            if (childStatus && childStatus !== "pending") {
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
            if (settled) hydrateChild(receiverId, ctx);
          }
        }
        return;
      }
      case "subAgentActivity": {
        const kind = asString(item.kind) ?? "interacted";
        const agentPath = asString(item.agentPath);
        const agentThreadId = asString(item.agentThreadId);
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

  /** Rebuild the visible transcript returned inside `thread/resume`. */
  function replayThread(thread: Record<string, unknown>, ctx: AdapterContext) {
    ctx.emit({ type: "transcript" });
    streamed.clear();

    for (const rawTurn of asArray(thread.turns)) {
      const turn = asRecord(rawTurn);
      if (!turn) continue;
      for (const rawItem of asArray(turn.items)) {
        const item = asRecord(rawItem);
        if (!item) continue;
        if (asString(item.type) === "userMessage") {
          const text = asArray(item.content)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
            .filter((entry) => asString(entry.type) === "text")
            .map((entry) => asString(entry.text) ?? "")
            .filter(Boolean)
            .join("\n");
          if (text) ctx.emit({ type: "user", text });
          continue;
        }
        handleItem(item, true, ctx);
      }
    }
  }

  function handleNotification(method: string, params: Record<string, unknown>, ctx: AdapterContext) {
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
        const turn = asRecord(params.turn);
        currentTurnId = asString(turn?.id);
        ctx.emit({ type: "status", status: "working" });
        return;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const error = asRecord(turn?.error);
        if (error) {
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(error.message) ?? "The turn failed.",
          });
        }
        currentTurnId = null;
        ctx.emit({ type: "turn-end" });
        return;
      }
      case "item/started":
        handleItem(asRecord(params.item) ?? {}, false, ctx);
        return;
      case "item/completed":
        handleItem(asRecord(params.item) ?? {}, true, ctx);
        return;
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
        // Codex confirming (or another client making) a model/effort change.
        const settings = asRecord(params.threadSettings);
        const model = asString(settings?.model);
        const effort = asString(settings?.effort);
        if (model) currentModel = model;
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
      return !currentTurnId || eventTurnId === currentTurnId;
    }
    if (currentTurnId && eventTurnId && eventTurnId !== currentTurnId) return false;
    if (method === "turn/completed" && !currentTurnId && eventTurnId) return false;
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
        const child = childFor(childThreadId);
        child.label =
          asString(thread?.agentNickname) ?? asString(thread?.nickname) ?? child.label;
        child.role = asString(thread?.agentRole) ?? asString(thread?.role) ?? child.role;
        child.model = asString(thread?.model) ?? child.model;
        syncChild(childThreadId, ctx);
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
        hydrateChild(childThreadId, ctx);
        return;
      }
      case "thread/status/changed": {
        const status = threadStatus(params.status);
        if (status === "working") childFor(childThreadId).activity = null;
        if (status === "idle" || status === "error") {
          childFor(childThreadId).currentTurnId = null;
        }
        if (status) emitChild(childThreadId, { type: "status", status }, ctx);
        if (status === "idle" || status === "error") hydrateChild(childThreadId, ctx);
        return;
      }
      case "item/started":
        handleItem(asRecord(params.item) ?? {}, false, nested);
        return;
      case "item/completed":
        handleItem(asRecord(params.item) ?? {}, true, nested);
        return;
      case "item/agentMessage/delta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        streamed.add(`am-${itemId}`);
        emitChild(childThreadId, { type: "assistant-delta", id: `am-${itemId}`, text: delta }, ctx);
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        streamed.add(`rs-${itemId}`);
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

  function handleGoalCommand(arg: string, ctx: AdapterContext): void {
    if (!arg) {
      getGoal(ctx);
      return;
    }
    const action = arg.toLowerCase();
    if (action === "clear") {
      clearGoal(ctx);
      return;
    }
    if (action === "pause") {
      setGoalStatus("paused", ctx);
      return;
    }
    if (action === "resume") {
      setGoalStatus("active", ctx);
      return;
    }
    if (action === "edit" || action === "help") {
      ctx.emit({
        type: "notice",
        tone: "info",
        text:
          "Usage: /goal <objective>, /goal edit <objective>, /goal pause, /goal resume, or /goal clear.",
      });
      return;
    }

    const edit = /^edit\s+([\s\S]+)$/i.exec(arg);
    const objective = (edit?.[1] ?? arg).trim();
    if (Array.from(objective).length > MAX_GOAL_OBJECTIVE_CHARS) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: `Goal objectives can be at most ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString("en-US")} characters. Put longer instructions in a file and refer to it from the goal.`,
      });
      return;
    }
    if (edit) editGoal(objective, ctx);
    else replaceGoal(objective, ctx);
  }

  /** `/model`, `/effort`, `/compact`, `/goal` — TUI controls wired to RPCs. */
  function handleCommand(text: string, ctx: AdapterContext): "handled" | "prompt" {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : text.slice(space + 1).trim();
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
      handleGoalCommand(arg, ctx);
      return "handled";
    }

    ctx.emit({
      type: "notice",
      tone: "error",
      text: `Unknown command ${name}. Codex knows /model, /effort, /compact, /goal.`,
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
        ctx.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Duckweed does not implement ${method}` },
        });
        return;
      }

      const eventThreadId = notificationThreadId(method, params);
      const nestedThread =
        method === "thread/started" ? asRecord(params.thread) : null;
      const parentThreadId = asString(nestedThread?.parentThreadId);
      const isChildThread =
        Boolean(eventThreadId) &&
        Boolean(threadId) &&
        (eventThreadId !== threadId || parentThreadId === threadId);
      if (eventThreadId && isChildThread) {
        handleChildNotification(eventThreadId, method, params, ctx);
        return;
      }
      if (!notificationBelongsToRoot(method, params)) return;
      handleNotification(method, params, ctx);
    },

    prompt: (prompt, ctx) => {
      if (!threadId) return;
      ctx.emit({ type: "user", text: prompt.text, images: prompt.images });
      ctx.emit({ type: "status", status: "working" });
      request(ctx, "turn/start", {
        threadId,
        input: [
          ...(prompt.text ? [{ type: "text", text: prompt.text }] : []),
          ...prompt.images.map((image) => ({
            type: "image",
            url: imagePayloadDataUrl(image),
          })),
        ],
        ...turnAccessParams(currentAccess),
        ...(currentModel ? { model: currentModel } : {}),
        // Same sticky override semantics as `model`, and the same casing
        // discipline: `effort` is the exact field name in TurnStartParams.
        ...(currentEffort ? { effort: currentEffort } : {}),
      }).catch((error: unknown) => {
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
        ctx.emit({
          type: "user",
          text: prompt.text,
          images: prompt.images,
          sameTurn: true,
        });
        return true;
      } catch {
        return false;
      }
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

    commandAvailableDuringTurn: (text) => /^\/goal(?:\s|$)/i.test(text.trim()),

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
     * `thread/resume` keeps the running process and returns the selected
     * thread's complete turn list, which is replayed into the shared timeline.
     */
    resume: (sessionId, ctx) => {
      ctx.emit({ type: "status", status: "working" });
      ctx.emit({ type: "goal", goal: null });
      return request(ctx, "thread/resume", { threadId: sessionId })
        .then((result) => {
          const thread = asRecord(result.thread) ?? result;
          threadId = asString(thread.id) ?? sessionId;
          replayThread(thread, ctx);
          const hydratedStatus = threadStatus(thread.status);
          currentTurnId = hydratedStatus === "working" ? hydratedTurnId(thread) : null;
          // `thread/start` reports the model beside the thread, `thread/resume`
          // inside it; neither is guaranteed, so take whichever is there.
          const model = asString(result.model) ?? asString(thread.model);
          if (model) currentModel = model;
          ctx.emit({
            type: "session",
            sessionId: asString(thread.sessionId) ?? threadId,
            ...(model ? { model } : {}),
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
          ctx.emit({
            type: "status",
            status: currentTurnId || hydratedStatus === "working" ? "working" : "idle",
          });
          return true;
        })
        .catch((error: unknown) => {
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? "Codex could not resume that thread.",
          });
          ctx.emit({ type: "status", status: "idle" });
          return false;
        });
    },

    interrupt: (ctx) => {
      if (!threadId || !currentTurnId) return;
      void request(ctx, "turn/interrupt", { threadId, turnId: currentTurnId }).catch(() => {
        // The turn may have finished between the click and the call.
      });
    },

    respond: (permissionId, optionId, ctx) => {
      const approval = approvals.get(permissionId);
      if (!approval) return;
      approvals.delete(permissionId);
      ctx.send({ jsonrpc: "2.0", id: approval.id, result: { decision: optionId } });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },
  };
}
