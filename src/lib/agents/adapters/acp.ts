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
import { makeChange, toolKind, type AgentFileChange, type ToolStatus } from "../types";

/**
 * Agent Client Protocol — the shared language of Cursor, Grok, and OpenCode.
 *
 * ACP is JSON-RPC 2.0 over stdio with a small, well-shaped vocabulary: the
 * client opens a session, sends a prompt, and receives `session/update`
 * notifications until the prompt request resolves with a stop reason. Because
 * three of the five supported agents speak it, this one adapter is most of the
 * protocol coverage — the per-agent differences live in the catalog's spawn
 * arguments and in the `_meta` fields read below.
 *
 * Slash commands: names an agent advertises (`availableCommands`) are sent
 * back as plain `session/prompt` text — the agent intercepts them (verified:
 * grok answers in 0 tokens). `/model` and `/effort` are never advertised, so
 * they are wired to RPCs instead: `session/set_model` (grok and opencode both
 * validate the id) and grok's `session/set_mode`, where a "mode" is a
 * reasoning effort. Anything unknown is refused locally rather than spending
 * a model turn on it — grok happily chats about a `/model` typo.
 */

const PROTOCOL_VERSION = 1;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Record<string, unknown>) => void;
}

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
      if (path) changes.push(makeChange(path, asString(block.oldText), asString(block.newText)));
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

