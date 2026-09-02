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

function harness(
  overrides: Partial<AgentLaunch> = {},
  adapterOptions: Parameters<typeof createCodexAdapter>[0] = { completionQuietMs: 0 },
) {
  const events: AgentEvent[] = [];
  const sent: Record<string, unknown>[] = [];
  const adapter = createCodexAdapter(adapterOptions);
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
          {
            id: "codex-auto-review",
            displayName: "Codex Auto Review",
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
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

    expect(h.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "duckweed", title: "Duckweed", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
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

  test("lists callable skills with their invocation names and excludes Computer Use", async () => {
    const h = harness();
    await h.handshake();

    const refresh = h.adapter.refreshExtensions?.(h.ctx);
    const calls = h.sent.filter((message) =>
      ["skills/list", "app/list", "plugin/list", "hooks/list", "mcpServerStatus/list"].includes(
        String(message.method),
      ),
    );
    for (const call of calls) {
      const result =
        call.method === "skills/list"
          ? {
              data: [
                {
                  cwd: "H:/project",
                  skills: [
                    {
                      name: "documents:documents",
                      description: "Create and edit documents",
                      interface: { displayName: "Documents" },
                      path: "H:/skills/documents/SKILL.md",
                      scope: "user",
                      enabled: true,
                    },
                    {
                      name: "computer-use:computer-use",
                      description: "Control Windows apps",
                      path: "H:/skills/computer-use/SKILL.md",
                      scope: "user",
                      enabled: true,
                    },
                  ],
                  errors: [],
                },
              ],
            }
          : call.method === "app/list"
            ? {
                data: [
                  {
                    id: "calendar",
                    name: "Calendar",
                    description: "Read calendar events",
                    isEnabled: true,
                    isAccessible: true,
                  },
                ],
                nextCursor: null,
              }
            : call.method === "plugin/list"
              ? { marketplaces: [] }
              : { data: [] };
      h.feed({ jsonrpc: "2.0", id: call.id, result });
    }

    const extensions = await refresh;
    expect(extensions).toEqual([
      expect.objectContaining({
        kind: "skill",
        name: "documents:documents",
        path: "H:/skills/documents/SKILL.md",
        callable: true,
      }),
      expect.objectContaining({
        id: "app:calendar",
        kind: "app",
        name: "Calendar",
        uri: "app://calendar",
        enabled: true,
        callable: true,
      }),
    ]);
  });

  test("preserves MCP boolean, numeric, and multi-select form values", async () => {
    const h = harness();
    await h.handshake();
    h.feed({
      jsonrpc: "2.0",
      id: "elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        serverName: "Reports",
        message: "Configure the report",
        requestedSchema: {
          type: "object",
          required: ["confirmed", "count", "ratio", "features", "mode"],
          properties: {
            confirmed: { type: "boolean", title: "Confirmed" },
            count: { type: "integer", title: "Count", minimum: 1, maximum: 10 },
            ratio: { type: "number", title: "Ratio" },
            features: {
              type: "array",
              title: "Features",
              items: { type: "string", enum: ["Search", "Export"] },
            },
            mode: {
              type: "string",
              title: "Mode",
              oneOf: [
                { const: "fast", title: "Fast mode" },
                { const: "safe", title: "Safe mode" },
              ],
            },
          },
        },
      },
    });

    const permission = h.state().permission!;
    expect(permission.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "confirmed", inputKind: "select" }),
        expect.objectContaining({
          id: "count",
          inputKind: "integer",
          minimum: 1,
          maximum: 10,
        }),
        expect.objectContaining({ id: "ratio", inputKind: "number" }),
        expect.objectContaining({ id: "features", inputKind: "multiselect", multiSelect: true }),
      ]),
    );

    h.adapter.answer?.(
      permission.id,
      [
        { questionId: "confirmed", labels: ["True"], custom: null },
        { questionId: "count", labels: [], custom: "3" },
        { questionId: "ratio", labels: [], custom: "1.5" },
        { questionId: "features", labels: ["Search", "Export"], custom: null },
        { questionId: "mode", labels: ["Fast mode"], custom: null },
      ],
      h.ctx,
    );

    expect(h.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "elicitation-1",
      result: {
        action: "accept",
        content: {
          confirmed: true,
          count: 3,
          ratio: 1.5,
          features: ["Search", "Export"],
          mode: "fast",
        },
        _meta: null,
      },
    });
  });

  test("hides internal models and repairs an internal current model", async () => {
    const h = harness();
    await h.handshake({ model: "codex-auto-review" });
    await h.loadModels();

    expect(h.state().models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    expect(h.state().model).toBe("gpt-5.6-sol");
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
    expect(h.sent.at(-2)).toMatchObject({
      id: 4,
      method: "thread/settings/update",
      params: { threadId: "thread_1", serviceTier: "priority" },
    });
    expect(h.sent.at(-1)).toMatchObject({
      id: 5,
      method: "config/batchWrite",
      params: {
        edits: [
          {
            keyPath: "service_tier",
            value: "fast",
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: {} });
    h.feed({ jsonrpc: "2.0", id: 5, result: {} });
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

  test("keeps the current reasoning effort when toggling Fast Mode", async () => {
    const h = harness();
    await h.handshake();
    await h.loadModels();

    expect(h.state().effort).toBe("high");
    h.adapter.command?.("/fast", h.ctx);
    expect(h.sent.at(-2)).toMatchObject({
      method: "thread/settings/update",
      params: { threadId: "thread_1", serviceTier: "priority", effort: "high" },
    });

    // Codex announces the full thread settings after a tier change, and the
    // stored effort is often still the model default.
    h.notify("thread/settings/updated", {
      threadId: "thread_1",
      threadSettings: { model: "gpt-5.6-sol", effort: "low", serviceTier: "priority" },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: {} });
    h.feed({ jsonrpc: "2.0", id: 5, result: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state()).toMatchObject({
      effort: "high",
      serviceTier: "priority",
    });
    expect(h.state().items.at(-1)).toMatchObject({ text: "Fast Mode enabled." });

    h.adapter.prompt({ text: "hello", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { effort: "high", serviceTier: "priority" },
    });
  });

  test("a second /fast persists the default service tier", async () => {
    const h = harness();
    await h.handshake({ serviceTier: "priority" });
    await h.loadModels();

    h.adapter.command?.("/fast", h.ctx);
    expect(h.sent.at(-2)).toMatchObject({
      id: 4,
      method: "thread/settings/update",
      params: { threadId: "thread_1", serviceTier: "default" },
    });
    expect(h.sent.at(-1)).toMatchObject({
      id: 5,
      method: "config/batchWrite",
      params: {
        edits: [
          {
            keyPath: "service_tier",
            value: "default",
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: {} });
    h.feed({ jsonrpc: "2.0", id: 5, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().serviceTier).toBe("default");
    expect(h.state().items.at(-1)).toMatchObject({ text: "Fast Mode disabled." });
  });

  test("uses the default tier for models that do not support active Fast Mode", async () => {
    const h = harness();
    await h.handshake({ serviceTier: "priority" });
    await h.loadModels();

    h.adapter.command?.("/model gpt-5.5", h.ctx);
    expect(h.state().model).toBe("gpt-5.5");
    expect(h.state().items.at(-1)).toMatchObject({
      tone: "info",
      text: "Model set to gpt-5.5.",
    });

    h.adapter.prompt({ text: "hello", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { model: "gpt-5.5", serviceTier: "default" },
    });

    h.adapter.command?.("/model gpt-5.6-sol", h.ctx);
    h.adapter.prompt({ text: "hello again", images: [] }, h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { model: "gpt-5.6-sol", serviceTier: "priority" },
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

  test("runs /side in an ephemeral read-only fork without touching the main transcript", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.commandAvailableDuringTurn?.("/side what changed?")).toBe(true);
    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/fork",
      params: {
        threadId: "thread_1",
        ephemeral: true,
        excludeTurns: true,
        sandbox: "read-only",
        model: "gpt-5.6-sol",
      },
    });
    expect(h.state().sideQuestion).toMatchObject({
      command: "/side",
      question: "what changed?",
      status: "asking",
    });
    expect(h.state().items).toEqual([]);

    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.at(-1)).toMatchObject({
      id: 5,
      method: "turn/start",
      params: {
        threadId: "side_1",
        input: [{ type: "text", text: "what changed?" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      },
    });
    h.feed({ jsonrpc: "2.0", id: 5, result: { turn: { id: "side_turn_1" } } });
    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      turnId: "side_turn_1",
      itemId: "side_message_1",
      delta: "Only the parser changed.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: { id: "side_message_1", type: "agentMessage", text: "Only the parser changed." },
    });
    h.notify("turn/completed", {
      threadId: "side_1",
      turn: { id: "side_turn_1", status: "completed", items: [] },
    });

    expect(h.state().sideQuestion).toMatchObject({
      answer: "Only the parser changed.",
      status: "answered",
    });
    expect(h.state().items).toEqual([]);
    expect(h.sent.at(-1)).toMatchObject({
      id: 6,
      method: "thread/unsubscribe",
      params: { threadId: "side_1" },
    });
  });

  test("settles /side on thread idle when turn/completed is omitted", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 5, result: { turn: { id: "side_turn_1" } } });
    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      turnId: "side_turn_1",
      itemId: "side_message_1",
      delta: "Only the parser changed.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: { id: "side_message_1", type: "agentMessage", text: "Only the parser changed." },
    });
    h.notify("thread/status/changed", {
      threadId: "side_1",
      status: { type: "idle" },
    });

    expect(h.state().sideQuestion).toMatchObject({
      answer: "Only the parser changed.",
      status: "answered",
    });
    expect(h.sent.at(-1)).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "side_1" },
    });

    h.notify("turn/completed", {
      threadId: "side_1",
      turn: { id: "side_turn_1", status: "completed", items: [] },
    });
    expect(h.state().sideQuestion).toMatchObject({
      answer: "Only the parser changed.",
      status: "answered",
    });

    expect(h.adapter.command?.("/btw and the tests?", h.ctx)).toBe("handled");
    expect(h.state().sideQuestion).toMatchObject({
      command: "/btw",
      question: "and the tests?",
      status: "asking",
    });
  });

  test("ignores side-thread idle until the forked turn has started", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    h.notify("thread/status/changed", {
      threadId: "side_1",
      status: { type: "idle" },
    });

    expect(h.state().sideQuestion).toMatchObject({
      question: "what changed?",
      status: "asking",
      answer: "",
    });
    expect(h.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: { threadId: "side_1" },
    });
  });

  test("keeps Codex commentary and reasoning out of the side-question answer", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 5, result: { turn: { id: "side_turn_1" } } });

    h.notify("item/started", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: { id: "side_think_1", type: "reasoning" },
    });
    h.notify("item/reasoning/textDelta", {
      threadId: "side_1",
      turnId: "side_turn_1",
      itemId: "side_think_1",
      delta: "The user asked about the parser. I should inspect the last edit.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: {
        id: "side_think_1",
        type: "reasoning",
        content: ["The user asked about the parser. I should inspect the last edit."],
      },
    });
    h.notify("item/started", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: { id: "side_comment_1", type: "agentMessage", phase: "commentary" },
    });
    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      turnId: "side_turn_1",
      itemId: "side_comment_1",
      phase: "commentary",
      delta: "Checking the last parser commit.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: {
        id: "side_comment_1",
        type: "agentMessage",
        phase: "commentary",
        text: "Checking the last parser commit.",
      },
    });

    expect(h.state().sideQuestion).toMatchObject({
      status: "asking",
      answer: "",
    });
    expect(h.state().items).toEqual([]);

    h.notify("item/started", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: { id: "side_answer_1", type: "agentMessage", phase: "final_answer" },
    });
    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      turnId: "side_turn_1",
      itemId: "side_answer_1",
      phase: "final_answer",
      delta: "Only the parser changed.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      turnId: "side_turn_1",
      item: {
        id: "side_answer_1",
        type: "agentMessage",
        phase: "final_answer",
        text: "Only the parser changed.",
      },
    });
    h.notify("turn/completed", {
      threadId: "side_1",
      turn: { id: "side_turn_1", status: "completed", items: [] },
    });

    expect(h.state().sideQuestion).toMatchObject({
      answer: "Only the parser changed.",
      status: "answered",
    });
    expect(h.state().sideQuestion?.answer).not.toContain("inspect the last edit");
    expect(h.state().sideQuestion?.answer).not.toContain("Checking the last parser commit.");
    expect(h.state().items).toEqual([]);
  });

  test("does not treat unphased thinking-then-answer side messages as one blob", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/btw what changed?", h.ctx)).toBe("handled");
    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 5, result: { turn: { id: "side_turn_1" } } });

    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      itemId: "side_trace_1",
      delta: "Let me think about the last diff.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      item: {
        id: "side_trace_1",
        type: "agentMessage",
        text: "Let me think about the last diff.",
      },
    });
    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      itemId: "side_trace_2",
      delta: "Only the parser changed.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      item: {
        id: "side_trace_2",
        type: "agentMessage",
        text: "Only the parser changed.",
      },
    });
    h.notify("turn/completed", {
      threadId: "side_1",
      turn: { id: "side_turn_1", status: "completed", items: [] },
    });

    expect(h.state().sideQuestion).toMatchObject({
      answer: "Only the parser changed.",
      status: "answered",
    });
    expect(h.state().sideQuestion?.answer).not.toContain("Let me think");
  });

  test("drops side commentary whose phase arrives only on item completion", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 5, result: { turn: { id: "side_turn_1" } } });

    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      itemId: "side_comment_late",
      delta: "Checking the last parser commit.",
    });
    expect(h.state().sideQuestion?.answer).toBe("Checking the last parser commit.");

    h.notify("item/completed", {
      threadId: "side_1",
      item: {
        id: "side_comment_late",
        type: "agentMessage",
        phase: "commentary",
        text: "Checking the last parser commit.",
      },
    });
    expect(h.state().sideQuestion).toMatchObject({
      status: "asking",
      answer: "",
    });

    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      itemId: "side_answer_late",
      delta: "Only the parser changed.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      item: {
        id: "side_answer_late",
        type: "agentMessage",
        phase: "final_answer",
        text: "Only the parser changed.",
      },
    });
    h.notify("turn/completed", {
      threadId: "side_1",
      turn: { id: "side_turn_1", status: "completed", items: [] },
    });

    expect(h.state().sideQuestion).toMatchObject({
      answer: "Only the parser changed.",
      status: "answered",
    });
    expect(h.state().sideQuestion?.answer).not.toContain("Checking the last parser commit.");
  });

  test("does not settle a commentary-only side thread as an answer", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    h.feed({ jsonrpc: "2.0", id: 4, result: { thread: { id: "side_1" } } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 5, result: { turn: { id: "side_turn_1" } } });

    h.notify("item/agentMessage/delta", {
      threadId: "side_1",
      itemId: "side_comment_only",
      delta: "Still thinking about the parser.",
    });
    h.notify("item/completed", {
      threadId: "side_1",
      item: {
        id: "side_comment_only",
        type: "agentMessage",
        phase: "commentary",
        text: "Still thinking about the parser.",
      },
    });
    h.notify("turn/completed", {
      threadId: "side_1",
      turn: { id: "side_turn_1", status: "completed", items: [] },
    });

    expect(h.state().sideQuestion).toMatchObject({
      status: "error",
      answer: "Codex did not return a side-conversation response.",
    });
    expect(h.state().sideQuestion?.answer).not.toContain("Still thinking");
  });

  test("holds /side and /btw out of the same-turn path until resume hydration finishes", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_old", h.ctx);
    expect(h.state()).toMatchObject({ status: "working", loadingHistory: true });
    expect(h.adapter.commandAvailableDuringTurn?.("/side what changed?")).toBe(false);
    expect(h.adapter.commandAvailableDuringTurn?.("/btw what changed?")).toBe(false);
    expect(h.adapter.commandAvailableDuringTurn?.("/goal pause")).toBe(true);

    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_old",
          sessionId: "sess_old",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: {
          data: [
            {
              id: "turn-old",
              status: "completed",
              itemsView: "full",
              items: [
                {
                  type: "userMessage",
                  id: "user-old",
                  content: [{ type: "text", text: "Inspect the parser" }],
                },
                {
                  type: "agentMessage",
                  id: "answer-old",
                  text: "The parser is compatible.",
                },
              ],
            },
          ],
          nextCursor: null,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({ status: "idle", loadingHistory: false });
    expect(h.adapter.commandAvailableDuringTurn?.("/side what changed?")).toBe(true);
    expect(h.adapter.commandAvailableDuringTurn?.("/btw what changed?")).toBe(true);

    expect(h.adapter.command?.("/side what changed?", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      method: "thread/fork",
      params: expect.objectContaining({ threadId: "thread_old" }),
    });
  });

  test("sets a fresh persistent goal through the Codex control plane", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/goal Finish the migration and keep tests green", h.ctx)).toBe(
      "handled-turn",
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

  test("distinguishes goal work from goal-only control commands", async () => {
    const h = harness();
    await h.handshake();

    expect(h.adapter.command?.("/goal", h.ctx)).toBe("handled");
    expect(h.adapter.command?.("/goal pause", h.ctx)).toBe("handled");
    expect(h.adapter.command?.("/goal clear", h.ctx)).toBe("handled");
    expect(h.adapter.command?.("/goal resume", h.ctx)).toBe("handled-turn");
    expect(h.adapter.command?.("/goal edit Finish the regression test", h.ctx)).toBe(
      "handled-turn",
    );
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
      text: "Unknown command /frobnicate. Codex knows /model, /effort, /fast, /compact, /goal, /side, and /btw.",
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

  test("links a spawn when the child thread id arrives in thread/started", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-late-id",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: [],
        prompt: "Audit the repository structure",
        agentsStates: {},
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      subagent: {
        prompt: "Audit the repository structure",
      },
    });
    expect(h.state().items[0]?.subagent?.threadId).toBeUndefined();

    const discovery = h.sent.findLast((message) => message.method === "thread/list") as {
      id: number;
      params: unknown;
    };
    expect(discovery.params).toMatchObject({ parentThreadId: "thread_1" });

    h.notify("thread/started", {
      thread: {
        id: "thread_child_late",
        parentThreadId: "thread_1",
        preview: "Audit the repository structure",
        agentNickname: "Pauli",
        agentRole: "explorer",
        status: { type: "active" },
      },
    });
    const read = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: read.id,
      result: {
        thread: {
          id: "thread_child_late",
          status: { type: "active" },
          turns: [
            {
              id: "child-turn",
              items: [
                {
                  id: "child-commentary",
                  type: "agentMessage",
                  text: "I found the main entrypoints and am checking their dependencies.",
                  phase: "commentary",
                },
                {
                  id: "child-command",
                  type: "commandExecution",
                  command: "rg --files",
                  cwd: "H:/project",
                  status: "completed",
                  aggregatedOutput: "src/index.ts\n",
                },
              ],
            },
          ],
        },
      },
    });
    h.feed({ jsonrpc: "2.0", id: discovery.id, result: { data: [] } });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      status: "running",
      subagent: {
        threadId: "thread_child_late",
        label: "Pauli",
        role: "explorer",
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "assistant",
            text: "I found the main entrypoints and am checking their dependencies.",
          }),
          expect.objectContaining({
            kind: "tool",
            title: "rg --files",
            status: "done",
          }),
        ]),
      },
    });
  });

  test("recovers a missed child start from the parent thread listing", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-discovered",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: [],
        prompt: "Review the data flow",
        agentsStates: {},
      },
    });

    const discovery = h.sent.findLast((message) => message.method === "thread/list") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: discovery.id,
      result: {
        data: [
          {
            id: "thread_child_discovered",
            parentThreadId: "thread_1",
            preview: "Review the data flow",
            agentNickname: "Dirac",
            agentRole: "explorer",
            status: { type: "active" },
          },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const read = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: read.id,
      result: {
        thread: {
          id: "thread_child_discovered",
          status: { type: "active" },
          turns: [
            {
              id: "child-turn",
              items: [
                {
                  id: "child-answer",
                  type: "agentMessage",
                  text: "The request crosses the API boundary twice.",
                },
              ],
            },
          ],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().items[0]).toMatchObject({
      subagent: {
        threadId: "thread_child_discovered",
        label: "Dirac",
        items: [
          expect.objectContaining({
            kind: "assistant",
            text: "The request crosses the API boundary twice.",
          }),
        ],
      },
    });
  });

  test("refreshes persisted child messages when the subagent is inspected", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-inspected",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["thread_child_inspected"],
        prompt: "Inspect the parser",
        agentsStates: { thread_child_inspected: { status: "running" } },
      },
    });
    const initialRead = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: initialRead.id,
      result: {
        thread: {
          id: "thread_child_inspected",
          status: { type: "active" },
          turns: [],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const inspection = h.adapter.inspectSubagent?.(
      "sub-inspected",
      "thread_child_inspected",
      h.ctx,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
    const refreshedRead = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    expect(refreshedRead.id).not.toBe(initialRead.id);
    h.feed({
      jsonrpc: "2.0",
      id: refreshedRead.id,
      result: {
        thread: {
          id: "thread_child_inspected",
          status: { type: "active" },
          turns: [
            {
              id: "child-turn",
              items: [
                {
                  id: "persisted-message",
                  type: "agentMessage",
                  text: "This message was loaded when the panel opened.",
                },
              ],
            },
          ],
        },
      },
    });
    expect(await inspection).toBe(true);

    expect(h.state().items[0]?.subagent?.items).toContainEqual(
      expect.objectContaining({
        kind: "assistant",
        text: "This message was loaded when the panel opened.",
      }),
    );
  });

  test("publishes a hydrated child transcript atomically", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-batched",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["thread_child_batched"],
        prompt: "Inspect several files",
        agentsStates: { thread_child_batched: { status: "running" } },
      },
    });

    const read = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    const before = h.events.length;
    h.feed({
      jsonrpc: "2.0",
      id: read.id,
      result: {
        thread: {
          id: "thread_child_batched",
          status: { type: "active" },
          turns: [
            {
              id: "child-turn",
              items: [
                { id: "thought", type: "reasoning", summary: ["Checking files"] },
                { id: "cmd", type: "commandExecution", command: "rg --files", status: "completed" },
                { id: "answer", type: "agentMessage", text: "Inspection complete." },
              ],
            },
          ],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.events.length - before).toBe(1);
    expect(h.state().items[0]?.subagent?.items.length).toBe(3);
  });

  test("does not regress a completed child to a stale active snapshot", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/completed", {
      threadId: "thread_1",
      item: {
        id: "sub-stale-status",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["thread_child_stale"],
        prompt: "Inspect status ordering",
        agentsStates: { thread_child_stale: { status: "completed" } },
      },
    });

    const read = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: read.id,
      result: {
        thread: {
          id: "thread_child_stale",
          status: { type: "active" },
          turns: [],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().items[0]).toMatchObject({
      status: "done",
      subagent: { activity: "Delegated work completed" },
    });
  });

  test("replaces a subagent path with its nickname without requiring inspection", async () => {
    const h = harness();
    await h.handshake();

    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-path-only",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "thread_child_named",
        agentPath: "/root/algorithm_research",
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      status: "running",
      subagent: {
        label: "/root/algorithm_research",
        threadId: "thread_child_named",
      },
    });

    const read = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: read.id,
      result: {
        thread: {
          id: "thread_child_named",
          agentNickname: "Pauli",
          agentRole: "explorer",
          status: { type: "active" },
          turns: [],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().items).toHaveLength(1);
    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      status: "running",
      subagent: {
        label: "Pauli",
        role: "explorer",
        threadId: "thread_child_named",
      },
    });
  });

  test("keeps streamed item ids isolated between parent and child threads", async () => {
    const h = harness();
    await h.handshake();
    h.notify("item/agentMessage/delta", {
      threadId: "thread_1",
      itemId: "shared-message-id",
      delta: "Parent message.",
    });
    h.notify("item/completed", {
      threadId: "thread_1",
      item: { id: "shared-message-id", type: "agentMessage", text: "Parent message." },
    });
    h.notify("item/started", {
      threadId: "thread_1",
      item: {
        id: "sub-shared-id",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["thread_child_shared"],
        prompt: "Inspect shared ids",
        agentsStates: { thread_child_shared: { status: "running" } },
      },
    });

    const read = h.sent.findLast((message) => message.method === "thread/read") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: read.id,
      result: {
        thread: {
          id: "thread_child_shared",
          status: { type: "active" },
          turns: [
            {
              id: "child-turn",
              items: [
                {
                  id: "shared-message-id",
                  type: "agentMessage",
                  text: "Child message with the same provider item id.",
                },
              ],
            },
          ],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().items[1]?.subagent?.items).toContainEqual(
      expect.objectContaining({
        kind: "assistant",
        text: "Child message with the same provider item id.",
      }),
    );
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

  test("accepts completion when the turn/start response is the only source of the turn id", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "finish the build", images: [] }, h.ctx);
    const start = h.sent.at(-1) as { id: number };

    // Some app-server schedules can answer the RPC without delivering the
    // matching turn/started notification to this client first.
    h.feed({
      jsonrpc: "2.0",
      id: start.id,
      result: { turn: { id: "turn_from_response", status: "inProgress", items: [] } },
    });
    await Promise.resolve();
    await Promise.resolve();
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_from_response", status: "completed", items: [] },
    });

    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("accepts a fast root completion before the turn/start response arrives", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "quick check", images: [] }, h.ctx);
    const start = h.sent.at(-1) as { id: number };

    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_fast", status: "completed", items: [] },
    });
    expect(h.state().status).toBe("idle");

    // A late response must not resurrect the already completed turn as an
    // interrupt target or leave the adapter working again.
    h.feed({
      jsonrpc: "2.0",
      id: start.id,
      result: { turn: { id: "turn_fast", status: "completed", items: [] } },
    });
    await Promise.resolve();
    await Promise.resolve();
    const sentBeforeInterrupt = h.sent.length;
    h.adapter.interrupt(h.ctx);
    expect(h.sent).toHaveLength(sentBeforeInterrupt);
    expect(h.state().status).toBe("idle");
  });

  test("waits through Codex auto-continuations and ends only after final quiet", async () => {
    const h = harness({}, { completionQuietMs: 20 });
    await h.handshake();
    h.adapter.prompt({ text: "finish the entire goal", images: [] }, h.ctx);
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "goal_turn_1", status: "inProgress", items: [] },
    });
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "goal_turn_1", status: "completed", items: [] },
    });

    expect(h.state().status).toBe("working");
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "goal_turn_2", status: "inProgress", items: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);
    expect(h.state().status).toBe("working");

    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "goal_turn_2", status: "completed", items: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
    expect(h.state().status).toBe("idle");
  });

  test("uses root thread idle as a completion fallback without double-ending", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "run the audit", images: [] }, h.ctx);
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_audit", status: "inProgress", items: [] },
    });

    h.notify("thread/status/changed", {
      threadId: "thread_1",
      status: { type: "idle" },
    });
    expect(h.state().status).toBe("idle");

    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "late_duplicate", status: "completed", items: [] },
    });
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("keeps a queued follow-up working when terminal frames from the previous turn arrive late", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "first task", images: [] }, h.ctx);
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_first", status: "inProgress", items: [] },
    });
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_first", status: "completed", items: [] },
    });
    expect(h.state().status).toBe("idle");

    // This is the message the session releases from its local follow-up queue.
    h.adapter.prompt({ text: "queued follow-up", images: [] }, h.ctx);
    expect(h.state().status).toBe("working");

    // App-server can drain these old terminal frames after turn/start for the
    // follow-up was already written. None may end or pollute the new turn.
    h.notify("item/completed", {
      threadId: "thread_1",
      turnId: "turn_first",
      item: {
        id: "late_first_answer",
        type: "agentMessage",
        phase: "final_answer",
        text: "Late duplicate answer.",
      },
    });
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_first", status: "completed", items: [] },
    });
    h.notify("thread/status/changed", {
      threadId: "thread_1",
      status: { type: "idle" },
    });

    expect(h.state().status).toBe("working");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
    expect(
      h.state().items.some(
        (item) => item.kind === "assistant" && item.text === "Late duplicate answer.",
      ),
    ).toBe(false);

    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_followup", status: "inProgress", items: [] },
    });
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_followup", status: "completed", items: [] },
    });

    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(2);
  });

  test("uses the final-answer item when both boundary notifications are missing", async () => {
    const h = harness({}, { completionQuietMs: 10 });
    await h.handshake();
    h.adapter.prompt({ text: "finish visibly", images: [] }, h.ctx);
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_visible", status: "inProgress", items: [] },
    });
    h.notify("item/completed", {
      threadId: "thread_1",
      turnId: "turn_visible",
      item: {
        id: "progress_visible",
        type: "agentMessage",
        phase: "commentary",
        text: "Still checking.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.state().status).toBe("working");

    h.notify("item/completed", {
      threadId: "thread_1",
      turnId: "turn_visible",
      item: {
        id: "answer_visible",
        type: "agentMessage",
        phase: "final_answer",
        text: "Everything is complete.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("keeps the active turn steerable while a final-answer fallback is quiet", async () => {
    const h = harness({}, { completionQuietMs: 20 });
    await h.handshake();
    h.adapter.prompt({ text: "inspect the failure", images: [] }, h.ctx);
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_steered_final", status: "inProgress", items: [] },
    });
    h.notify("item/completed", {
      threadId: "thread_1",
      turnId: "turn_steered_final",
      item: {
        id: "answer_before_steer",
        type: "agentMessage",
        phase: "final_answer",
        text: "The first answer.",
      },
    });

    const steering = h.adapter.steer?.(
      { text: "Check the other failing case too", images: [] },
      h.ctx,
    );
    const steer = h.sent.at(-1) as { id: number };
    expect(steer).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread_1",
        expectedTurnId: "turn_steered_final",
      },
    });
    // The old response can finish on the notification channel before the
    // steer RPC response is delivered. It must not invalidate that steer.
    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_steered_final", status: "completed", items: [] },
    });
    expect(h.state().status).toBe("working");
    h.feed({ jsonrpc: "2.0", id: steer.id, result: { turnId: "turn_steered_final" } });
    await expect(steering).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.state().status).toBe("working");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);

    h.notify("item/reasoning/textDelta", {
      threadId: "thread_1",
      turnId: "turn_steered_final",
      itemId: "reasoning_after_steer",
      delta: "Checking the other case now.",
    });
    expect(
      h.state().items.some(
        (item) => item.kind === "thinking" && item.text === "Checking the other case now.",
      ),
    ).toBe(true);

    h.notify("turn/completed", {
      threadId: "thread_1",
      turn: { id: "turn_steered_final", status: "completed", items: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("interrupts the provider turn while a final-answer fallback is quiet", async () => {
    const h = harness({}, { completionQuietMs: 20 });
    await h.handshake();
    h.adapter.prompt({ text: "run the check", images: [] }, h.ctx);
    h.notify("turn/started", {
      threadId: "thread_1",
      turn: { id: "turn_interrupt_final", status: "inProgress", items: [] },
    });
    h.notify("item/completed", {
      threadId: "thread_1",
      turnId: "turn_interrupt_final",
      item: {
        id: "answer_before_interrupt",
        type: "agentMessage",
        phase: "final_answer",
        text: "Almost settled.",
      },
    });

    h.adapter.interrupt(h.ctx);
    const interrupt = h.sent.at(-1) as { id: number };
    expect(interrupt).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread_1", turnId: "turn_interrupt_final" },
    });
    h.feed({ jsonrpc: "2.0", id: interrupt.id, result: {} });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
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
    const interrupt = h.sent.at(-1) as { id: number };
    h.feed({ jsonrpc: "2.0", id: interrupt.id, result: {} });
    await Promise.resolve();
    expect(h.state().status).toBe("idle");
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
    expect(call?.params).toEqual({
      threadId: "thread_old",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
    });

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

  test("hydrates paginated history in order, including image-only prompts", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_paged", h.ctx);
    const resumeCall = h.sent.find((message) => message.method === "thread/resume") as {
      id: number;
    };
    expect(h.state()).toMatchObject({ status: "working", loadingHistory: true });

    h.feed({
      jsonrpc: "2.0",
      id: resumeCall.id,
      result: {
        thread: {
          id: "thread_paged",
          sessionId: "sess_paged",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: {
          data: [
            {
              id: "turn-new",
              status: "completed",
              itemsView: "full",
              items: [
                {
                  type: "userMessage",
                  id: "user-image",
                  content: [{ type: "image", url: image.dataUrl }],
                },
                {
                  type: "agentMessage",
                  id: "answer-new",
                  text: "The screenshot is clear.",
                },
              ],
            },
          ],
          nextCursor: "older-turns",
          backwardsCursor: null,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const pageCall = h.sent.find((message) => message.method === "thread/turns/list") as {
      id: number;
      params: Record<string, unknown>;
    };
    expect(pageCall.params).toEqual({
      threadId: "thread_paged",
      cursor: "older-turns",
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    });
    h.feed({
      jsonrpc: "2.0",
      id: pageCall.id,
      result: {
        data: [
          {
            id: "turn-old",
            status: "completed",
            itemsView: "full",
            items: [
              {
                type: "userMessage",
                id: "user-old",
                content: [{ type: "text", text: "Inspect the old layout" }],
              },
              { type: "agentMessage", id: "answer-old", text: "I found the layout." },
            ],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({
      status: "idle",
      loadingHistory: false,
      sessionId: "sess_paged",
    });
    expect(h.state().items).toEqual([
      expect.objectContaining({ kind: "user", text: "Inspect the old layout" }),
      expect.objectContaining({ kind: "assistant", text: "I found the layout." }),
      expect.objectContaining({
        kind: "user",
        text: "",
        images: [
          expect.objectContaining({
            mimeType: "image/png",
            dataUrl: image.dataUrl,
          }),
        ],
      }),
      expect.objectContaining({ kind: "assistant", text: "The screenshot is clear." }),
    ]);
  });

  test("keeps a resumed thread completion on the root while hydration is in flight", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_finishing", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };

    // The target can finish before thread/resume returns. It is the selected
    // root conversation, not a newly discovered child thread.
    h.notify("turn/started", {
      threadId: "thread_finishing",
      turn: { id: "turn_finishing", status: "inProgress", items: [] },
    });
    h.notify("item/completed", {
      threadId: "thread_finishing",
      turnId: "turn_finishing",
      item: { id: "answer-finishing", type: "agentMessage", text: "Finished in time." },
    });
    h.notify("turn/completed", {
      threadId: "thread_finishing",
      turn: { id: "turn_finishing", status: "completed", items: [] },
    });
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);

    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_finishing",
          sessionId: "sess_finishing",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: {
          data: [
            {
              id: "turn_finishing",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: "user-finishing",
                  content: [{ type: "text", text: "Finish the task" }],
                },
                {
                  type: "agentMessage",
                  id: "answer-finishing",
                  text: "Finished in time.",
                },
              ],
            },
          ],
          nextCursor: null,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({ status: "idle", loadingHistory: false });
    expect(h.state().items).toEqual([
      expect.objectContaining({ kind: "user", text: "Finish the task" }),
      expect.objectContaining({ kind: "assistant", text: "Finished in time." }),
    ]);
    expect(h.state().items.some((item) => item.kind === "tool")).toBe(false);
  });

  test("does not invent a completion when an idle resumed thread reports its status", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_idle", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.notify("thread/status/changed", {
      threadId: "thread_idle",
      status: { type: "idle" },
    });
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);

    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_idle",
          sessionId: "sess_idle",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: { data: [], nextCursor: null },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);
    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);
  });

  test("reconciles a resumed completion from final output and thread idle alone", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_boundary_gap", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.notify("item/completed", {
      threadId: "thread_boundary_gap",
      turnId: "turn_boundary_gap",
      item: {
        id: "answer-boundary-gap",
        type: "agentMessage",
        text: "The work is complete.",
      },
    });
    h.notify("thread/status/changed", {
      threadId: "thread_boundary_gap",
      status: { type: "idle" },
    });
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);

    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_boundary_gap",
          sessionId: "sess_boundary_gap",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: { data: [], nextCursor: null },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);
    expect(h.state().status).toBe("idle");
  });

  test("does not let resume hydration preempt a quiet-window completion", async () => {
    const h = harness({}, { completionQuietMs: 20 });
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_quiet_resume", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.notify("turn/started", {
      threadId: "thread_quiet_resume",
      turn: { id: "turn_quiet_resume", status: "inProgress", items: [] },
    });
    h.notify("turn/completed", {
      threadId: "thread_quiet_resume",
      turn: { id: "turn_quiet_resume", status: "completed", items: [] },
    });

    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_quiet_resume",
          sessionId: "sess_quiet_resume",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: { data: [], nextCursor: null },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);

    // Hydration is an older snapshot. The authoritative turn end owns the
    // working -> idle transition after its auto-continuation guard expires.
    expect(h.state().status).toBe("working");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("does not resurrect a fallback completion from a late resume snapshot", async () => {
    const h = harness({}, { completionQuietMs: 10 });
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_late_snapshot", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.notify("item/completed", {
      threadId: "thread_late_snapshot",
      turnId: "turn_late_snapshot",
      item: { id: "answer-late", type: "agentMessage", text: "Done." },
    });
    h.notify("thread/status/changed", {
      threadId: "thread_late_snapshot",
      status: { type: "idle" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.state().status).toBe("idle");

    // This older response still says active and contains an unfinished turn.
    // The live item + idle notifications must remain authoritative.
    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_late_snapshot",
          status: { type: "active" },
          turns: [
            {
              id: "turn_late_snapshot",
              status: "inProgress",
              items: [],
            },
          ],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);
    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
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

  test("ignores a stale active thread status when every stored turn is finished", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_stale", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.feed({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        thread: {
          id: "thread_stale",
          status: { type: "active" },
          turns: [
            {
              id: "turn_finished",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: "user-finished",
                  content: [{ type: "text", text: "Already done" }],
                },
                { type: "agentMessage", id: "answer-finished", text: "Finished." },
              ],
            },
          ],
        },
      },
    });

    expect(await resumed).toBe(true);
    expect(h.state().status).toBe("idle");
    h.adapter.interrupt(h.ctx);
    expect(h.sent.some((message) => message.method === "turn/interrupt")).toBe(false);
  });

  test("lets Stop cancel a resume request that never answered", async () => {
    const h = harness();
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_stuck", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    expect(h.state().status).toBe("working");

    h.adapter.interrupt(h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "$/cancelRequest",
      params: { id: call.id },
    });
    expect(await resumed).toBe(false);
    expect(h.state().status).toBe("idle");
    expect(
      h.state().items.some((item) => item.kind === "notice" && item.tone === "error"),
    ).toBe(false);
  });

  test("times out a silent thread/resume, then hydrates a forked copy", async () => {
    const h = harness({}, { completionQuietMs: 0, resumeTimeoutMs: 40 });
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_stuck_active", h.ctx);
    expect(h.state()).toMatchObject({ status: "working", loadingHistory: true });
    await new Promise((resolve) => setTimeout(resolve, 70));

    const fork = h.sent.find((message) => message.method === "thread/fork") as {
      id: number;
      params: Record<string, unknown>;
    };
    expect(fork.params).toMatchObject({ threadId: "thread_stuck_active" });
    h.feed({ jsonrpc: "2.0", id: fork.id, result: { thread: { id: "thread_copy" } } });
    await Promise.resolve();
    await Promise.resolve();

    const resumes = h.sent.filter((message) => message.method === "thread/resume") as {
      id: number;
      params: Record<string, unknown>;
    }[];
    expect(resumes).toHaveLength(2);
    expect(resumes[1]?.params.threadId).toBe("thread_copy");
    h.feed({
      jsonrpc: "2.0",
      id: resumes[1]!.id,
      result: {
        thread: {
          id: "thread_copy",
          sessionId: "sess_copy",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: {
          data: [
            {
              id: "turn-copy",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: "user-copy",
                  content: [{ type: "text", text: "Keep going from the copy" }],
                },
                { type: "agentMessage", id: "answer-copy", text: "Copied." },
              ],
            },
          ],
          nextCursor: null,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({
      status: "idle",
      loadingHistory: false,
      sessionId: "sess_copy",
    });
    expect(h.state().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "notice",
          tone: "info",
          text: "Codex did not resume that conversation, so Duckweed opened a copy of it.",
        }),
        expect.objectContaining({ kind: "user", text: "Keep going from the copy" }),
        expect.objectContaining({ kind: "assistant", text: "Copied." }),
      ]),
    );
  });

  test("keeps the first history page when later transcript pages never answer", async () => {
    const h = harness({}, { completionQuietMs: 0, resumeTimeoutMs: 40 });
    await h.handshake();

    const resumed = h.adapter.resume?.("thread_paged_hang", h.ctx);
    const resumeCall = h.sent.find((message) => message.method === "thread/resume") as {
      id: number;
    };
    h.feed({
      jsonrpc: "2.0",
      id: resumeCall.id,
      result: {
        thread: {
          id: "thread_paged_hang",
          sessionId: "sess_paged_hang",
          status: { type: "idle" },
          turns: [],
        },
        initialTurnsPage: {
          data: [
            {
              id: "turn-new",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: "user-new",
                  content: [{ type: "text", text: "Inspect the latest layout" }],
                },
                { type: "agentMessage", id: "answer-new", text: "The latest layout is fine." },
              ],
            },
          ],
          nextCursor: "older-turns",
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.some((message) => message.method === "thread/turns/list")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(await resumed).toBe(true);
    expect(h.state()).toMatchObject({
      status: "idle",
      loadingHistory: false,
      sessionId: "sess_paged_hang",
    });
    expect(h.state().items).toEqual([
      expect.objectContaining({ kind: "user", text: "Inspect the latest layout" }),
      expect.objectContaining({ kind: "assistant", text: "The latest layout is fine." }),
    ]);
    expect(h.sent.some((message) => message.method === "thread/fork")).toBe(false);
  });

  test("does not fork when thread/resume returns an application error", async () => {
    const h = harness({}, { completionQuietMs: 0, resumeTimeoutMs: 40 });
    await h.handshake();
    const resumed = h.adapter.resume?.("gone", h.ctx);
    const call = h.sent.find((message) => message.method === "thread/resume") as { id: number };
    h.feed({ jsonrpc: "2.0", id: call.id, error: { message: "thread not found" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(false);
    expect(h.sent.some((message) => message.method === "thread/fork")).toBe(false);
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "error",
      text: "thread not found",
    });
    expect(h.state()).toMatchObject({ status: "idle", loadingHistory: false });
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
