import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { emptyUsage, type AgentSessionState } from "../types";
import { createAcpAdapter } from "./acp";

const launch: AgentLaunch = {
  agent: "grok",
  args: [],
  prompt: null,
  model: null,
  effort: null,
  resume: false,
};

function harness(overrides: Partial<AgentLaunch> = {}) {
  const events: AgentEvent[] = [];
  const sent: Record<string, unknown>[] = [];
  const adapter = createAcpAdapter();
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch: { ...launch, ...overrides },
    send: (message) => sent.push(message as Record<string, unknown>),
    emit: (event) => events.push(event),
  };
  const feed = (frame: unknown) => adapter.receive(JSON.stringify(frame), ctx);
  const update = (payload: unknown) =>
    feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: payload } });
  const state = () =>
    events.reduce<AgentSessionState>(applyEvent, {
      termId: "t1",
      agent: "grok",
      label: "Grok Build",
      status: "starting",
      cwd: "H:/project",
      model: null,
      effort: null,
      sessionId: null,
      items: [],
      pending: [],
      permission: null,
      usage: emptyUsage(),
      error: null,
      commands: [],
      started: false,
    });

  /** Run the `initialize` → `session/new` handshake to completion. */
  const handshake = async (
    initializeResult: Record<string, unknown> = {},
    sessionResult: Record<string, unknown> = {},
  ) => {
    adapter.start(ctx);
    await Promise.resolve();
    feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, ...initializeResult } });
    await Promise.resolve();
    await Promise.resolve();
    feed({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1", ...sessionResult } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  return { adapter, ctx, events, sent, feed, update, state, handshake };
}

/** Grok's `modelState`: one model, three effort levels, `high` in effect. */
const GROK_MODEL_STATE = {
  currentModelId: "grok-4.5",
  availableModels: [
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [{ id: "high" }, { id: "medium" }, { id: "low" }],
      },
    },
  ],
};

