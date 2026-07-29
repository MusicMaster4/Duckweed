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
      id: 2,
      method: "thread/start",
      params: { cwd: "H:/project" },
    });
    expect(h.state()).toMatchObject({ status: "idle", sessionId: "sess_1" });
  });

  test("reads the model and effort the thread actually started with", async () => {
    const h = harness();
    await h.handshake();
    expect(h.state()).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
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
    expect(h.sent[2]).toMatchObject({ params: { model: "gpt-5.6" } });
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

  test("sends /compact to the thread", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.command?.("/compact", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "thread/compact/start",
      params: { threadId: "thread_1" },
    });
  });

  test("sets, reads, pauses, resumes, and clears the thread goal over app-server", async () => {
    const h = harness();
    await h.handshake();

    h.adapter.command?.("/goal finish the migration", h.ctx);
    const set = h.sent.at(-1) as { id: number };
    expect(set).toMatchObject({
      method: "thread/goal/set",
      params: {
        threadId: "thread_1",
        objective: "finish the migration",
        status: "active",
      },
    });
    h.feed({
      jsonrpc: "2.0",
      id: set.id,
      result: {
        goal: {
          objective: "finish the migration",
          status: "active",
          tokenBudget: 1_000,
          tokensUsed: 120,
          timeUsedSeconds: 61,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.filter((item) => item.kind === "notice").at(-1)).toMatchObject({
      tone: "info",
      text: "Goal active.\nObjective: finish the migration\nTokens: 120 of 1,000.\nTime used: 1 min.",
    });
    expect(h.state().goal).toEqual({
      objective: "finish the migration",
      status: "active",
    });

    h.adapter.command?.("/goal", h.ctx);
    const get = h.sent.at(-1) as { id: number };
    expect(get).toMatchObject({
      method: "thread/goal/get",
      params: { threadId: "thread_1" },
    });
    h.feed({ jsonrpc: "2.0", id: get.id, result: { goal: null } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.filter((item) => item.kind === "notice").at(-1)).toMatchObject({
      text: "No goal is set for this thread.",
    });
    expect(h.state().goal).toBeNull();

    for (const [command, status] of [
      ["/goal pause", "paused"],
      ["/goal resume", "active"],
    ] as const) {
      h.adapter.command?.(command, h.ctx);
      const update = h.sent.at(-1) as { id: number };
      expect(update).toMatchObject({
        method: "thread/goal/set",
        params: { threadId: "thread_1", status },
      });
      h.feed({
        jsonrpc: "2.0",
        id: update.id,
        result: {
          goal: {
            objective: "finish the migration",
            status,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(h.state().goal?.status).toBe(status);
    }

    h.adapter.command?.("/goal clear", h.ctx);
    const clear = h.sent.at(-1) as { id: number };
    expect(clear).toMatchObject({
      method: "thread/goal/clear",
      params: { threadId: "thread_1" },
    });
    h.feed({ jsonrpc: "2.0", id: clear.id, result: { cleared: true } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.filter((item) => item.kind === "notice").at(-1)).toMatchObject({
      text: "Thread goal cleared.",
    });
    expect(h.state().goal).toBeNull();
  });

  test("follows native goal lifecycle notifications", async () => {
    const h = harness();
    await h.handshake();

    h.notify("thread/goal/updated", {
      threadId: "thread_1",
      goal: {
        objective: "finish the migration",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
      },
    });
    expect(h.state().goal).toEqual({
      objective: "finish the migration",
      status: "active",
    });

    h.notify("thread/goal/updated", {
      threadId: "thread_1",
      goal: {
        objective: "finish the migration",
        status: "complete",
        tokenBudget: null,
        tokensUsed: 240,
        timeUsedSeconds: 12,
      },
    });
    expect(h.state().goal?.status).toBe("complete");

    h.notify("thread/goal/cleared", { threadId: "thread_1" });
    expect(h.state().goal).toBeNull();
  });

  test("supports inline goal edits and surfaces app-server goal errors", async () => {
    const h = harness();
    await h.handshake();

    h.adapter.command?.("/goal edit keep every test green", h.ctx);
    const edit = h.sent.at(-1) as { id: number };
    expect(edit).toMatchObject({
      method: "thread/goal/set",
      params: {
        threadId: "thread_1",
        objective: "keep every test green",
        status: "active",
      },
    });
    h.feed({ jsonrpc: "2.0", id: edit.id, error: { message: "goals are disabled" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().items.filter((item) => item.kind === "notice").at(-1)).toMatchObject({
      tone: "error",
      text: "goals are disabled",
    });

    expect(h.adapter.commandAvailableDuringTurn?.("/goal pause")).toBe(true);
    expect(h.adapter.commandAvailableDuringTurn?.("/compact")).toBe(false);
  });

  test("refuses an unknown command locally instead of paying for a turn", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.command?.("/frobnicate", h.ctx);
    // Nothing went on the wire except the handshake's model/list.
    expect(h.sent.at(-1)).toMatchObject({ method: "model/list" });
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "Unknown command /frobnicate. Codex knows /model, /effort, /compact, and /goal.",
    });
  });

  test("follows a settings change the server announces", async () => {
    const h = harness();
    await h.handshake();
    h.notify("thread/settings/updated", {
      threadId: "thread_1",
      threadSettings: { model: "gpt-5.5", effort: "low" },
    });
    expect(h.state()).toMatchObject({ model: "gpt-5.5", effort: "low" });
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
    });
  });

  test("ignores child-thread messages and completion while the parent turn is running", async () => {
    const h = harness();
    await h.handshake();
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_parent", status: "inProgress", items: [] },
    });

    h.notify("turn/started", {
      threadId: "thread_child",
      turn: { id: "turn_child", status: "inProgress", items: [] },
    });
    // Defense in depth for older/malformed app-server payloads: a child turn
    // must not replace the already-active parent even without thread routing.
    h.notify("turn/started", {
      turn: { id: "turn_child_without_thread", status: "inProgress", items: [] },
    });
    h.notify("turn/completed", {
      turn: { id: "turn_child_without_thread", status: "completed", items: [] },
    });
    h.notify("item/completed", {
      threadId: "thread_child",
      turnId: "turn_child",
      item: {
        id: "child-answer",
        type: "agentMessage",
        text: "Completed the read-only audit. No files were changed.",
      },
    });
    h.notify("turn/completed", {
      threadId: "thread_child",
      turn: { id: "turn_child", status: "completed", items: [] },
    });

    expect(h.state().status).toBe("working");
    expect(h.state().items).toEqual([]);

    h.adapter.interrupt(h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread_1", turnId: "turn_parent" },
    });

    h.notify("item/completed", {
      threadId: "thread_1",
      turnId: "turn_parent",
      item: {
        id: "parent-answer",
        type: "agentMessage",
        text: "The parent task is actually complete.",
      },
    });
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_parent", status: "completed", items: [] },
    });

    expect(h.state().status).toBe("idle");
    expect(h.state().items).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "The parent task is actually complete.",
      }),
    ]);
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
