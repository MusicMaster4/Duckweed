import {
  asArray,
  asRecord,
  asString,
  oneLine,
  parseJson,
  type AdapterContext,
  type AgentAdapter,
} from "../adapter";
import type { AgentLaunch } from "../launch";
import { makePatchChange, toolKind, type AgentFileChange, type ToolStatus } from "../types";

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
 * and `model/list` supplies the valid ids and per-model effort levels.
 */

/** One row of `model/list`, trimmed to what the commands need. */
interface CodexModel {
  id: string;
  displayName: string;
  efforts: string[];
  isDefault: boolean;
}

const EXEC_STATUS: Record<string, ToolStatus> = {
  inProgress: "running",
  completed: "done",
  failed: "error",
  declined: "error",
};

const COLLAB_STATUS: Record<string, ToolStatus> = {
  inProgress: "running",
  completed: "done",
  failed: "error",
};

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Record<string, unknown>) => void;
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
  const pending = new Map<number, Pending>();
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

  async function handshake(ctx: AdapterContext) {
    try {
      await request(ctx, "initialize", {
        clientInfo: { name: "duckweed", title: "Duckweed", version: "0.1.0" },
      });
      notify(ctx, "initialized", {});

      currentModel = ctx.launch.model;
      currentEffort = ctx.launch.effort;
      const thread = await request(ctx, "thread/start", {
        cwd: ctx.cwd,
        // Ask before anything leaves the workspace: the UI has a prompt for
        // exactly this, and silently widening a user's sandbox because they
        // opened a prettier front-end would be the wrong trade.
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
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
        const status = asString(item.status) ?? "";
        const prompt = asString(item.prompt);
        const model = asString(item.model);
        const effort = asString(item.reasoningEffort);
        const receiverIds = asArray(item.receiverThreadIds)
          .map((entry) => asString(entry) ?? "")
          .filter(Boolean);
        const states = asRecord(item.agentsStates);
        const stateLines = states
          ? Object.entries(states).map(([agentId, raw]) => {
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
        ctx.emit({
          type: "tool",
          callId: id,
          name: `collab/${collabTool}`,
          tool: "task",
          title: prompt ? `${operation}: ${oneLine(prompt)}` : operation,
          status: COLLAB_STATUS[status] ?? (settled ? "done" : "running"),
          ...(detail ? { output: detail } : {}),
        });
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

  function handleNotification(method: string, params: Record<string, unknown>, ctx: AdapterContext) {
    switch (method) {
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
        if (steps.length) ctx.emit({ type: "plan", steps });
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

  /** `/model`, `/effort`, `/compact` — the TUI's controls, wired to RPCs. */
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
          text: `Unknown model "${arg}" — available: ${models.map((model) => model.id).join(", ")}.`,
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
          text: `${currentModel ?? "This model"} does not take "${arg}" effort — pick ${options.join(", ")}.`,
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

    ctx.emit({
      type: "notice",
      tone: "error",
      text: `Unknown command ${name} — Codex knows /model, /effort, /compact.`,
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

      handleNotification(method, params, ctx);
    },

    prompt: (text, ctx) => {
      if (!threadId) return;
      ctx.emit({ type: "user", text });
      ctx.emit({ type: "status", status: "working" });
      request(ctx, "turn/start", {
        threadId,
        input: [{ type: "text", text }],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        // `SandboxPolicy.type` is camelCase, unlike `thread/start`'s
        // kebab-case `sandbox`. Two enums, two conventions, one letter apart
        // from silently rejecting every turn.
        sandboxPolicy: { type: "workspaceWrite" },
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

    command: handleCommand,

    /**
     * `thread/resume` swaps the live thread for a stored one, so the running
     * process keeps its handshake, model list, and sandbox decision. It does
     * not replay the old items — Codex answers with the thread record only —
     * which is why the UI shows a resumed marker rather than a transcript.
     */
    resume: (sessionId, ctx) => {
      void request(ctx, "thread/resume", { threadId: sessionId })
        .then((result) => {
          const thread = asRecord(result.thread) ?? result;
          threadId = asString(thread.id) ?? sessionId;
          // `thread/start` reports the model beside the thread, `thread/resume`
          // inside it; neither is guaranteed, so take whichever is there.
          const model = asString(result.model) ?? asString(thread.model);
          if (model) currentModel = model;
          ctx.emit({
            type: "session",
            sessionId: asString(thread.sessionId) ?? threadId,
            ...(model ? { model } : {}),
          });
          ctx.emit({ type: "status", status: "idle" });
        })
        .catch((error: unknown) => {
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? "Codex could not resume that thread.",
          });
          ctx.emit({ type: "status", status: "idle" });
        });
      return true;
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
