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
 * Claude Code's `stream-json` mode.
 *
 * The CLI reads one Anthropic-shaped user message per line and writes back the
 * raw streaming events plus a few wrappers of its own. Two channels matter:
 * `stream_event` carries the partial deltas that make the UI feel live, and
 * the `assistant` / `user` messages carry the settled version of the same
 * content — tool inputs arrive complete there, which is where titles and diffs
 * come from. Permission prompts ride the control protocol on the same stream.
 *
 * Slash commands are plain user messages: the CLI intercepts leading-`/`
 * text itself, answers with a synthetic assistant message (`model` is the
 * literal string `"<synthetic>"`), and closes with a `result` frame — no
 * model tokens involved (verified against claude 2.1). The one exception is
 * `/model <id>`, which we route through the `set_model` control request so
 * the header learns the new model from a structured ACK rather than by
 * parsing the CLI's friendly confirmation sentence.
 */

interface ToolCall {
  name: string;
  /** Accumulated `input_json_delta` text, parsed once the block closes. */
  partialInput: string;
}

/** Turn a tool's input into the one line that names the call. */
function describeTool(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  };
  const detail =
    first("command", "file_path", "path", "pattern", "query", "url", "description", "prompt") ??
    "";
  return detail ? `${name} · ${oneLine(detail)}` : name;
}

/** File edits a tool call is making, as far as its input reveals them. */
function changesFor(name: string, input: Record<string, unknown>): AgentFileChange[] {
  const path = asString(input.file_path) ?? asString(input.path);
  if (!path) return [];
  const lower = name.toLowerCase();

  if (lower === "write") {
    return [makeChange(path, null, asString(input.content) ?? "")];
  }
  if (lower === "edit") {
    const before = asString(input.old_string);
    const after = asString(input.new_string);
    if (before === null && after === null) return [];
    return [makeChange(path, before, after)];
  }
  if (lower === "multiedit") {
    return asArray(input.edits)
      .map((raw) => asRecord(raw))
      .filter((edit): edit is Record<string, unknown> => edit !== null)
      .map((edit) => makeChange(path, asString(edit.old_string), asString(edit.new_string)));
  }
  return [];
}

/** `TodoWrite` is Claude's plan; lift it out of the tool list into the plan row. */
function planFrom(input: Record<string, unknown>) {
  return asArray(input.todos)
    .map((raw) => asRecord(raw))
    .filter((todo): todo is Record<string, unknown> => todo !== null)
    .map((todo) => ({
      text: asString(todo.content) ?? asString(todo.activeForm) ?? "",
      status:
        todo.status === "completed"
          ? ("done" as const)
          : todo.status === "in_progress"
            ? ("running" as const)
            : ("pending" as const),
    }))
    .filter((step) => step.text);
}

