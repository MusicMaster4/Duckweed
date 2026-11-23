import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { subagentsForTurn } from "../subagents";
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
  const resolved = { ...launch, ...overrides };
  const adapter = createAcpAdapter(resolved.agent);
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch: resolved,
    send: (message) => sent.push(message as Record<string, unknown>),
    emit: (event) => events.push(event),
  };
  const feed = (frame: unknown) => adapter.receive(JSON.stringify(frame), ctx);
  const update = (payload: unknown, sessionId = "s1") =>
    feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
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

/** Grok 1.0.24+ handshake: grok-4.6 lists xhigh; grok-4.5 does not. */
const GROK_46_MODEL_STATE = {
  currentModelId: "grok-4.6",
  availableModels: [
    {
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          {
            id: "xhigh",
            value: "xhigh",
            label: "Extra High Effort",
            description: "Highest effort and reasoning level",
            default: false,
          },
          {
            id: "high",
            value: "high",
            label: "High Effort",
            default: true,
          },
          { id: "medium", value: "medium", label: "Medium Effort" },
          { id: "low", value: "low", label: "Low Effort" },
        ],
      },
    },
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", value: "high", label: "High Effort", default: true },
          { id: "medium", value: "medium", label: "Medium Effort" },
          { id: "low", value: "low", label: "Low Effort" },
        ],
      },
    },
  ],
};

