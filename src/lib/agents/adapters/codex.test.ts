import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { emptyUsage, type AgentSessionState } from "../types";
import { createCodexAdapter } from "./codex";

const launch: AgentLaunch = {
  agent: "codex",
  program: "codex",
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
  const adapter = createCodexAdapter();
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch: { ...launch, ...overrides },
    send: (message) => sent.push(message as Record<string, unknown>),
    emit: (event) => events.push(event),
  };
  const feed = (frame: unknown) => adapter.receive(JSON.stringify(frame), ctx);
  const notify = (method: string, params: unknown) => feed({ jsonrpc: "2.0", method, params });
  const state = () =>
    events.reduce<AgentSessionState>(applyEvent, {
      termId: "t1",
      agent: "codex",
      program: "codex",
      label: "Codex",
      mark: "CX",
      accent: "#8f9aa6",
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

  /** `initialize` → `initialized` → `thread/start` (+ a fire-and-forget `model/list`). */
  const handshake = async (threadResult: Record<string, unknown> = {}) => {
    adapter.start(ctx);
    await Promise.resolve();
    feed({ jsonrpc: "2.0", id: 1, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    feed({
      jsonrpc: "2.0",
      id: "duckweed-account-read",
      result: { account: { type: "chatgpt", email: null }, requiresOpenaiAuth: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    feed({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: { id: "thread_1", sessionId: "sess_1" },
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        ...threadResult,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  /** Answer the `model/list` the handshake fired, with two made-up models. */
  const loadModels = async () => {
    feed({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "high", description: "" },
            ],
            serviceTiers: [
              { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
            ],
          },
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "medium", description: "" },
            ],
            serviceTiers: [],
          },
        ],
        nextCursor: null,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  };

  return { adapter, ctx, events, sent, feed, notify, state, handshake, loadModels };
}

describe("codex adapter", () => {
  test("initializes, then opens a thread in the launch directory", async () => {
    const h = harness();
    await h.handshake();

    expect(h.sent[0]).toMatchObject({ method: "initialize" });
    expect(h.sent[1]).toMatchObject({ method: "initialized" });
    // No override: app-server inherits the same config as the normal TUI.
    expect(h.sent[2]).toEqual({
      jsonrpc: "2.0",
      id: "duckweed-account-read",
      method: "account/read",
      params: { refreshToken: false },
    });
    expect(h.sent[3]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: { cwd: "H:/project" },
    });
    expect(h.state()).toMatchObject({ status: "idle", sessionId: "sess_1" });
  });

  test("stops before opening a thread when Codex requires a login", async () => {
    const h = harness();
    h.adapter.start(h.ctx);
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 1, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({
      jsonrpc: "2.0",
      id: "duckweed-account-read",
      result: { account: null, requiresOpenaiAuth: true },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state()).toMatchObject({ status: "error", error: "Codex is not signed in." });
    expect(h.sent.some((message) => message.method === "thread/start")).toBe(false);
  });

  test("turns a retrying 401 notification into a terminal auth error", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "hello", images: [] }, h.ctx);
    h.notify("error", {
      error: {
        message: "Reconnecting... 2/5",
        additionalDetails: "401 Unauthorized: Missing bearer authentication",
      },
      willRetry: true,
    });

    expect(h.state()).toMatchObject({
      status: "error",
      error: expect.stringContaining("401 Unauthorized"),
    });
  });

  test("reads the model and effort the thread actually started with", async () => {
    const h = harness();
    await h.handshake();
    expect(h.state()).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  test("reads Fast Mode from the service tier the thread started with", async () => {
    const h = harness();
    await h.handshake({ serviceTier: "priority" });
    expect(h.state().serviceTier).toBe("priority");
  });

  test("publishes model/list rows for the header and composer pickers", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();
    const models = h.state().models;
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(models[0].efforts).toEqual(["low", "medium", "high"]);
    expect(models[0].label).toBe("GPT-5.6-Sol");
  });

  test("passes a requested model into the thread", async () => {
    const h = harness({ model: "gpt-5.6" });
    await h.handshake({ model: "gpt-5.6" });
    expect(h.sent[3]).toMatchObject({ params: { model: "gpt-5.6" } });
    expect(h.state().model).toBe("gpt-5.6");
  });

  test("passes a requested effort into the first turn", async () => {
    const h = harness({ effort: "xhigh" });
    await h.handshake({ reasoningEffort: "xhigh" });
    h.adapter.prompt({ text: "fix the bug", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { effort: "xhigh" },
    });
  });

  test("switches model with /model and carries it on later turns", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    expect(h.adapter.command?.("/model gpt-5.5", h.ctx)).toBe("handled");
    expect(h.state().model).toBe("gpt-5.5");

    h.adapter.prompt({ text: "hello", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { model: "gpt-5.5", effort: "high" },
    });
  });

  test("rejects a model the server never advertised", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    h.adapter.command?.("/model gpt-4.1", h.ctx);
    const state = h.state();
    expect(state.model).toBe("gpt-5.6-sol");
    expect(state.items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: 'Unknown model "gpt-4.1". Available: gpt-5.6-sol, gpt-5.5.',
    });
  });

  test("switches effort with /effort, validating against the model's own list", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    h.adapter.command?.("/effort xhigh", h.ctx);
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: 'gpt-5.6-sol does not take "xhigh" effort. Pick low, medium, high.',
    });
    expect(h.state().effort).toBe("high");

    h.adapter.command?.("/effort low", h.ctx);
    expect(h.state().effort).toBe("low");
    h.adapter.prompt({ text: "hello", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { effort: "low" },
    });
  });

  test("answers /model and /effort with the current values when asked bare", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    h.adapter.command?.("/model", h.ctx);
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "info",
      text: "Model: gpt-5.6-sol. Available: gpt-5.6-sol (current), gpt-5.5.",
    });

    h.adapter.command?.("/effort", h.ctx);
    expect(h.state().items.filter((item) => item.kind === "notice").at(-1)).toMatchObject({
      tone: "info",
      text: "Effort: high. gpt-5.6-sol supports: low, medium, high.",
    });
  });

  test("toggles Fast Mode through thread settings and carries it on later turns", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    expect(h.adapter.command?.("/fast", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/settings/update",
      params: { threadId: "thread_1", serviceTier: "priority" },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().serviceTier).toBe("priority");
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "info",
      text: "Fast Mode enabled.",
    });

    h.adapter.prompt({ text: "hello", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { serviceTier: "priority" },
    });
  });

  test("a second /fast clears the priority service tier", async () => {
    const h = harness();
    await h.handshake({ serviceTier: "priority" });
    await h.loadModels();

    h.adapter.command?.("/fast", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/settings/update",
      params: { threadId: "thread_1", serviceTier: null },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().serviceTier).toBeNull();
    expect(h.state().items.at(-1)).toMatchObject({ text: "Fast Mode disabled." });
  });

  test("blocks models that do not advertise Fast Mode while it is active", async () => {
    const h = harness();
    await h.handshake({ serviceTier: "priority" });
    await h.loadModels();

    h.adapter.command?.("/model gpt-5.5", h.ctx);
    expect(h.state().model).toBe("gpt-5.6-sol");
    expect(h.state().items.at(-1)).toMatchObject({
      tone: "error",
      text: "gpt-5.5 does not support Fast Mode. Use /fast to turn it off first.",
    });
  });

  test("sends /compact to the thread", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.command?.("/compact", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "thread/compact/start",
      params: { threadId: "thread_1" },
    });
  });

  test("sets a fresh persistent goal through the Codex control plane", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/goal Finish the migration and keep tests green", h.ctx)).toBe(
      "handled",
    );
    expect(h.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/goal/clear",
      params: { threadId: "thread_1" },
    });

    h.feed({ jsonrpc: "2.0", id: 4, result: { cleared: false } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({
      id: 5,
      method: "thread/goal/set",
      params: {
        threadId: "thread_1",
        objective: "Finish the migration and keep tests green",
        status: "active",
      },
    });

    h.feed({
      jsonrpc: "2.0",
      id: 5,
      result: {
        goal: {
          objective: "Finish the migration and keep tests green",
          status: "active",
          tokenBudget: null,
          tokensUsed: 1200,
          timeUsedSeconds: 7,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "info",
      text: "Goal active. Objective: Finish the migration and keep tests green · 1.2k tokens · 7s",
    });
    expect(h.state().goal).toEqual({
      objective: "Finish the migration and keep tests green",
      status: "active",
    });
  });

  test("keeps the goal indicator synchronized with provider notifications", async () => {
    const h = harness();
    await h.handshake();

    h.notify("thread/goal/updated", {
      threadId: "thread_1",
      goal: { objective: "Track the rollout", status: "active" },
    });
    expect(h.state().goal).toEqual({
      objective: "Track the rollout",
      status: "active",
    });

    h.notify("thread/goal/cleared", { threadId: "thread_1" });
    expect(h.state().goal).toBeNull();
  });

  test("views, pauses, resumes, clears, and edits the current goal", async () => {
    const h = harness();
    await h.handshake();

    h.adapter.command?.("/goal", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/goal/get",
      params: { threadId: "thread_1" },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: { goal: null } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.at(-1)).toMatchObject({
      text: "No goal is currently set. Use /goal <objective> to create one.",
    });

    h.adapter.command?.("/goal pause", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      id: 5,
      method: "thread/goal/set",
      params: { threadId: "thread_1", status: "paused" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 5,
      result: { goal: { objective: "Old goal", status: "paused" } },
    });
    await Promise.resolve();
    await Promise.resolve();

    h.adapter.command?.("/goal resume", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      id: 6,
      method: "thread/goal/set",
      params: { threadId: "thread_1", status: "active" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 6,
      result: { goal: { objective: "Old goal", status: "active" } },
    });
    await Promise.resolve();
    await Promise.resolve();

    h.adapter.command?.("/goal edit Revised goal", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({ id: 7, method: "thread/goal/get" });
    h.feed({
      jsonrpc: "2.0",
      id: 7,
      result: { goal: { objective: "Old goal", status: "paused" } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({
      id: 8,
      method: "thread/goal/set",
      params: { threadId: "thread_1", objective: "Revised goal", status: "paused" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 8,
      result: { goal: { objective: "Revised goal", status: "paused" } },
    });
    await Promise.resolve();
    await Promise.resolve();

    h.adapter.command?.("/goal clear", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      id: 9,
      method: "thread/goal/clear",
      params: { threadId: "thread_1" },
    });
  });

  test("rejects oversized goal objectives before sending an RPC", async () => {
    const h = harness();
    await h.handshake();
    const before = h.sent.length;
    h.adapter.command?.(`/goal ${"x".repeat(4_001)}`, h.ctx);
    expect(h.sent).toHaveLength(before);
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "error",
      text: expect.stringContaining("4,000 characters"),
    });
  });

  test("refuses an unknown command locally instead of paying for a turn", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.command?.("/frobnicate", h.ctx);
    // Nothing went on the wire except the handshake's model/list.
    expect(h.sent.at(-1)).toMatchObject({ method: "model/list" });
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "Unknown command /frobnicate. Codex knows /model, /effort, /fast, /compact, /goal.",
    });
  });

  test("follows a settings change the server announces", async () => {
    const h = harness();
    await h.handshake();
    h.notify("thread/settings/updated", {
      threadId: "thread_1",
      threadSettings: { model: "gpt-5.5", effort: "low", serviceTier: "priority" },
    });
    expect(h.state()).toMatchObject({
      model: "gpt-5.5",
      effort: "low",
      serviceTier: "priority",
    });

    h.notify("thread/settings/updated", {
      threadId: "thread_1",
      threadSettings: { model: "gpt-5.5", effort: "low", serviceTier: null },
    });
    expect(h.state().serviceTier).toBeNull();
  });

  test("streams reasoning and message deltas without repeating the settled text", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/reasoning/textDelta", { itemId: "r1", delta: "Checking the tests" });
    h.notify("item/completed", { item: { id: "r1", type: "reasoning", content: ["Checking the tests"] } });
    h.notify("item/agentMessage/delta", { itemId: "m1", delta: "All green." });
    h.notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "All green." } });

    const items = h.state().items;
    expect(items.map((item) => item.kind)).toEqual(["thinking", "assistant"]);
    expect(items[0]).toMatchObject({ text: "Checking the tests", streaming: false });
    expect(items[1]).toMatchObject({ text: "All green.", streaming: false });
  });

  test("shows a completed item that never streamed", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/completed", { item: { id: "m2", type: "agentMessage", text: "Resumed reply." } });
    expect(h.state().items[0]).toMatchObject({ kind: "assistant", text: "Resumed reply." });
  });

  test("tracks a command execution from start to output to exit", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      item: { id: "c1", type: "commandExecution", command: "bun test", cwd: "H:/project", status: "inProgress" },
    });
    h.notify("item/commandExecution/outputDelta", { itemId: "c1", delta: "30 pass\n" });
    h.notify("item/completed", {
      item: { id: "c1", type: "commandExecution", command: "bun test", cwd: "H:/project", status: "completed" },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "execute",
      title: "bun test",
      command: "bun test",
      status: "done",
      output: "30 pass\n",
    });
  });

  test("normalizes collaboration items into live subagent activity", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      item: {
        id: "sub1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread_1",
        receiverThreadIds: ["thread_child"],
        prompt: "Inspect the parser tests",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        agentsStates: {
          thread_child: { status: "running", message: "Reading tests" },
        },
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "task",
      status: "running",
      title: "Spawned subagent: Inspect the parser tests",
      output: expect.stringContaining("thread_child · running · Reading tests"),
      subagent: {
        label: "Inspect the parser tests",
        threadId: "thread_child",
        model: "gpt-5.6-sol",
        prompt: "Inspect the parser tests",
        activity: "Reading tests",
      },
    });

    h.notify("item/completed", {
      item: {
        id: "sub1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread_1",
        receiverThreadIds: ["thread_child"],
        prompt: "Inspect the parser tests",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        agentsStates: {
          thread_child: { status: "completed", message: "Found the failing case" },
        },
      },
    });

    expect(h.state().items).toHaveLength(1);
    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "task",
      status: "done",
      output: expect.stringContaining("thread_child · completed · Found the failing case"),
      subagent: expect.objectContaining({
        activity: "Found the failing case",
      }),
    });
  });

  test("routes child thread progress into the subagent without polluting the root", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-live",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["thread_child_live"],
        prompt: "Inspect the live event stream",
        agentsStates: {
          thread_child_live: { status: "pendingInit" },
        },
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      status: "pending",
      subagent: { activity: "Pending initialization" },
    });

    h.notify("thread/started", {
      thread: {
        id: "thread_child_live",
        parentThreadId: "thread_1",
        agentNickname: "Researcher",
        agentRole: "explorer",
      },
    });
    h.notify("turn/started", {
      threadId: "thread_child_live",
      turn: { id: "child_turn" },
    });
    h.notify("item/reasoning/textDelta", {
      threadId: "thread_child_live",
      turnId: "child_turn",
      itemId: "child_reasoning",
      delta: "Reading the event handlers",
    });

    let root = h.state();
    expect(root.items).toHaveLength(1);
    expect(root.items[0]).toMatchObject({
      kind: "tool",
      status: "running",
      subagent: {
        role: "explorer",
        activity: "Reading the event handlers",
        items: [
          {
            kind: "thinking",
            text: "Reading the event handlers",
            streaming: true,
          },
        ],
      },
    });

    h.notify("item/completed", {
      threadId: "thread_child_live",
      turnId: "child_turn",
      item: {
        id: "child_answer",
        type: "agentMessage",
        text: "The child events are now isolated.",
      },
    });
    h.notify("turn/completed", {
      threadId: "thread_child_live",
      turn: { id: "child_turn" },
    });

    root = h.state();
    expect(root.items).toHaveLength(1);
    expect(root.items[0]).toMatchObject({
      kind: "tool",
      status: "done",
      subagent: {
        activity: "The child events are now isolated.",
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "assistant",
            text: "The child events are now isolated.",
          }),
        ]),
      },
    });
  });

  test("starts a direct follow-up turn in a completed child thread", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/completed", {
      threadId: "thread_1",
      item: {
        id: "sub-direct",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["thread_child_direct"],
        prompt: "Inspect the parser",
        agentsStates: { thread_child_direct: { status: "completed" } },
      },
    });

    const pending = h.adapter.promptSubagent?.(
      "thread_child_direct",
      { text: "Now check the serializer", images: [] },
      h.ctx,
    );
    const call = h.sent.at(-1) as { id: number; method: string; params: unknown };
    expect(call).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread_child_direct",
        input: [{ type: "text", text: "Now check the serializer" }],
      },
    });
    h.feed({ jsonrpc: "2.0", id: call.id, result: { turn: { id: "direct-turn" } } });
    expect(await pending).toBe(true);
    expect(h.state().items[0]).toMatchObject({
      subagent: {
        items: expect.arrayContaining([
          expect.objectContaining({ kind: "user", text: "Now check the serializer" }),
        ]),
      },
    });
  });

  test("steers a child turn that is already running", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-steer",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["thread_child_steer"],
        prompt: "Inspect the parser",
        agentsStates: { thread_child_steer: { status: "running" } },
      },
    });
    h.notify("turn/started", {
      threadId: "thread_child_steer",
      turn: { id: "child-active-turn" },
    });

    const pending = h.adapter.promptSubagent?.(
      "thread_child_steer",
      { text: "Focus on Windows paths", images: [] },
      h.ctx,
    );
    const call = h.sent.at(-1) as { id: number; method: string; params: unknown };
    expect(call).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread_child_steer",
        expectedTurnId: "child-active-turn",
        input: [{ type: "text", text: "Focus on Windows paths" }],
      },
    });
    h.feed({ jsonrpc: "2.0", id: call.id, result: {} });
    expect(await pending).toBe(true);
  });

  test("steers an active child after hydration missed its turn-start event", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/completed", {
      threadId: "thread_1",
      item: {
        id: "sub-hydrated-steer",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["thread_child_hydrated"],
        prompt: "Inspect the parser",
        agentsStates: { thread_child_hydrated: { status: "running" } },
      },
    });
    const readCall = h.sent.at(-1) as { id: number; method: string };
    expect(readCall.method).toBe("thread/read");
    h.feed({
      jsonrpc: "2.0",
      id: readCall.id,
      result: {
        thread: {
          id: "thread_child_hydrated",
          status: { type: "active" },
          turns: [{ id: "hydrated-active-turn", items: [] }],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const pending = h.adapter.promptSubagent?.(
      "thread_child_hydrated",
      { text: "Focus on Windows paths", images: [] },
      h.ctx,
    );
    const steerCall = h.sent.at(-1) as { id: number; method: string; params: unknown };
    expect(steerCall).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread_child_hydrated",
        expectedTurnId: "hydrated-active-turn",
      },
    });
    h.feed({ jsonrpc: "2.0", id: steerCall.id, result: {} });
    expect(await pending).toBe(true);
  });

  test("keeps collaboration control operations out of the subagent fleet", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/completed", {
      threadId: "thread_1",
      item: {
        id: "wait-1",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        receiverThreadIds: ["thread_child"],
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "other",
      title: "Waiting for subagents",
    });
    expect(h.state().items[0]).not.toHaveProperty("subagent");
  });

  test("counts a unified patch into insertions and deletions", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/fileChange/patchUpdated", {
      itemId: "f1",
      changes: [
        {
          path: "src/app.ts",
          kind: { type: "update" },
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n",
        },
      ],
    });

    const tool = h.state().items[0];
    expect(tool.kind === "tool" && tool.changes[0]).toMatchObject({
      path: "src/app.ts",
      insertions: 2,
      deletions: 1,
    });
  });

  test("turns the plan notification into a checklist", async () => {
    const h = harness();
    await h.handshake();
    h.notify("turn/plan/updated", {
      threadId: "thread_1",
      turnId: "turn_1",
      plan: [
        { step: "Read the failing test", status: "completed" },
        { step: "Fix the bug", status: "inProgress" },
      ],
    });

    const plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.planType).toBe("tasks");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Read the failing test", status: "done" },
      { text: "Fix the bug", status: "running" },
    ]);
  });

  test("reads token usage and how much context it has eaten", async () => {
    const h = harness();
    await h.handshake();
    h.notify("thread/tokenUsage/updated", {
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        modelContextWindow: 1000,
        last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
        total: { inputTokens: 100, cachedInputTokens: 150, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 300 },
      },
    });

    expect(h.state().usage).toMatchObject({
      inputTokens: 250,
      outputTokens: 50,
      contextUsed: 0.3,
    });
  });

  test("asks before running a command, and forwards the decision", async () => {
    const h = harness();
    await h.handshake();
    h.feed({
      jsonrpc: "2.0",
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "c9", command: "rm -rf build", reason: "outside the sandbox", threadId: "thread_1", turnId: "turn_1", startedAtMs: 0 },
    });

    const permission = h.state().permission;
    expect(h.state().status).toBe("waiting");
    expect(permission).toMatchObject({ command: "rm -rf build", detail: "outside the sandbox" });

    h.adapter.respond(permission!.id, "acceptForSession", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({ id: 42, result: { decision: "acceptForSession" } });
    expect(h.state().permission).toBeNull();
  });

  test("ends the turn, surfacing a turn error as a notice", async () => {
    const h = harness();
    await h.handshake();
    h.notify("turn/started", { threadId: "thread_1", turn: { id: "turn_1", status: "inProgress", items: [] } });
    expect(h.state().status).toBe("working");

    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "failed", items: [], error: { message: "rate limited" } },
    });
    const state = h.state();
    expect(state.status).toBe("idle");
    expect(state.items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "rate limited",
    });
  });

  test("starts a turn with the typed prompt", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "fix the bug", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread_1",
        input: [{ type: "text", text: "fix the bug" }],
      },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", text: "fix the bug" });
  });

  test("maps the access picker onto Codex turn policies", async () => {
    const cases = [
      [
        "read-only",
        {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly" },
        },
      ],
      [
        "workspace",
        {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "workspaceWrite" },
        },
      ],
      [
        "full-access",
        {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      ],
    ] as const;

    for (const [mode, expected] of cases) {
      const h = harness();
      await h.handshake();
      expect(h.adapter.configureAccess?.(mode, h.ctx)).toBe(true);
      h.adapter.prompt({ text: "continue", images: [] }, h.ctx);
      expect(h.sent.at(-1)).toMatchObject({
        method: "turn/start",
        params: expected,
      });
      expect(h.state().accessMode).toBe(mode);
    }
  });

  test("opens a new thread with the remembered access level", async () => {
    const h = harness({ accessMode: "workspace" });
    await h.handshake();

    expect(h.sent.find((message) => message.method === "thread/start")).toMatchObject({
      params: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });
  });

  test("returns to inherited permissions without sending overrides", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.configureAccess?.("full-access", h.ctx);
    h.adapter.configureAccess?.("default", h.ctx);
    h.adapter.prompt({ text: "continue", images: [] }, h.ctx);

    const params = h.sent.at(-1)?.params as Record<string, unknown>;
    expect(params.approvalPolicy).toBeUndefined();
    expect(params.sandboxPolicy).toBeUndefined();
    expect(h.state().accessMode).toBe("default");
  });

  test("steers the turn already in flight", async () => {
    const h = harness();
    await h.handshake();
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_9", status: "inProgress", items: [] },
    });

    const steering = h.adapter.steer?.(
      { text: "focus on the failing tests", images: [image] },
      h.ctx,
    );
    expect(h.sent.at(-1)).toMatchObject({
      id: 4,
      method: "turn/steer",
      params: {
        threadId: "thread_1",
        expectedTurnId: "turn_9",
        input: [
          { type: "text", text: "focus on the failing tests" },
          { type: "image", url: image.dataUrl },
        ],
      },
    });

    h.feed({ jsonrpc: "2.0", id: 4, result: { turnId: "turn_9" } });
    await expect(steering).resolves.toBe(true);
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "user",
      text: "focus on the failing tests",
      images: [image],
    });
  });

  test("sends the original image instead of its thumbnail to Codex", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "What is wrong here?", images: [image] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        input: [
          { type: "text", text: "What is wrong here?" },
          { type: "image", url: image.dataUrl },
        ],
      },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", images: [image] });
  });

  test("interrupts only the turn that is actually running", async () => {
    const h = harness();
    await h.handshake();
    const idleWire = h.sent.length;
    h.adapter.interrupt(h.ctx);
    // No turn in flight: interrupting must not send anything.
    expect(h.sent.length).toBe(idleWire);

    h.notify("turn/started", { threadId: "thread_1", turn: { id: "turn_7", status: "inProgress", items: [] } });
    h.adapter.interrupt(h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread_1", turnId: "turn_7" },
    });
  });

  test("reports a refused handshake instead of a blank pane", async () => {
    const h = harness();
    h.adapter.start(h.ctx);
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 1, error: { message: "not logged in" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state()).toMatchObject({ status: "error", error: "not logged in" });
  });
  test("resumes a stored thread over the protocol, keeping the process", async () => {
    const h = harness();
    await h.handshake();
    const before = h.sent.length;

    const resumed = h.adapter.resume?.("thread_old", h.ctx);
    const call = h.sent.slice(before).find((message) => message.method === "thread/resume");
    expect(call?.params).toEqual({ threadId: "thread_old" });

    h.feed({
      jsonrpc: "2.0",
      id: (call as { id: number }).id,
      result: {
        thread: {
          id: "thread_old",
          sessionId: "sess_old",
          turns: [
            {
              id: "turn-old",
              items: [
                {
                  type: "userMessage",
                  id: "user-old",
                  content: [{ type: "text", text: "Inspect the parser" }],
                },
                {
                  type: "reasoning",
                  id: "reasoning-old",
                  summary: ["Checking compatibility"],
                  content: [],
                },
                {
                  type: "commandExecution",
                  id: "command-old",
                  command: "bun test",
                  status: "completed",
                  aggregatedOutput: "12 pass",
                },
                {
                  type: "agentMessage",
                  id: "answer-old",
                  text: "The parser is compatible.",
                },
              ],
            },
          ],
        },
        model: "gpt-5.6",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({ sessionId: "sess_old", model: "gpt-5.6", status: "idle" });
    expect(h.state().items).toEqual([
      expect.objectContaining({ kind: "user", text: "Inspect the parser" }),
      expect.objectContaining({ kind: "thinking", text: "Checking compatibility" }),
      expect.objectContaining({
        kind: "tool",
        command: "bun test",
        output: "12 pass",
        status: "done",
      }),
      expect.objectContaining({ kind: "assistant", text: "The parser is compatible." }),
    ]);

    // Later turns must run against the thread that was resumed.
    h.adapter.prompt({ text: "carry on", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: expect.objectContaining({ threadId: "thread_old" }),
    });
  });

  test("reattaches to an active turn when a background thread is resumed", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_background", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_background",
          sessionId: "sess_background",
          status: { type: "active" },
          turns: [
            {
              id: "turn_background",
              status: "inProgress",
              items: [
                {
                  type: "userMessage",
                  id: "user-background",
                  content: [{ type: "text", text: "Finish the long-running goal" }],
                },
                {
                  type: "agentMessage",
                  id: "update-background",
                  text: "Still working on it.",
                },
              ],
            },
          ],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({
      sessionId: "sess_background",
      status: "working",
    });
    expect(h.state().items).toEqual([
      expect.objectContaining({ kind: "user", text: "Finish the long-running goal" }),
      expect.objectContaining({ kind: "assistant", text: "Still working on it." }),
    ]);

    const steered = h.adapter.steer?.({ text: "continue", images: [] }, h.ctx);
    const steer = h.sent.at(-1) as { id: number };
    expect(steer).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread_background",
        expectedTurnId: "turn_background",
      },
    });
    h.feed({ jsonrpc: "2.0", id: steer.id, result: {} });
    await Promise.resolve();
    expect(await steered).toBe(true);
  });

  test("says so when a thread cannot be resumed", async () => {
    const h = harness();
    await h.handshake();
    const resumed = h.adapter.resume?.("gone", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.feed({ jsonrpc: "2.0", id: call.id, error: { message: "thread not found" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(false);
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "error",
      text: "thread not found",
    });
    expect(h.state().status).toBe("idle");
  });
});