/** Tool results arrive as text, or as blocks that each hold some. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((raw) => {
      const block = asRecord(raw);
      if (!block) return "";
      return asString(block.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createClaudeAdapter(): AgentAdapter {
  /** Content-block index → the item id the deltas belong to. */
  const blocks = new Map<number, { kind: "text" | "thinking" | "tool"; id: string }>();
  const tools = new Map<string, ToolCall>();
  let messageSeq = 0;
  let controlSeq = 0;
  /** Control request ids Claude is waiting on, keyed by our permission id. */
  const pendingPermissions = new Map<string, { requestId: string; input: unknown }>();
  /** Our outbound `set_model` requests, keyed by the id we gave them. */
  const pendingModelChanges = new Map<string, string>();

  const blockId = (index: number) => `m${messageSeq}-b${index}`;

  /** Apply a settled tool input: title, command, diffs, and plans. */
  function settleTool(callId: string, name: string, input: Record<string, unknown>, ctx: AdapterContext) {
    if (name.toLowerCase() === "todowrite") {
      const steps = planFrom(input);
      if (steps.length) ctx.emit({ type: "plan", steps });
    }
    ctx.emit({
      type: "tool",
      callId,
      name,
      tool: toolKind(name),
      title: describeTool(name, input),
      command: asString(input.command),
      changes: changesFor(name, input),
    });
  }

  function handleStreamEvent(event: Record<string, unknown>, ctx: AdapterContext) {
    const type = asString(event.type);

    if (type === "message_start") {
      messageSeq += 1;
      blocks.clear();
      ctx.emit({ type: "status", status: "working" });
      return;
    }

    if (type === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : 0;
      const block = asRecord(event.content_block);
      const blockType = asString(block?.type);
      if (blockType === "thinking" || blockType === "redacted_thinking") {
        blocks.set(index, { kind: "thinking", id: blockId(index) });
      } else if (blockType === "text") {
        blocks.set(index, { kind: "text", id: blockId(index) });
      } else if (blockType === "tool_use" && block) {
        const callId = asString(block.id) ?? blockId(index);
        const name = asString(block.name) ?? "tool";
        blocks.set(index, { kind: "tool", id: callId });
        tools.set(callId, { name, partialInput: "" });
        ctx.emit({
          type: "tool",
          callId,
          name,
          tool: toolKind(name),
          title: name,
          status: "running",
        });
      }
      return;
    }

    if (type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : 0;
      const target = blocks.get(index);
      if (!target) return;
      const delta = asRecord(event.delta);
      const deltaType = asString(delta?.type);
      if (deltaType === "thinking_delta") {
        const text = asString(delta?.thinking);
        if (text) ctx.emit({ type: "thinking-delta", id: target.id, text });
      } else if (deltaType === "text_delta") {
        const text = asString(delta?.text);
        if (text) ctx.emit({ type: "assistant-delta", id: target.id, text });
      } else if (deltaType === "input_json_delta") {
        const call = tools.get(target.id);
        const fragment = asString(delta?.partial_json);
        if (call && fragment) call.partialInput += fragment;
      }
      return;
    }

    if (type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : 0;
      const target = blocks.get(index);
      if (!target) return;
      if (target.kind === "thinking") ctx.emit({ type: "thinking-end", id: target.id });
      if (target.kind === "text") ctx.emit({ type: "assistant-end", id: target.id });
      if (target.kind === "tool") {
        // The settled `assistant` message also carries this input, but it can
        // land after the tool has already started running. Parsing the streamed
        // fragments means the title appears the moment the call is made.
        const call = tools.get(target.id);
        if (call?.partialInput) {
          const input = asRecord(parseJson(call.partialInput));
          if (input) settleTool(target.id, call.name, input, ctx);
        }
      }
      return;
    }

    if (type === "message_delta") {
      const usage = asRecord(event.usage);
      if (usage) emitUsage(usage, ctx);
    }
  }

  function emitUsage(usage: Record<string, unknown>, ctx: AdapterContext) {
    const number = (value: unknown) => (typeof value === "number" ? value : 0);
    ctx.emit({
      type: "usage",
      usage: {
        inputTokens:
          number(usage.input_tokens) +
          number(usage.cache_creation_input_tokens) +
          number(usage.cache_read_input_tokens),
        outputTokens: number(usage.output_tokens),
      },
    });
  }

  /** The settled assistant message: authoritative tool inputs and text. */
  function handleAssistant(message: Record<string, unknown>, ctx: AdapterContext) {
    // Slash command answers arrive as a synthetic assistant message — "Set
    // effort level to high (this session only)", "Unknown command: /foo".
    // That feedback is the whole point of the command, so it must render.
    if (asString(message.model) === "<synthetic>") {
      const text = asArray(message.content)
        .map((raw) => asRecord(raw))
        .filter((block): block is Record<string, unknown> => block !== null)
        .map((block) => asString(block.text) ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) {
        // Keep the header in sync when the CLI confirms an effort change
        // (or refuses ultracode / a bad level).
        const setEffort = /Set effort level to (\w+)/i.exec(text);
        if (setEffort) {
          ctx.emit({ type: "session", effort: setEffort[1].toLowerCase() });
        }
        const refused = /needs dynamic workflows|Invalid argument|Valid options are/i.test(text);
        ctx.emit({ type: "notice", tone: refused ? "error" : "info", text });
      }
      return;
    }
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      if (!block) continue;
      if (asString(block.type) !== "tool_use") continue;
      const callId = asString(block.id);
      const name = asString(block.name) ?? "tool";
      const input = asRecord(block.input) ?? {};
      if (!callId) continue;
      tools.set(callId, { name, partialInput: "" });
      settleTool(callId, name, input, ctx);
    }
  }

  /** Tool results come back wrapped in a synthetic user message. */
  function handleToolResults(message: Record<string, unknown>, ctx: AdapterContext) {
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      if (!block || asString(block.type) !== "tool_result") continue;
      const callId = asString(block.tool_use_id);
      if (!callId) continue;
      const failed = block.is_error === true;
      ctx.emit({
        type: "tool",
        callId,
        status: failed ? ("error" as ToolStatus) : ("done" as ToolStatus),
        output: resultText(block.content),
      });
    }
  }

  /** Claude asking whether a tool may run. */
  function handleControlRequest(frame: Record<string, unknown>, ctx: AdapterContext) {
    const requestId = asString(frame.request_id);
    const request = asRecord(frame.request);
    const subtype = asString(request?.subtype);
    if (!requestId || !request) return;

    if (subtype !== "can_use_tool") {
      // Anything else is Claude asking for a capability we do not implement.
      // Answering "unsupported" is better than leaving it waiting forever.
      ctx.send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `Duckweed does not support ${subtype ?? "this request"}`,
        },
      });
      return;
    }

    const name = asString(request.tool_name) ?? "tool";
    const input = asRecord(request.input) ?? {};
    const permissionId = `perm-${requestId}`;
    pendingPermissions.set(permissionId, { requestId, input });
    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        title: `${name} wants to run`,
        detail: describeTool(name, input),
        command: asString(input.command),
        changes: changesFor(name, input),
        options: [
          { id: "allow", label: "Allow", kind: "allow" },
          { id: "deny", label: "Deny", kind: "reject" },
        ],
      },
    });
  }

  function handleResult(frame: Record<string, unknown>, ctx: AdapterContext) {
    const usage = asRecord(frame.usage);
    if (usage) emitUsage(usage, ctx);
    const cost = frame.total_cost_usd;
    if (typeof cost === "number") ctx.emit({ type: "usage", usage: { costUsd: cost } });
    if (frame.is_error === true) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: asString(frame.result) ?? "The turn failed.",
      });
    }
    ctx.emit({ type: "turn-end" });
  }

  /** The CLI answering one of our control requests (`set_model`, `interrupt`). */
  function handleControlResponse(frame: Record<string, unknown>, ctx: AdapterContext) {
    const response = asRecord(frame.response);
    const requestId = asString(response?.request_id);
    if (!requestId) return;
    const model = pendingModelChanges.get(requestId);
    if (model === undefined) return;
    pendingModelChanges.delete(requestId);
    if (asString(response?.subtype) === "success") {
      ctx.emit({ type: "session", model });
      ctx.emit({ type: "notice", tone: "info", text: `Model set to ${model}.` });
    } else {
      ctx.emit({
        type: "notice",
        tone: "error",
        text: asString(response?.error) ?? `Claude refused model "${model}".`,
      });
    }
  }

  /**
   * Effort levels `/effort` accepts. The CLI usage line lists
   * low|medium|high|xhigh|max|auto; `ultracode` is plan/workflow-gated and
   * returns a clear refusal when unavailable (verified against claude 2.1.220).
   */
  const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "auto", "ultracode"]);

  function handleCommand(text: string, ctx: AdapterContext): "handled" | "prompt" {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : text.slice(space + 1).trim();

    if (name === "/model" && arg) {
      // A structured switch, so the header can trust what it shows. The CLI
      // would also accept this as plain slash text, but its confirmation
      // sentence names a display label, not the id we were given.
      controlSeq += 1;
      const requestId = `dw-model-${controlSeq}`;
      pendingModelChanges.set(requestId, arg);
      ctx.emit({ type: "user", text });
      ctx.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_model", model: arg },
      });
      return "handled";
    }

    if (name === "/effort" && arg) {
      const level = arg.toLowerCase();
      if (!EFFORT_LEVELS.has(level)) {
        ctx.emit({ type: "user", text });
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown effort "${arg}" — pick low, medium, high, xhigh, max, auto, or ultracode.`,
        });
        return "handled";
      }
      // Validated against the same set the CLI enforces, so the header can
      // move now; the CLI's own confirmation lands right behind it.
      ctx.emit({ type: "session", effort: level });
      return "prompt";
    }

    // Everything else — /compact, /clear, bare /model or /effort, and any
    // skill — the CLI interprets slash text itself, including answering
    // unknown commands with a synthetic "Unknown command" message.
    return "prompt";
  }

  return {
    endsOnStdinClose: true,

    // No `resume` here on purpose: `stream-json` has no method for swapping
    // conversations, so the session store relaunches the CLI with the flags
    // below. That is also what `claude --resume <id>` does interactively.
    args: (launch: AgentLaunch) => {
      const extra: string[] = [];
      if (launch.model) extra.push("--model", launch.model);
      if (launch.effort) extra.push("--effort", launch.effort);
      if (launch.resumeId) extra.push("--resume", launch.resumeId);
      else if (launch.resume) extra.push("--continue");
      return extra;
    },

    start: (ctx) => {
      // Nothing to hand shake: the CLI is ready as soon as it is up, and the
      // `system/init` frame that names the model only arrives with the first
      // turn. Opening prompts are sent by the session, not here. The session
      // already seeded Claude's model aliases so the picker works immediately.
      ctx.emit({ type: "status", status: "idle" });
    },

    receive: (line, ctx) => {
      const frame = parseJson(line);
      if (!frame) return;
      const type = asString(frame.type);

      switch (type) {
        case "system": {
          if (asString(frame.subtype) !== "init") return;
          const commands = asArray(frame.slash_commands)
            .map((name) => asString(name))
            .filter((name): name is string => name !== null)
            .map((name) => ({ name: `/${name}`, description: "" }));
          // Prefer the raw model id from init (`claude-opus-5[1m]`); the
          // session already seeded the alias list for the picker.
          ctx.emit({
            type: "session",
            sessionId: asString(frame.session_id) ?? undefined,
            model: asString(frame.model) ?? undefined,
            cwd: asString(frame.cwd) ?? undefined,
            commands,
          });
          return;
        }
        case "stream_event": {
          const event = asRecord(frame.event);
          if (event) handleStreamEvent(event, ctx);
          return;
        }
        case "assistant": {
          const message = asRecord(frame.message);
          if (message) handleAssistant(message, ctx);
          return;
        }
        case "user": {
          const message = asRecord(frame.message);
          if (message) handleToolResults(message, ctx);
          return;
        }
        case "control_request":
          handleControlRequest(frame, ctx);
          return;
        case "control_response":
          handleControlResponse(frame, ctx);
          return;
        case "result":
          handleResult(frame, ctx);
          return;
        default:
          return;
      }
    },

    prompt: (text, ctx) => {
      ctx.emit({ type: "user", text });
      ctx.emit({ type: "status", status: "working" });
      ctx.send({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      });
    },

    command: handleCommand,

    interrupt: (ctx) => {
      controlSeq += 1;
      ctx.send({
        type: "control_request",
        request_id: `dw-int-${controlSeq}`,
        request: { subtype: "interrupt" },
      });
    },

    respond: (permissionId, optionId, ctx) => {
      const pending = pendingPermissions.get(permissionId);
      if (!pending) return;
      pendingPermissions.delete(permissionId);
      const allowed = optionId === "allow";
      ctx.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: pending.requestId,
          response: allowed
            ? { behavior: "allow", updatedInput: pending.input }
            : { behavior: "deny", message: "Denied in Duckweed" },
        },
      });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },
  };
}