export function createAcpAdapter(): AgentAdapter {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let sessionId: string | null = null;
  /** Turn ids so streamed chunks group into one bubble per turn. */
  let turnSeq = 0;
  /** Permission id → the JSON-RPC request id ACP is waiting on. */
  const permissionRequests = new Map<string, string | number>();
  /** Tool calls whose content we have already seen, to merge partial updates. */
  const toolTitles = new Map<string, string>();
  /**
   * Slash commands the agent advertised, without the leading slash. Only
   * these may go out as prompt text — anything else slash-shaped would be
   * chatted to the model at full price.
   */
  const advertised = new Set<string>();
  /** Models the agent can switch to, and each one's effort levels. */
  let availableModels: AcpModel[] = [];
  let currentModelId: string | null = null;
  let currentEffort: string | null = null;
  /**
   * Slash commands an agent intercepts can legitimately produce no output
   * (grok's `/context` renders in its TUI only). When a slash turn comes
   * back empty, say so instead of leaving a lone echo on screen.
   */
  let slashPending = false;
  let turnHadContent = false;

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

  function readModelState(raw: unknown): {
    model?: string;
    effort?: string;
    models?: ReturnType<typeof modelsForUi>;
  } {
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
            .map((effort) => asString(effort.id) ?? "")
            .filter(Boolean),
        };
      })
      .filter((model) => model.id);
    if (models.length) availableModels = models;
    if (current) currentModelId = current;
    const active = entries.find((model) => asString(model.modelId) === currentModelId);
    const effort = asString(asRecord(active?._meta)?.reasoningEffort);
    if (effort) currentEffort = effort;
    return {
      ...(current ? { model: current } : {}),
      ...(effort ? { effort } : {}),
      ...(availableModels.length ? { models: modelsForUi() } : {}),
    };
  }

  /**
   * OpenCode's answer to the same question: `configOptions` on `session/new`
   * carries a `model` category with the current value and every choice.
   */
  function readConfigOptions(raw: unknown): {
    model?: string;
    models?: ReturnType<typeof modelsForUi>;
  } {
    const option = asArray(raw)
      .map((entry) => asRecord(entry))
      .find((entry) => entry?.category === "model");
    if (!option) return {};
    const current = asString(option.currentValue);
    const models = asArray(option.options)
      .map((entry) => asRecord(entry))
      .filter((model): model is Record<string, unknown> => model !== null)
      .map((model) => ({
        id: asString(model.value) ?? "",
        name: asString(model.name) ?? asString(model.value) ?? "",
        efforts: [],
      }))
      .filter((model) => model.id);
    // A `models` field carries effort levels; configOptions do not, so the
    // richer source wins if an agent ever sends both.
    if (models.length && !availableModels.length) availableModels = models;
    if (current) currentModelId = current;
    return {
      ...(current ? { model: current } : {}),
      ...(availableModels.length ? { models: modelsForUi() } : {}),
    };
  }

  /** `initialize` → `session/new` → launch-time model/effort → ready. */
  async function handshake(ctx: AdapterContext) {
    try {
      const initialized = await request(ctx, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // Duckweed does not proxy the filesystem for the agent; it has its
          // own access to the project it was launched in. Declaring these
          // false is what stops an agent asking us to read files for it.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "duckweed", title: "Duckweed", version: "0.1.0" },
      });

      const meta = asRecord(initialized._meta);
      const identity = readModelState(meta?.modelState);
      const commands = readCommands(meta?.availableCommands);
      ctx.emit({
        type: "session",
        ...identity,
        ...(commands.length ? { commands } : {}),
      });

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
      ctx.emit({ type: "session", sessionId, ...fromSession });

      await applyLaunchSettings(ctx);
      ctx.emit({ type: "status", status: "idle" });
    } catch (error) {
      const record = asRecord(error);
      fail(ctx, asString(record?.message) ?? "The agent refused to start a session.");
    }
  }

  /** Honor `-m` / `--effort` typed at launch, over the protocol. */
  async function applyLaunchSettings(ctx: AdapterContext) {
    if (ctx.launch.model) {
      const model = ctx.launch.model;
      await request(ctx, "session/set_model", { sessionId, modelId: model })
        .then(() => {
          currentModelId = model;
          ctx.emit({ type: "session", model });
        })
        .catch((error: unknown) => {
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: `Could not set model "${model}": ${asString(record?.message) ?? "rejected"}.`,
          });
        });
    }
    if (ctx.launch.effort) {
      const effort = ctx.launch.effort.toLowerCase();
      const efforts = availableModels.find((model) => model.id === currentModelId)?.efforts ?? [];
      if (!efforts.length) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: "This agent does not expose effort levels over its protocol.",
        });
      } else if (!efforts.includes(effort)) {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown effort "${effort}" — pick ${efforts.join(", ")}.`,
        });
      } else {
        await request(ctx, "session/set_mode", { sessionId, modeId: effort })
          .then(() => {
            currentEffort = effort;
            ctx.emit({ type: "session", effort });
          })
          .catch((error: unknown) => {
            const record = asRecord(error);
            ctx.emit({
              type: "notice",
              tone: "error",
              text: `Could not set effort "${effort}": ${asString(record?.message) ?? "rejected"}.`,
            });
          });
      }
    }
  }

  function handleSessionUpdate(params: Record<string, unknown>, ctx: AdapterContext) {
    const update = asRecord(params.update);
    if (!update) return;
    const kind = asString(update.sessionUpdate);

    switch (kind) {
      case "agent_message_chunk": {
        const text = readContentText(update.content);
        if (text) {
          turnHadContent = true;
          ctx.emit({ type: "assistant-delta", id: `a${turnSeq}`, text });
        }
        return;
      }
      case "agent_thought_chunk": {
        const text = readContentText(update.content);
        if (text) {
          turnHadContent = true;
          ctx.emit({ type: "thinking-delta", id: `r${turnSeq}`, text });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = asString(update.toolCallId);
        if (!callId) return;
        turnHadContent = true;
        const title = asString(update.title);
        if (title) toolTitles.set(callId, title);
        const rawInput = asRecord(update.rawInput);
        const command = asString(rawInput?.command);
        const status = asString(update.status);
        const { text, changes } = readToolContent(asArray(update.content));
        const name = title ?? toolTitles.get(callId) ?? "tool";
        const acpKind = asString(update.kind);
        ctx.emit({
          type: "tool",
          callId,
          // A `tool_call_update` carries only what changed. Re-deriving the
          // family from a frame that omits `kind` would downgrade a known
          // tool to "other" halfway through the call.
          ...(title ? { name: oneLine(name, 40) } : {}),
          ...(acpKind ? { tool: toolKind(name, acpKind) } : {}),
          ...(title ? { title: oneLine(title) } : {}),
          ...(status && ACP_STATUS[status] ? { status: ACP_STATUS[status] } : {}),
          ...(command ? { command } : {}),
          ...(text ? { output: text } : {}),
          ...(changes.length ? { changes } : {}),
        });
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
        if (steps.length) ctx.emit({ type: "plan", steps });
        return;
      }
      case "available_commands_update": {
        const commands = readCommands(update.availableCommands);
        if (commands.length) ctx.emit({ type: "session", commands });
        return;
      }
      case "current_mode_update":
        return;
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
        command: asString(rawInput?.command),
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
    return null;
  }

  /** `/model` and `/effort` over RPC; advertised names pass through. */
  function handleCommand(text: string, ctx: AdapterContext): "handled" | "prompt" {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : text.slice(space + 1).trim();

    // Advertised commands are the agent's own — it intercepts them when they
    // come back as prompt text (verified: instant, zero tokens).
    if (advertised.has(name.slice(1))) return "prompt";

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
          text: `"${arg}" matches more than one model — give the full provider/model id.`,
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
      void request(ctx, "session/set_model", { sessionId, modelId })
        .then(() => {
          currentModelId = modelId;
          ctx.emit({ type: "session", model: modelId });
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
          text: "This agent does not expose effort levels over its protocol.",
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
          text: `Unknown effort "${arg}" — pick ${efforts.join(", ")}.`,
        });
        return "handled";
      }
      if (!sessionId) return "handled";
      void request(ctx, "session/set_mode", { sessionId, modeId: level })
        .then(() => {
          currentEffort = level;
          ctx.emit({ type: "session", effort: level });
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
      text: `Unknown command ${name} — it is not in this agent's command list.`,
    });
    return "handled";
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
        // Everything else is a capability we declared we do not have.
        ctx.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Duckweed does not implement ${method}` },
        });
        return;
      }

      if (method === "session/update") handleSessionUpdate(params, ctx);
    },

    prompt: (text, ctx) => {
      if (!sessionId) return;
      turnSeq += 1;
      slashPending = text.startsWith("/");
      turnHadContent = false;
      ctx.emit({ type: "user", text });
      ctx.emit({ type: "status", status: "working" });
      request(ctx, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      })
        .then((result) => {
          const stop = asString(result.stopReason);
          if (stop === "refusal") {
            ctx.emit({ type: "notice", tone: "error", text: "The agent refused the request." });
          } else if (slashPending && !turnHadContent) {
            ctx.emit({
              type: "notice",
              tone: "info",
              text: `Ran ${oneLine(text.split(/\s/)[0], 40)} — this agent does not return its output to the custom UI.`,
            });
          }
          slashPending = false;
          ctx.emit({ type: "turn-end" });
        })
        .catch((error: unknown) => {
          slashPending = false;
          const record = asRecord(error);
          ctx.emit({
            type: "notice",
            tone: "error",
            text: asString(record?.message) ?? "The turn failed.",
          });
          ctx.emit({ type: "turn-end" });
        });
    },

    command: handleCommand,

    interrupt: (ctx) => {
      if (!sessionId) return;
      notify(ctx, "session/cancel", { sessionId });
    },

    respond: (permissionId, optionId, ctx) => {
      const id = permissionRequests.get(permissionId);
      if (id === undefined) return;
      permissionRequests.delete(permissionId);
      ctx.send({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "selected", optionId } },
      });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },
  };
}
