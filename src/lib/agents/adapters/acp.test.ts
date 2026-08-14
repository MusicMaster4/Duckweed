import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { emptyUsage, type AgentSessionState } from "../types";
import { createAcpAdapter } from "./acp";

const launch: AgentLaunch = {
  agent: "grok",
  program: "grok",
  env: {},
  wrapperArgs: [],
  forwardArgs: [],
  args: [],
  prompt: null,
  model: null,
  effort: null,
  resume: false,
  resumeId: null,
};

const image = {
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png" as const,
  dataUrl: "data:image/png;base64,aGVsbG8=",
  thumbnailDataUrl: "data:image/webp;base64,dGh1bWJuYWls",
  size: 5,
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
      program: "grok",
      label: "Grok Build",
      mark: "GR",
      accent: "#7ea6ff",
      status: "starting",
      cwd: "H:/project",
      model: null,
      effort: null,
      models: [],
      sessionId: null,
      goal: null,
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
    h.adapter.prompt({ text: "hi", images: [] }, h.ctx);
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm, " } });
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "let me look." } });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });

    const kinds = h.state().items.map((item) => item.kind);
    expect(kinds).toEqual(["user", "thinking", "assistant"]);
    expect(h.state().items[1]).toMatchObject({
      text: "Hmm, let me look.",
      streaming: false,
    });
    expect(h.state().items[2]).toMatchObject({ text: "Done.", streaming: true });
  });

  test("opens new thought and message segments around tool calls", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "inspect", images: [] }, h.ctx);

    h.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "First thought" },
    });
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Read package.json",
      kind: "read",
      status: "completed",
    });
    h.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Second thought" },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Interim narration" },
    });
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "Run tests",
      kind: "execute",
      status: "completed",
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Final answer" },
    });

    expect(
      h.state().items
        .filter((item) => item.kind === "thinking")
        .map((item) => ({ id: item.id, text: item.text, streaming: item.streaming })),
    ).toEqual([
      { id: "r1", text: "First thought", streaming: false },
      { id: "r1-2", text: "Second thought", streaming: false },
    ]);
    expect(
      h.state().items
        .filter((item) => item.kind === "assistant")
        .map((item) => ({ id: item.id, text: item.text, streaming: item.streaming })),
    ).toEqual([
      { id: "a1", text: "Interim narration", streaming: false },
      { id: "a1-2", text: "Final answer", streaming: true },
    ]);
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

  test("enriches task-shaped ACP tools without inventing a child thread", async () => {
    const h = harness();
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "task_1",
      title: "Delegate parser review",
      kind: "other",
      status: "in_progress",
      rawInput: {
        description: "Review parser compatibility",
        prompt: "Check the old parser fixtures",
        subagent_type: "Explore",
        model: "fast",
      },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "task_1",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Checked fixtures\nCompatibility passed" },
        },
      ],
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "task",
      status: "done",
      subagent: {
        label: "Review parser compatibility",
        role: "Explore",
        prompt: "Check the old parser fixtures",
        model: "fast",
        activity: "Compatibility passed",
      },
    });
    expect(
      h.state().items[0].kind === "tool" &&
        h.state().items[0].subagent?.threadId,
    ).toBeUndefined();
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
    expect(plans[0].kind === "plan" && plans[0].planType).toBe("tasks");
    expect(plans[0].kind === "plan" && plans[0].steps[1].status).toBe("done");
  });

  test("surfaces Grok background workflow phases from its ACP extension", async () => {
    const h = harness();
    await h.handshake();
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          run_id: "wf_1",
          name: "suggest-improvements",
          status: "active",
          phases: [
            { title: "Map", state: "active" },
            { title: "Explore", state: "pending" },
            { title: "Synthesize", state: "pending" },
          ],
          current_phase: "Map",
        },
      },
    });
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          run_id: "wf_1",
          name: "suggest-improvements",
          status: "active",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "active" },
            { title: "Synthesize", state: "pending" },
          ],
          current_phase: "Explore",
        },
      },
    });

    const plans = h.state().items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].kind === "plan" && plans[0].planType).toBe("workflow");
    expect(plans[0].kind === "plan" && plans[0].steps).toEqual([
      { text: "Map", status: "done" },
      { text: "Explore", status: "running" },
      { text: "Synthesize", status: "pending" },
    ]);
  });

  test("settles every Grok workflow phase when the run completes", async () => {
    const h = harness();
    await h.handshake();
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          status: "completed",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "done" },
            { title: "Synthesize", state: "active" },
          ],
        },
      },
    });

    const plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps.every((step) => step.status === "done")).toBe(true);
  });

  test("accepts Grok workflow completion notifications sent after the turn", async () => {
    const h = harness();
    await h.handshake();
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          status: "completed",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "done" },
            { title: "Synthesize", state: "done" },
          ],
        },
      },
    });

    const plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Map", status: "done" },
      { text: "Explore", status: "done" },
      { text: "Synthesize", status: "done" },
    ]);
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
    h.adapter.prompt({ text: "hi", images: [] }, h.ctx);
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

  test("keeps Grok working after the prompt resolves while its workflow is active", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "/suggest-improvements", images: [] }, h.ctx);
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          run_id: "wf_1",
          status: "active",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "active" },
            { title: "Synthesize", state: "pending" },
          ],
        },
      },
    });

    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().status).toBe("working");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);

    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          run_id: "wf_1",
          status: "completed",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "done" },
            { title: "Synthesize", state: "done" },
          ],
        },
      },
    });

    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("releases a Grok turn when its workflow is interrupted", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "/suggest-improvements", images: [] }, h.ctx);
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          run_id: "wf_1",
          status: "active",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "active" },
          ],
        },
      },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "workflow_updated",
          run_id: "wf_1",
          status: "interrupted",
          phases: [
            { title: "Map", state: "done" },
            { title: "Explore", state: "active" },
          ],
        },
      },
    });

    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
    expect(h.state().status).toBe("idle");
  });

  test("sends the original image instead of its thumbnail over ACP", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "Describe this", images: [image] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/prompt",
      params: {
        prompt: [
          { type: "text", text: "Describe this" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", images: [image] });
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
    expect(state.models.length).toBeGreaterThan(0);
    expect(state.models.some((model) => model.id === "grok-4.5")).toBe(true);
    expect(state.models.find((model) => model.id === "grok-4.5")?.efforts).toContain("high");
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
    expect(h.state().models.map((model) => model.id)).toContain("opencode/claude-haiku-4-5");
  });

  test("reads OpenCode thought_level effort from configOptions", async () => {
    const h = harness({ agent: "opencode" });
    await h.handshake(
      {},
      {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "opencode/claude-opus-5",
            options: [
              { value: "opencode/big-pickle", name: "Big Pickle" },
              { value: "opencode/claude-opus-5", name: "Claude Opus 5" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "xhigh", name: "Xhigh" },
              { value: "max", name: "Max" },
            ],
          },
        ],
      },
    );
    expect(h.state().model).toBe("opencode/claude-opus-5");
    expect(h.state().effort).toBe("medium");
    expect(h.state().models.find((model) => model.id === "opencode/claude-opus-5")?.efforts).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
  });

  test("switches OpenCode effort through set_config_option", async () => {
    const h = harness({ agent: "opencode" });
    await h.handshake(
      {},
      {
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "opencode/claude-opus-5",
            options: [{ value: "opencode/claude-opus-5", name: "Claude Opus 5" }],
          },
          {
            id: "effort",
            category: "thought_level",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    );
    expect(h.adapter.command?.("/effort high", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "effort", value: "high" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 3,
      result: {
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "opencode/claude-opus-5",
            options: [{ value: "opencode/claude-opus-5", name: "Claude Opus 5" }],
          },
          {
            id: "effort",
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().effort).toBe("high");
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
    // OpenCode-style configOptions → set_config_option, not set_model.
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: {
        sessionId: "s1",
        configId: "model",
        value: "opencode/claude-haiku-4-5",
      },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 3,
      result: {
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "opencode/claude-haiku-4-5",
            options: [
              { value: "opencode/big-pickle", name: "Big Pickle" },
              { value: "opencode/claude-haiku-4-5", name: "Claude Haiku 4.5" },
            ],
          },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().model).toBe("opencode/claude-haiku-4-5");
  });

  test("waits for OpenCode to accept a staged model before configuration resolves", async () => {
    const h = harness({ agent: "opencode" });
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

    let settled = false;
    const changing = Promise.resolve(
      h.adapter.configure?.("model", "opencode/claude-haiku-4-5", h.ctx),
    ).then((accepted) => {
      settled = true;
      return accepted;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: { value: "opencode/claude-haiku-4-5" },
    });

    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await changing).toBe(true);
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
      text: 'Unknown effort "maximum". Pick high, medium, low.',
    });
  });

  test("passes advertised commands through, refuses unknown ones locally", async () => {
    const h = harness();
    await h.handshake({
      _meta: {
        availableCommands: [
          { name: "compact", description: "Compress history" },
          { name: "goal", description: "Manage a long-running goal" },
        ],
      },
    });

    // Advertised: the agent intercepts this when it arrives as prompt text.
    expect(h.adapter.command?.("/compact", h.ctx)).toBe("prompt");
    expect(h.adapter.command?.("/goal finish the migration", h.ctx)).toBe("prompt");
    expect(h.state().goal).toEqual({
      objective: "finish the migration",
      status: "active",
    });

    // Unknown: kept off the wire entirely — slash text would be chatted to
    // the model at full token price otherwise.
    expect(h.adapter.command?.("/frobnicate", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({ method: "session/new" });
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "Unknown command /frobnicate. It is not in this agent's command list.",
    });
  });

  test("tracks /goal only when the ACP harness advertises it", async () => {
    const h = harness();
    await h.handshake({
      _meta: {
        availableCommands: [
          { name: "goal", description: "Set the session goal" },
        ],
      },
    });

    expect(
      h.adapter.command?.("/goal inspect the repository", h.ctx),
    ).toBe("prompt");
    expect(h.state().goal).toEqual({
      objective: "inspect the repository",
      status: "active",
    });

    h.adapter.prompt(
      { text: "/goal inspect the repository", images: [] },
      h.ctx,
    );
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Goal set: inspect the repository safely" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "end_turn" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().goal).toEqual({
      objective: "inspect the repository safely",
      status: "active",
    });
  });

  test("does not create goal chrome for an unadvertised ACP command", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/goal inspect", h.ctx)).toBe("handled");
    expect(h.state().goal).toBeNull();
  });

  test("says so when an intercepted slash command produces no visible output", async () => {
    const h = harness();
    await h.handshake({
      _meta: { availableCommands: [{ name: "context", description: "Show usage" }] },
    });

    h.adapter.prompt({ text: "/context", images: [] }, h.ctx);
    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "info",
      text: "Ran /context. This agent does not return its output to the custom UI.",
    });
  });

  test("stays quiet when a slash command did stream output", async () => {
    const h = harness();
    await h.handshake({
      _meta: { availableCommands: [{ name: "context", description: "Show usage" }] },
    });

    h.adapter.prompt({ text: "/context", images: [] }, h.ctx);
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "72% used" } });
    h.feed({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.find((item) => item.kind === "notice")).toBeUndefined();
  });

  test("ignores a live user-message echo instead of duplicating the prompt", async () => {
    const h = harness();
    await h.handshake();

    h.adapter.prompt({ text: "Fix the parser", images: [] }, h.ctx);
    h.update({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Fix the parser" },
    });
    h.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting the parser" },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done." },
    });

    const items = h.state().items;
    expect(items.filter((item) => item.kind === "user")).toEqual([
      expect.objectContaining({ kind: "user", text: "Fix the parser" }),
    ]);
    expect(items.find((item) => item.kind === "thinking")?.id).toBe("r1");
    expect(items.find((item) => item.kind === "assistant")?.id).toBe("a1");
  });

  test("loads a stored session when the agent advertises loadSession", async () => {
    const h = harness();
    await h.handshake({ agentCapabilities: { loadSession: true } });
    h.ctx.emit({ type: "user", text: "Current conversation" });

    const resumed = h.adapter.resume?.("old-1", h.ctx);
    const load = h.sent.find((message) => message.method === "session/load");
    expect(load?.params).toMatchObject({ sessionId: "old-1", cwd: "H:/project" });

    // The replay arrives as the same chunked updates a live turn produces.
    h.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix the " } });
    h.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "parser" } });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);

    const items = h.state().items;
    // Chunks of one past prompt collapse into a single transcript row.
    expect(items.filter((item) => item.kind === "user")).toEqual([
      expect.objectContaining({ kind: "user", text: "Fix the parser" }),
    ]);
    expect(items.some((item) => item.kind === "user" && item.text === "Current conversation")).toBe(
      false,
    );
    expect(items.at(-1)).toMatchObject({ kind: "assistant", text: "Done." });
    expect(h.state().status).toBe("idle");
  });

  test("lets Stop cancel a session replay that never answered", async () => {
    const h = harness();
    await h.handshake({ agentCapabilities: { loadSession: true } });
    h.ctx.emit({ type: "user", text: "Keep this conversation" });

    const resumed = h.adapter.resume?.("old-stuck", h.ctx);
    const load = h.sent.find((message) => message.method === "session/load") as { id: number };
    expect(h.state().status).toBe("working");

    h.adapter.interrupt(h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "$/cancelRequest",
      params: { id: load.id },
    });
    expect(await resumed).toBe(false);
    expect(h.state().status).toBe("idle");
    expect(
      h.state().items.some((item) => item.kind === "notice" && item.tone === "error"),
    ).toBe(false);
    expect(h.state().items).toEqual([
      expect.objectContaining({ kind: "user", text: "Keep this conversation" }),
    ]);
  });

  test("refuses to resume when the agent never advertised loadSession", async () => {
    const h = harness();
    await h.handshake();
    expect(h.adapter.resume?.("old-1", h.ctx)).toBe(false);
    expect(h.sent.some((message) => message.method === "session/load")).toBe(false);
  });

  test("reports a load the agent rejected instead of leaving the pane blank", async () => {
    const h = harness();
    await h.handshake({ agentCapabilities: { loadSession: true } });
    const resumed = h.adapter.resume?.("gone", h.ctx);
    h.feed({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "no such session" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(false);
    expect(h.state().items.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: "no such session" });
    expect(h.state().status).toBe("idle");
  });
});