const GROK_46_CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "grok-4.6",
    options: [
      { value: "grok-4.6", name: "Grok 4.6" },
      { value: "grok-4.5", name: "Grok 4.5" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "xhigh", name: "Extra High Effort", description: "Highest effort and reasoning level" },
      { value: "high", name: "High Effort" },
      { value: "medium", name: "Medium Effort" },
      { value: "low", name: "Low Effort" },
    ],
  },
];

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

  test("keeps Grok filesystem tools native even with the UI file service installed", async () => {
    const h = harness();
    const calls: string[] = [];
    h.ctx.files = {
      readText: async (path) => {
        calls.push(path);
        return { content: "", binary: true, tooLarge: false };
      },
      writeText: async (path) => { calls.push(path); },
    };
    await h.handshake();
    expect(h.sent[0]).toMatchObject({
      params: { clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false }, terminal: false,
      } },
    });
    for (const [id, method, path] of [
      [71, "fs/read_text_file", "H:/project/screenshot.png"],
      [72, "fs/read_text_file", "C:/Users/test/.grok/skills/design/SKILL.md"],
      [73, "fs/write_text_file", "H:/project/nested/new.txt"],
    ] as const) {
      h.feed({ jsonrpc: "2.0", id, method, params: { path, content: "test" } });
      expect(h.sent.at(-1)).toMatchObject({ id, error: { code: -32601 } });
    }
    expect(calls).toEqual([]);
  });

  for (const agent of ["cursor", "opencode"] as const) {
    test(`preserves ${agent} client text reads and writes`, async () => {
      const h = harness({ agent });
      const writes: string[] = [];
      h.ctx.files = {
        readText: async () => ({ content: "one\ntwo\nthree\n", binary: false, tooLarge: false }),
        writeText: async (path, content) => { writes.push(`${path}:${content}`); },
      };
      await h.handshake();
      expect(h.sent[0]).toMatchObject({
        params: { clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
      });
      h.feed({ jsonrpc: "2.0", id: 71, method: "fs/read_text_file",
        params: { path: "a.txt", line: 2, limit: 1 } });
      await Promise.resolve();
      expect(h.sent.at(-1)).toMatchObject({ id: 71, result: { content: "two\n" } });
      h.feed({ jsonrpc: "2.0", id: 72, method: "fs/write_text_file",
        params: { path: "a.txt", content: "updated" } });
      await Promise.resolve();
      expect(writes).toEqual(["H:/project/a.txt:updated"]);
      h.feed({ jsonrpc: "2.0", id: 73, method: "fs/read_text_file",
        params: { path: "../outside.txt" } });
      expect(h.sent.at(-1)).toMatchObject({ id: 73, error: { code: -32602 } });
    });
  }

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

  test("keeps interleaved thought and message tokens in one block each", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "inspect", images: [] }, h.ctx);

    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The repo is " },
    });
    h.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Expo first. " },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Expo/" },
    });
    h.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Then RN." },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "RN." },
    });

    expect(
      h.state().items
        .filter((item) => item.kind === "thinking" || item.kind === "assistant")
        .map((item) => ({ id: item.id, kind: item.kind, text: item.text })),
    ).toEqual([
      { id: "a1", kind: "assistant", text: "The repo is Expo/RN." },
      { id: "r1", kind: "thinking", text: "Expo first. Then RN." },
    ]);
  });

  test("does not split a message when an existing tool reports progress", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "inspect", images: [] }, h.ctx);

    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "and the existing implement" },
    });
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Read notes",
      kind: "read",
      status: "in_progress",
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "er notes so the feature " },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "map cites real symbols." },
    });

    expect(
      h.state().items
        .filter((item) => item.kind === "assistant")
        .map((item) => ({ id: item.id, text: item.text })),
    ).toEqual([
      { id: "a1", text: "and the existing implement" },
      { id: "a1-2", text: "er notes so the feature map cites real symbols." },
    ]);
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

  test("does not complete an ACP subagent on its async launch acknowledgement", async () => {
    const h = harness();
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "background_agent",
      title: "Author the shots",
      status: "in_progress",
      rawInput: { tool: "Agent", description: "Author the shots" },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "background_agent",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Async agent launched successfully." } }],
    });
    expect(h.state().items[0]).toMatchObject({
      kind: "tool", tool: "task", status: "running", subagent: { activity: "Working" },
    });

    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "background_agent",
      status: "completed",
    });
    expect(h.state().items[0]).toMatchObject({ status: "running" });

    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "background_agent",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "All shots rendered" } }],
    });
    expect(h.state().items[0]).toMatchObject({ status: "done" });
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

  test("treats an empty previous version as a new file", async () => {
    const h = harness();
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_new",
      title: "Write src/new.ts",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", path: "src/new.ts", oldText: "", newText: "one\ntwo" },
      ],
    });

    const tool = h.state().items[0];
    expect(tool.kind === "tool" && tool.changes[0]).toMatchObject({
      path: "src/new.ts",
      before: null,
      after: "one\ntwo",
      insertions: 2,
      deletions: 0,
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

  test("lifts OpenCode's todos tool into the plan checklist", async () => {
    const h = harness({ agent: "opencode", program: "opencode" });
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "todo_1",
      title: "4 todos",
      kind: "other",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: JSON.stringify([
              { content: "Redesign index.html", status: "in_progress", priority: "high" },
              { content: "Rewrite app.css", status: "pending", priority: "high" },
              { content: "Improve app.js", status: "pending", priority: "high" },
              { content: "Run the checks", status: "pending", priority: "medium" },
            ]),
          },
        },
      ],
    });

    expect(h.state().items).toHaveLength(1);
    expect(h.state().items[0]).toMatchObject({
      kind: "plan",
      planType: "tasks",
      steps: [
        { text: "Redesign index.html", status: "running" },
        { text: "Rewrite app.css", status: "pending" },
        { text: "Improve app.js", status: "pending" },
        { text: "Run the checks", status: "pending" },
      ],
    });
  });

  test("keeps OpenCode todo updates in one checklist and hides the raw tool", async () => {
    const h = harness({ agent: "opencode", program: "opencode" });
    await h.handshake();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "todo_1",
      title: "2 todos",
      kind: "other",
      status: "in_progress",
      rawInput: {
        todos: [
          { content: "Inspect the adapter", status: "in_progress" },
          { content: "Add coverage", status: "pending" },
        ],
      },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "todo_1",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: JSON.stringify([
              { content: "Inspect the adapter", status: "completed" },
              { content: "Add coverage", status: "in_progress" },
            ]),
          },
        },
      ],
    });

    const plans = h.state().items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(h.state().items.some((item) => item.kind === "tool")).toBe(false);
    expect(plans[0]).toMatchObject({
      steps: [
        { text: "Inspect the adapter", status: "done" },
        { text: "Add coverage", status: "running" },
      ],
    });
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

  test("applies a selected local skill over ACP", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt(
      {
        text: "$unslop rewrite this",
        images: [],
        parts: [
          { type: "text", text: "$unslop rewrite this" },
          { type: "skill", id: "local:unslop", name: "unslop", path: "H:/skills/unslop/SKILL.md" },
        ],
      },
      h.ctx,
    );
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: expect.stringContaining('Read "H:/skills/unslop/SKILL.md" completely'),
          },
        ],
      },
    });
    expect(h.state().items.at(-1)).toMatchObject({ kind: "user", text: "$unslop rewrite this" });
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

  test("steers a Grok turn already in flight without ending it", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "fix the parser", images: [] }, h.ctx);
    const original = h.sent.find((message) => message.method === "session/prompt");
    expect(original).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "fix the parser" }] },
    });
    expect(h.state().status).toBe("working");

    const steering = h.adapter.steer?.(
      { text: "Focus on the failing test instead", images: [image] },
      h.ctx,
    );
    expect(h.adapter.steer).toBeTypeOf("function");
    const interject = h.sent.find((message) => message.method === "_x.ai/interject");
    expect(interject).toMatchObject({
      method: "_x.ai/interject",
      params: {
        sessionId: "s1",
        text: "Focus on the failing test instead",
        content: [
          { type: "text", text: "Focus on the failing test instead" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    });
    expect(interject?.id).not.toBe(original?.id);
    expect(h.sent.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(h.sent.some((message) => message.method === "session/cancel")).toBe(false);
    expect(h.state().items.filter((item) => item.kind === "user")).toHaveLength(1);

    h.feed({ jsonrpc: "2.0", id: interject?.id, result: { status: "queued" } });
    await expect(steering).resolves.toBe(true);
    expect(h.state().status).toBe("working");
    expect(h.state().items.at(-1)).toMatchObject({
      kind: "user",
      text: "Focus on the failing test instead",
      images: [image],
      sameTurn: true,
    });
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);
    expect(h.events.filter((event) => event.type === "status" && event.status === "idle")).toHaveLength(
      1,
    );

    expect(h.sent.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    h.feed({ jsonrpc: "2.0", id: original?.id, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("returns false when Grok rejects mid-turn interject", async () => {
    const h = harness();
    await h.handshake();
    h.adapter.prompt({ text: "fix the parser", images: [] }, h.ctx);
    const original = h.sent.find((message) => message.method === "session/prompt");

    const steering = h.adapter.steer?.({ text: "Focus on the failing test", images: [] }, h.ctx);
    const interject = h.sent.find((message) => message.method === "_x.ai/interject");
    expect(interject).toMatchObject({
      method: "_x.ai/interject",
      params: { sessionId: "s1", text: "Focus on the failing test" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: interject?.id,
      error: { code: -32601, message: "Method not found" },
    });
    await expect(steering).resolves.toBe(false);
    expect(h.state().items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(h.state().items.some((item) => item.kind === "user" && item.sameTurn)).toBe(false);
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(0);
    expect(h.state().status).toBe("working");
    expect(h.sent.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(h.sent.some((message) => message.method === "session/cancel")).toBe(false);

    h.feed({ jsonrpc: "2.0", id: original?.id, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().status).toBe("idle");
    expect(h.events.filter((event) => event.type === "turn-end")).toHaveLength(1);
  });

  test("does not expose same-turn steering for Cursor", async () => {
    const h = harness({ agent: "cursor", program: "cursor-agent" });
    await h.handshake();
    h.adapter.prompt({ text: "hi", images: [] }, h.ctx);
    expect(h.adapter.steer).toBeUndefined();
  });

  test("does not expose same-turn steering for OpenCode", async () => {
    const h = harness({ agent: "opencode", program: "opencode" });
    await h.handshake();
    h.adapter.prompt({ text: "hi", images: [] }, h.ctx);
    expect(h.adapter.steer).toBeUndefined();
  });

  test("refuses to steer Grok when no turn is in flight", async () => {
    const h = harness();
    await h.handshake();
    expect(await h.adapter.steer?.({ text: "later", images: [] }, h.ctx)).toBe(false);
    expect(h.sent.filter((message) => message.method === "session/prompt")).toHaveLength(0);
    expect(h.sent.filter((message) => message.method === "_x.ai/interject")).toHaveLength(0);
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

  test("sends images as embedded resources when the agent rejects native image blocks", async () => {
    const h = harness();
    await h.handshake({
      agentCapabilities: {
        promptCapabilities: { image: false, embeddedContext: true },
      },
    });

    h.adapter.prompt({ text: "Describe this", images: [image] }, h.ctx);

    expect(h.sent.at(-1)).toMatchObject({
      method: "session/prompt",
      params: {
        prompt: [
          { type: "text", text: "Describe this" },
          {
            type: "resource",
            resource: {
              uri: "attachment://duckweed/image-1/screenshot.png",
              blob: "aGVsbG8=",
              mimeType: "image/png",
            },
          },
        ],
      },
    });
    expect(h.state().capabilities?.inputs.image).toBe(true);
    expect(
      h.events.some(
        (event) => event.type === "notice" && event.text.includes("does not accept image input"),
      ),
    ).toBe(false);
  });

  test("reports unsupported images only when ACP offers no binary fallback", async () => {
    const h = harness();
    await h.handshake({
      agentCapabilities: {
        promptCapabilities: { image: false, embeddedContext: false },
      },
    });

    h.adapter.prompt({ text: "Describe this", images: [image] }, h.ctx);

    expect(h.sent.at(-1)).toMatchObject({
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Describe this" }] },
    });
    expect(h.state().capabilities?.inputs.image).toBe(false);
    expect(
      h.events.some(
        (event) => event.type === "notice" && event.text.includes("does not accept image input"),
      ),
    ).toBe(true);
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

  test("reads Grok 4.6 xhigh from modelState and configOptions without stamping it onto 4.5", async () => {
    const h = harness();
    await h.handshake(
      { _meta: { modelState: GROK_46_MODEL_STATE } },
      { models: GROK_46_MODEL_STATE, configOptions: GROK_46_CONFIG_OPTIONS },
    );
    const state = h.state();
    expect(state.model).toBe("grok-4.6");
    expect(state.effort).toBe("high");
    expect(state.models.find((model) => model.id === "grok-4.6")?.efforts).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    expect(state.models.find((model) => model.id === "grok-4.5")?.efforts).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  test("reads effort rows that only carry value, the Grok catalog shape", async () => {
    const h = harness();
    await h.handshake({
      _meta: {
        modelState: {
          currentModelId: "grok-4.6",
          availableModels: [
            {
              modelId: "grok-4.6",
              name: "Grok 4.6",
              _meta: {
                reasoningEffort: "high",
                reasoningEfforts: [
                  { value: "xhigh", label: "Extra High Effort" },
                  { value: "high", label: "High Effort" },
                  { value: "medium" },
                  { value: "low" },
                ],
              },
            },
          ],
        },
      },
    });
    expect(h.state().models.find((model) => model.id === "grok-4.6")?.efforts).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  test("switches Grok effort through reasoning_effort, not OpenCode's effort id", async () => {
    const h = harness();
    await h.handshake(
      { _meta: { modelState: GROK_46_MODEL_STATE } },
      { models: GROK_46_MODEL_STATE, configOptions: GROK_46_CONFIG_OPTIONS },
    );

    expect(h.adapter.command?.("/effort xhigh", h.ctx)).toBe("handled");
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "reasoning_effort", value: "xhigh" },
    });
    h.feed({
      jsonrpc: "2.0",
      id: 3,
      result: {
        configOptions: GROK_46_CONFIG_OPTIONS.map((option) =>
          option.id === "reasoning_effort" ? { ...option, currentValue: "xhigh" } : option,
        ),
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state().effort).toBe("xhigh");
  });

  test("keeps the live effort when Grok refreshes the model catalog", async () => {
    const h = harness();
    await h.handshake(
      { _meta: { modelState: GROK_46_MODEL_STATE } },
      { models: GROK_46_MODEL_STATE, configOptions: GROK_46_CONFIG_OPTIONS },
    );
    const changing = Promise.resolve(h.adapter.configure?.("effort", "xhigh", h.ctx));
    await Promise.resolve();
    h.feed({
      jsonrpc: "2.0",
      id: 3,
      result: {
        configOptions: GROK_46_CONFIG_OPTIONS.map((option) =>
          option.id === "reasoning_effort" ? { ...option, currentValue: "xhigh" } : option,
        ),
      },
    });
    expect(await changing).toBe(true);
    expect(h.state().effort).toBe("xhigh");

    h.feed({
      jsonrpc: "2.0",
      method: "_x.ai/models/update",
      params: GROK_46_MODEL_STATE,
    });
    expect(h.state().effort).toBe("xhigh");
    expect(h.state().models.find((model) => model.id === "grok-4.6")?.efforts).toContain("xhigh");
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

  test("hides Grok harness reminders while restoring the real goal prompt", async () => {
    const h = harness();
    await h.handshake({ agentCapabilities: { loadSession: true } });

    const resumed = h.adapter.resume?.("goal-session", h.ctx);
    h.update({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "text",
        text: "<user_info>\nOS Version: windows\nWorkspace Path: H:/project\n</user_info>",
      },
    });
    h.update({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "text",
        text: "<system-reminder>\nMCP servers connected:\n- tasks\n</system-reminder>",
      },
    });
    h.update({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "text",
        text: [
          "<user_query>",
          "<system-reminder>",
          "A goal has been set: Build the audio normalizer.",
          "Keep the interface in dark mode.",
          "",
          "You are working directly on this goal across multiple turns. Deliver everything.",
          "Plan: C:/private/session/goal/plan.md",
          "</system-reminder>",
          "</user_query>",
        ].join("\n"),
      },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The app is ready." },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);

    expect(h.state().items.filter((item) => item.kind === "user")).toEqual([
      expect.objectContaining({
        text: "Build the audio normalizer.\nKeep the interface in dark mode.",
      }),
    ]);
    const transcript = JSON.stringify(h.state().items);
    expect(transcript).not.toContain("system-reminder");
    expect(transcript).not.toContain("user_info");
    expect(transcript).not.toContain("C:/private/session");
  });

  test("unwraps ordinary Grok user queries during session replay", async () => {
    const h = harness();
    await h.handshake({ agentCapabilities: { loadSession: true } });

    const resumed = h.adapter.resume?.("ordinary-session", h.ctx);
    h.update({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "<user_query>\nFix the parser\n</user_query>" },
    });
    h.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Fixed." },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(await resumed).toBe(true);

    expect(h.state().items.filter((item) => item.kind === "user")).toEqual([
      expect.objectContaining({ text: "Fix the parser" }),
    ]);
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

  test("preserves Antigravity native filesystem tools and derives per-model efforts", async () => {
    const h = harness({ agent: "antigravity", program: "agy" });
    const calls: string[] = [];
    h.ctx.files = {
      readText: async (path) => {
        calls.push(path);
        return { content: "", binary: false, tooLarge: false };
      },
      writeText: async (path) => {
        calls.push(path);
      },
    };
    await h.handshake(
      {
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
        },
      },
      {
        models: {
          currentModelId: "gemini-4-neon-high",
          availableModels: [
            { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
            { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
            { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
            { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
            { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
            { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
            { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
          ],
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gemini-4-neon",
            options: [
              { value: "gemini-4-neon", name: "Gemini 4 Neon" },
              { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
            ],
          },
          {
            id: "thought_level",
            name: "Thinking Level",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "xhigh", name: "Extra" },
            ],
          },
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "accept-edits", name: "Accept edits" },
              { value: "auto", name: "Auto" },
              { value: "plan", name: "Plan" },
            ],
          },
        ],
      },
    );

    expect(h.sent[0]).toMatchObject({
      params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
    h.feed({ jsonrpc: "2.0", id: 91, method: "fs/read_text_file", params: { path: "package.json" } });
    expect(h.sent.at(-1)).toMatchObject({ id: 91, error: { code: -32601 } });
    expect(calls).toEqual([]);

    const state = h.state();
    expect(state.model).toBe("gemini-4-neon");
    expect(state.effort).toBe("high");
    expect(state.accessMode).toBe("default");
    expect(state.models).toEqual([
      { id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "high"] },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", efforts: [] },
    ]);
  });

  test("applies Antigravity access modes, usage updates, commands, diffs, and subagents", async () => {
    const h = harness({
      agent: "antigravity",
      program: "agy",
      model: "gemini-4-neon-xhigh",
      accessMode: "read-only",
    });
    h.adapter.start(h.ctx);
    await Promise.resolve();
    h.feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await Promise.resolve();
    await Promise.resolve();
    h.feed({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "agy-1",
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "gemini-4-neon",
            options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
          },
          {
            id: "thought_level",
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
              { value: "xhigh", name: "Extra" },
            ],
          },
          {
            id: "mode",
            category: "mode",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
              { value: "accept-edits", name: "Accept edits" },
              { value: "auto", name: "Auto" },
            ],
          },
        ],
      },
    });
    const flush = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    await flush();

    // Launch settings: flattened model+effort splits into model + thought_level + mode.
    expect(h.sent[2]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "agy-1", configId: "model", value: "gemini-4-neon" },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: {} });
    await flush();
    expect(h.sent[3]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "agy-1", configId: "thought_level", value: "xhigh" },
    });
    h.feed({ jsonrpc: "2.0", id: 4, result: {} });
    await flush();
    expect(h.sent[4]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "agy-1", configId: "mode", value: "plan" },
    });
    h.feed({ jsonrpc: "2.0", id: 5, result: {} });
    await flush();
    expect(h.state().status).toBe("idle");
    expect(h.state().accessMode).toBe("read-only");

    // In-session mode switch via configureAccess.
    const switched = h.adapter.configureAccess?.("workspace", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "agy-1", configId: "mode", value: "accept-edits" },
    });
    h.feed({ jsonrpc: "2.0", id: 6, result: {} });
    expect(await switched).toBe(true);
    expect(h.state().accessMode).toBe("workspace");

    const update = (payload: unknown) => h.update(payload, "agy-1");
    // current_mode_update + available_commands_update + usage_update.
    update({ sessionUpdate: "current_mode_update", currentModeId: "auto" });
    update({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "boost", description: "Invoke Boost orchestrator" }],
    });
    update({ sessionUpdate: "usage_update", used: 524288, size: 1048576 });

    // Tool calls: CommandLine, normalized Windows diff path, and invoke_subagent.
    h.adapter.prompt({ text: "check it", images: [] }, h.ctx);
    const promptReqId = (h.sent.at(-1) as { id: number }).id;
    update({
      sessionUpdate: "tool_call",
      toolCallId: "cmd-1",
      name: "run_command",
      kind: "execute",
      title: "bun test",
      status: "completed",
      rawInput: { CommandLine: "bun test" },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      name: "edit_file",
      kind: "edit",
      title: "File /H:/project/demo.ts",
      status: "completed",
      content: [{ type: "diff", path: "/H:/project/demo.ts", oldText: "a", newText: "b" }],
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "sub-1",
      name: "invoke_subagent",
      kind: "other",
      title: "Run invoke_subagent",
      status: "in_progress",
      rawInput: {
        Role: "Codebase Researcher",
        TypeName: "research",
        Prompt: "Inspect adapters",
        Model: "flash",
      },
    });
    h.feed({
      jsonrpc: "2.0",
      id: promptReqId,
      result: { stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 300 } },
    });
    await Promise.resolve();
    await Promise.resolve();

    const state = h.state();
    expect(state.accessMode).toBe("auto");
    expect(state.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: null,
      contextUsed: 0.5,
    });
    expect(state.extensions).toEqual([
      expect.objectContaining({ name: "/boost", kind: "workflow", source: "antigravity" }),
    ]);
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools[0]).toMatchObject({ tool: "execute", command: "bun test" });
    expect(tools[1]).toMatchObject({
      tool: "edit",
      title: "File H:/project/demo.ts",
      changes: [expect.objectContaining({ path: "H:/project/demo.ts" })],
    });
    expect(tools[2]).toMatchObject({
      tool: "task",
      subagent: {
        label: "Codebase Researcher",
        role: "research",
        prompt: "Inspect adapters",
        model: "flash",
      },
    });
  });

  test("tracks Antigravity workers after payload-free launch acknowledgements and parent turn end", async () => {
    const h = harness({ agent: "antigravity", program: "agy" });
    let phase: "running" | "done" = "running";
    const readers: Array<{ sessionId: string; calls: string[] }> = [];
    h.ctx.readAntigravitySubagents = async (sessionId, calls) => {
      readers.push({ sessionId, calls });
      return [
        { callId: "first", threadId: "child-1", status: phase, toolName: "view_file", output: phase === "done" ? "270" : null },
        { callId: "second", threadId: "child-2", status: "done", toolName: null, output: "843" },
      ];
    };
    await h.handshake();
    h.adapter.prompt({ text: "Delegate two checks", images: [] }, h.ctx);
    const request = h.sent.at(-1) as { id: number };

    try {
      for (const callId of ["first", "second"]) {
        h.update({
          sessionUpdate: "tool_call",
          toolCallId: callId,
          name: "invoke_subagent",
          kind: "other",
          title: "Run invoke_subagent",
          status: "in_progress",
          rawInput: { Role: callId, TypeName: "research", Prompt: "Check this" },
        });
        h.update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed" });
      }
      expect(subagentsForTurn(h.state().items).map(({ status }) => status)).toEqual(["running", "running"]);

      h.feed({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readers).toEqual([{ sessionId: "s1", calls: ["first", "second"] }]);
      expect(h.state().status).toBe("idle");
      expect(subagentsForTurn(h.state().items)).toMatchObject([
        { label: "first", status: "running", threadId: "child-1", activity: "Using view file" },
        { label: "second", status: "done", threadId: "child-2", output: "843" },
      ]);

      // A repeated launch acknowledgement cannot overwrite the child's result.
      h.update({ sessionUpdate: "tool_call_update", toolCallId: "second", status: "completed" });
      phase = "done";
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readers.at(-1)?.calls).toEqual(["first"]);
      expect(subagentsForTurn(h.state().items)).toMatchObject([
        { label: "first", status: "done", output: "270" },
        { label: "second", status: "done", output: "843" },
      ]);
    } finally {
      h.adapter.dispose?.(h.ctx);
    }
  });

  test("keeps Antigravity callbacks scoped to the session being replayed", async () => {
    const h = harness({ agent: "antigravity", program: "agy" });
    await h.handshake({ agentCapabilities: { loadSession: true } });
    const resumed = h.adapter.resume?.("stored", h.ctx);
    const request = h.sent.at(-1) as { id: number };
    const invoke = {
      sessionUpdate: "tool_call",
      name: "invoke_subagent",
      kind: "other",
      status: "completed",
    };
    h.update({ ...invoke, toolCallId: "old-live" });
    h.update({ ...invoke, toolCallId: "stored-child" }, "stored");
    h.feed({ jsonrpc: "2.0", id: request.id, result: {} });
    expect(await resumed).toBe(true);

    h.update({ ...invoke, toolCallId: "late-live" });
    expect(subagentsForTurn(h.state().items).map(({ callId }) => callId)).toEqual(["stored-child"]);
  });

  test("does not claim Antigravity child completion when native status is unavailable", () => {
    const h = harness({ agent: "antigravity", program: "agy" });
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "replayed",
      name: "invoke_subagent",
      kind: "other",
      title: "Run invoke_subagent",
      status: "completed",
      rawInput: { Role: "Researcher", Prompt: "Check this" },
    });
    expect(subagentsForTurn(h.state().items)).toMatchObject([
      { label: "Researcher", status: "unknown", output: "" },
    ]);
  });

  test("supports Antigravity Full access with automatic permission approval and reversible switching", async () => {
    const h = harness({
      agent: "antigravity",
      program: "agy",
      accessMode: "full-access",
    });
    const flush = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    const modeConfig = (currentValue: string) => [
      {
        id: "mode",
        category: "mode",
        currentValue,
        options: [
          { value: "default", name: "Default" },
          { value: "plan", name: "Plan" },
          { value: "accept-edits", name: "Accept edits" },
          { value: "auto", name: "Auto" },
        ],
      },
    ];

    h.adapter.start(h.ctx);
    await flush();
    h.feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    await flush();
    h.feed({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "agy-fa", configOptions: modeConfig("default") },
    });
    await flush();

    // Launch full-access applies ACP `auto` mode and stays on `full-access`.
    expect(h.sent[2]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "agy-fa", configId: "mode", value: "auto" },
    });
    h.feed({ jsonrpc: "2.0", id: 3, result: { configOptions: modeConfig("auto") } });
    await flush();
    expect(h.state().accessMode).toBe("full-access");

    // Server echoing `current_mode_update: auto` preserves `full-access`.
    h.update({ sessionUpdate: "current_mode_update", currentModeId: "auto" }, "agy-fa");
    expect(h.state().accessMode).toBe("full-access");

    // Remaining permission prompts are approved automatically without blocking the UI.
    h.feed({
      jsonrpc: "2.0",
      id: "perm-99",
      method: "session/request_permission",
      params: {
        toolCall: { title: "Run destructive command", rawInput: { CommandLine: "rm -rf dist" } },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
    expect(h.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "perm-99",
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    expect(h.state().permission).toBeNull();

    // Switching down to Auto disables full-access auto-approval.
    const toAuto = h.adapter.configureAccess?.("auto", h.ctx);
    const autoReqId = (h.sent.at(-1) as { id: number }).id;
    h.feed({ jsonrpc: "2.0", id: autoReqId, result: { configOptions: modeConfig("auto") } });
    expect(await toAuto).toBe(true);
    expect(h.state().accessMode).toBe("auto");

    h.feed({
      jsonrpc: "2.0",
      id: "perm-100",
      method: "session/request_permission",
      params: {
        toolCall: { title: "Run destructive command", rawInput: { CommandLine: "rm -rf dist" } },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    expect(h.state().permission).toMatchObject({
      id: "perm-perm-100",
      command: "rm -rf dist",
    });

    // Switching back to Full access re-enables auto-approval.
    const toFull = h.adapter.configureAccess?.("full-access", h.ctx);
    const fullReqId = (h.sent.at(-1) as { id: number }).id;
    h.feed({ jsonrpc: "2.0", id: fullReqId, result: { configOptions: modeConfig("auto") } });
    expect(await toFull).toBe(true);
    expect(h.state().accessMode).toBe("full-access");

    // Switching to Plan via server update clears full-access cleanly.
    h.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }, "agy-fa");
    expect(h.state().accessMode).toBe("read-only");
  });

  test("tracks Grok task_backgrounded, task_completed, background_tasks, and KillTask", async () => {
    const h = harness({ agent: "grok", program: "grok" });
    await h.handshake();
    h.adapter.prompt({ text: "Run background delegation", images: [] }, h.ctx);
    const promptReq = h.sent.findLast((msg) => msg.method === "session/prompt") as { id: number };

    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "grok-task-1",
      title: "Task",
      kind: "other",
      status: "in_progress",
      rawInput: {
        description: "Audit API",
        prompt: "Check routes",
        run_in_background: true,
        task_id: "bg-grok-1",
      },
      _meta: { "x.ai/tool": { name: "Task" } },
    });
    h.update({
      sessionUpdate: "task_backgrounded",
      task_id: "bg-grok-1",
      tool_call_id: "grok-task-1",
      description: "Auditing routes",
    });
    h.feed({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.state().items.find((item) => item.kind === "tool" && item.callId === "grok-task-1"))
      .toMatchObject({ tool: "task", status: "running", subagent: { taskId: "bg-grok-1" } });

    h.update({
      sessionUpdate: "task_completed",
      will_wake: false,
      task_snapshot: {
        task_id: "bg-grok-1",
        completed: true,
        exit_code: 0,
        explicitly_killed: false,
        output: "All routes verified",
      },
    });
    expect(h.state().items.find((item) => item.kind === "tool" && item.callId === "grok-task-1"))
      .toMatchObject({
        tool: "task",
        status: "done",
        output: "All routes verified",
      });
  });

  test("retracks an Antigravity subagent when send_message revives it and settles orphaned sync ACP tasks on turn end", async () => {
    const readers: Array<{ sessionId: string; calls: string[] }> = [];
    let phase = 0;
    const h = harness({ agent: "antigravity", program: "agy" });
    h.ctx.readAntigravitySubagents = async (sessionId, calls) => {
      readers.push({ sessionId, calls });
      if (phase === 0) {
        return [{ callId: "agy-child-1", threadId: "child-thread-1", status: "done", toolName: null, output: "First pass" }];
      }
      return [{ callId: "agy-child-1", threadId: "child-thread-1", status: "done", toolName: null, output: "Second pass" }];
    };
    try {
      await h.handshake();
      h.update({
        sessionUpdate: "tool_call",
        toolCallId: "agy-child-1",
        title: "Run invoke_subagent",
        kind: "other",
        status: "completed",
        rawInput: { TypeName: "research", Role: "Investigator", Prompt: "Check logs" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(subagentsForTurn(h.state().items)).toMatchObject([
        { callId: "agy-child-1", threadId: "child-thread-1", status: "done", output: "First pass" },
      ]);

      phase = 1;
      h.update({
        sessionUpdate: "tool_call",
        toolCallId: "msg-1",
        name: "send_message",
        kind: "other",
        status: "completed",
        rawInput: { Recipient: "child-thread-1", Message: "Look deeper" },
      });
      expect(subagentsForTurn(h.state().items)).toMatchObject([
        { callId: "agy-child-1", status: "running" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(subagentsForTurn(h.state().items)).toMatchObject([
        { callId: "agy-child-1", status: "done", output: "Second pass" },
      ]);
      expect(readers.length).toBeGreaterThanOrEqual(2);
    } finally {
      h.adapter.dispose?.(h.ctx);
    }

    // Synchronous OpenCode task that misses its final update settles when turn ends.
    const oc = harness({ agent: "opencode", program: "opencode" });
    await oc.handshake();
    oc.adapter.prompt({ text: "Analyze", images: [] }, oc.ctx);
    const req = oc.sent.findLast((msg) => msg.method === "session/prompt") as { id: number };
    oc.update({
      sessionUpdate: "tool_call",
      toolCallId: "oc-task-1",
      name: "task",
      kind: "other",
      status: "in_progress",
      rawInput: { description: "Explore files", prompt: "List modules", subagent_type: "explore" },
    });
    expect(oc.state().items.find((item) => item.kind === "tool")).toMatchObject({
      tool: "task",
      status: "running",
    });
    oc.feed({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(oc.state().items.find((item) => item.kind === "tool")).toMatchObject({
      tool: "task",
      status: "done",
    });
  });
});
