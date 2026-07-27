import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { emptyUsage, type AgentSessionState } from "../types";
import { createCodexAdapter } from "./codex";

const launch: AgentLaunch = {
  agent: "codex",
  args: [],
  prompt: null,
  model: null,
  effort: null,
  resume: false,
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
      label: "Codex",
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
    // Kebab-case here, and only here. The app-server rejects `onRequest`
    // ("expected one of untrusted, on-request, granular, never") and rejects
    // `workspaceWrite` for this field — while `turn/start` below wants the
    // opposite convention for its sandbox. Both spellings are load-bearing.
    expect(h.sent[2]).toMatchObject({
      method: "thread/start",
      params: { cwd: "H:/project", approvalPolicy: "on-request", sandbox: "workspace-write" },
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
    h.adapter.prompt("fix the bug", h.ctx);
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

    h.adapter.prompt("hello", h.ctx);
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
      text: 'Unknown model "gpt-4.1" — available: gpt-5.6-sol, gpt-5.5.',
    });
  });

  test("switches effort with /effort, validating against the model's own list", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    h.adapter.command?.("/effort xhigh", h.ctx);
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: 'gpt-5.6-sol does not take "xhigh" effort — pick low, medium, high.',
    });
    expect(h.state().effort).toBe("high");

    h.adapter.command?.("/effort low", h.ctx);
    expect(h.state().effort).toBe("low");
    h.adapter.prompt("hello", h.ctx);
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

  test("refuses an unknown command locally instead of paying for a turn", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.command?.("/frobnicate", h.ctx);
    // Nothing went on the wire except the handshake's model/list.
    expect(h.sent.at(-1)).toMatchObject({ method: "model/list" });
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "Unknown command /frobnicate — Codex knows /model, /effort, /compact.",
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
    h.adapter.prompt("fix the bug", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread_1",
        input: [{ type: "text", text: "fix the bug" }],
        approvalPolicy: "on-request",
        // camelCase, unlike `thread/start`'s `sandbox` above: the app-server
        // answers `workspace-write` here with "unknown variant … expected one
        // of dangerFullAccess, readOnly, externalSandbox, workspaceWrite".
        sandboxPolicy: { type: "workspaceWrite" },
      },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", text: "fix the bug" });
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
});