describe("acp adapter", () => {
  test("opens a session and reports itself ready", async () => {
    const h = harness();
    await h.handshake({
      _meta: {
        modelState: { currentModelId: "grok-4.5" },
        availableCommands: [{ name: "compact", description: "Compress history" }],
      },
    });

    expect(h.sent[0]).toMatchObject({ method: "initialize", params: { protocolVersion: 1 } });
    expect(h.sent[1]).toMatchObject({ method: "session/new", params: { cwd: "H:/project" } });
    const state = h.state();
    expect(state.status).toBe("idle");
    expect(state.sessionId).toBe("s1");
    expect(state.model).toBe("grok-4.5");
    expect(state.commands).toEqual([{ name: "/compact", description: "Compress history" }]);
  });

  test("declares no filesystem capability, so agents never ask us to read for them", async () => {
    const h = harness();
    await h.handshake();
    expect(h.sent[0]).toMatchObject({
      params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
  });

  test("surfaces a failed session as an error rather than a silent pane", async () => {
    const h = harness();
    h.adapter.start(h.ctx);
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Not authenticated" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state()).toMatchObject({ status: "error", error: "Not authenticated" });
  });

  test("splits message and thought chunks into their own items", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt("hi", h.ctx);
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm, " } });
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "let me look." } });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });

    const kinds = h.state().items.map((item) => item.kind);
    expect(kinds).toEqual(["user", "thinking", "assistant"]);
    expect(h.state().items[1]).toMatchObject({ text: "Hmm, let me look." });
  });

  test("builds a tool call from its ACP kind and merges later updates", async () => {
    const h = harness();
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Run bun test",
      kind: "execute",
      status: "pending",
      rawInput: { command: "bun test" },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "30 pass" } }],
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "execute",
      title: "Run bun test",
      command: "bun test",
      status: "done",
      output: "30 pass",
    });
  });

  test("turns a diff content block into a file change", async () => {
    const h = harness();
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "Edit src/app.ts",
      kind: "edit",
      status: "in_progress",
      content: [
        { type: "diff", path: "src/app.ts", oldText: "a\nb", newText: "a\nB\nc" },
      ],
    });

    const tool = h.state().items[0];
    expect(tool.kind === "tool" && tool.changes[0]).toMatchObject({
      path: "src/app.ts",
      insertions: 2,
      deletions: 1,
    });
  });

  test("keeps the plan as one live checklist", async () => {
    const h = harness();
    await h.handshake();
    h.update({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", status: "completed" },
        { content: "Write the fix", status: "in_progress" },
      ],
    });
    h.update({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", status: "completed" },
        { content: "Write the fix", status: "completed" },
      ],
    });

    const plans = h.state().items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].kind === "plan" && plans[0].steps[1].status).toBe("done");
  });

  test("raises a permission prompt with the agent's own options", async () => {
    const h = harness();
    await h.handshake();
    h.feed({
      jsonrpc: "2.0",
      id: "p1",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { title: "Delete build/", rawInput: { command: "rm -rf build" } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    const permission = h.state().permission;
    expect(h.state().status).toBe("waiting");
    expect(permission).toMatchObject({ title: "Delete build/", command: "rm -rf build" });
    expect(permission?.options.map((option) => option.id)).toEqual(["allow-once", "reject-once"]);

    h.adapter.respond(permission!.id, "allow-once", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      id: "p1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
  });

  test("refuses methods it declared no capability for instead of hanging", async () => {
    const h = harness();
    await h.handshake();
    h.feed({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "a.txt" } });
    expect(h.sent.at(-1)).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  test("ends the turn when the prompt request resolves", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt("hi", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
    });
    expect(h.state().status).toBe("working");

    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().status).toBe("idle");
  });

  test("cancels the session on interrupt", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.interrupt(h.ctx);
    expect(h.sent.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "s1" } });
  });

  test("reads model, effort, and commands out of the handshake", async () => {
    const h = harness();
    await h.handshake({ _meta: { modelState: GROK_MODEL_STATE } });
    const state = h.state();
    expect(state.model).toBe("grok-4.5");
    expect(state.effort).toBe("high");
  });

  test("reads the model out of opencode-style configOptions", async () => {
    const h = harness();
    await h.handshake(
      {},
      {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "opencode/big-pickle",
            options: [
              { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
              { value: "opencode/claude-haiku-4-5", name: "OpenCode Zen/Claude Haiku 4.5" },
            ],
          },
        ],
      },
    );
    expect(h.state().model).toBe("opencode/big-pickle");
  });

  test("applies a launch-time model over the protocol", async () => {
    const h = harness({ model: "grok-4.5" });
    await h.handshake({ _meta: { modelState: GROK_MODEL_STATE } });
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_model",
      params: { sessionId: "s1", modelId: "grok-4.5" },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().model).toBe("grok-4.5");
  });

  test("applies a launch-time effort over set_mode", async () => {
    const h = harness({ effort: "low" });
    await h.handshake({ _meta: { modelState: GROK_MODEL_STATE } });
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "low" },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().effort).toBe("low");
  });

  test("warns instead of pretending an agent without efforts took one", async () => {
    const h = harness({ agent: "opencode", effort: "low" });
    await h.handshake();
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "This agent does not expose effort levels over its protocol.",
    });
  });

  test("switches model with /model, resolving a bare name to its full id", async () => {
    const h = harness();
    await h.handshake(
      {},
      {
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "opencode/big-pickle",
            options: [
              { value: "opencode/big-pickle", name: "Big Pickle" },
              { value: "opencode/claude-haiku-4-5", name: "Claude Haiku 4.5" },
            ],
          },
        ],
      },
    );

    expect(h.adapter.command?.("/model claude-haiku-4-5", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_model",
      params: { modelId: "opencode/claude-haiku-4-5" },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().model).toBe("opencode/claude-haiku-4-5");
  });

  test("rejects an unknown model with what is actually available", async () => {
    const h = harness();
    await h.handshake({ _meta: { modelState: GROK_MODEL_STATE } });
    h.adapter.command?.("/model gpt-5", h.ctx);
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: 'Unknown model "gpt-5". Try /model to list what is available.',
    });
  });

  test("switches effort with /effort through set_mode", async () => {
    const h = harness();
    await h.handshake({ _meta: { modelState: GROK_MODEL_STATE } });

    expect(h.adapter.command?.("/effort medium", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "medium" },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().effort).toBe("medium");

    h.adapter.command?.("/effort maximum", h.ctx);
    expect(h.state().items.filter((item) => item.kind === "notice").at(-1)).toMatchObject({
      tone: "error",
      text: 'Unknown effort "maximum" — pick high, medium, low.',
    });
  });

  test("passes advertised commands through, refuses unknown ones locally", async () => {
    const h = harness();
    await h.handshake({
      _meta: { availableCommands: [{ name: "compact", description: "Compress history" }] },
    });

    // Advertised: the agent intercepts this when it arrives as prompt text.
    expect(h.adapter.command?.("/compact", h.ctx)).toBe("prompt");

    // Unknown: kept off the wire entirely — slash text would be chatted to
    // the model at full token price otherwise.
    expect(h.adapter.command?.("/frobnicate", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({ method: "session/new" });
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "Unknown command /frobnicate — it is not in this agent's command list.",
    });
  });

  test("says so when an intercepted slash command produces no visible output", async () => {
    const h = harness();
    await h.handshake({
      _meta: { availableCommands: [{ name: "context", description: "Show usage" }] },
    });

    h.adapter.prompt("/context", h.ctx);
    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "info",
      text: "Ran /context — this agent does not return its output to the custom UI.",
    });
  });

  test("stays quiet when a slash command did stream output", async () => {
    const h = harness();
    await h.handshake({
      _meta: { availableCommands: [{ name: "context", description: "Show usage" }] },
    });

    h.adapter.prompt("/context", h.ctx);
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "72% used" } });
    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.find((item) => item.kind === "notice")).toBeUndefined();
  });
});
