import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import { applyEvent, type AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { emptyUsage, type AgentSessionState } from "../types";
import { createClaudeAdapter } from "./claude";

const launch: AgentLaunch = {
  agent: "claude",
  program: "claude",
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
  const sent: unknown[] = [];
  const adapter = createClaudeAdapter();
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch: { ...launch, ...overrides },
    send: (message) => sent.push(message),
    emit: (event) => events.push(event),
  };
  const feed = (frame: unknown) => adapter.receive(JSON.stringify(frame), ctx);
  const state = () =>
    events.reduce<AgentSessionState>(applyEvent, {
      termId: "t1",
      agent: "claude",
      program: "claude",
      label: "Claude Code",
      mark: "CC",
      accent: "#d97757",
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
  return { adapter, ctx, events, sent, feed, state };
}

/** The delta pair that opens and fills one streamed content block. */
function streamBlock(index: number, block: unknown, deltas: unknown[]) {
  return [
    { type: "stream_event", event: { type: "content_block_start", index, content_block: block } },
    ...deltas.map((delta) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index, delta },
    })),
    { type: "stream_event", event: { type: "content_block_stop", index } },
  ];
}

describe("claude adapter", () => {
  test("reads identity out of the init frame", () => {
    const h = harness();
    h.feed({
      type: "system",
      subtype: "init",
      session_id: "abc",
      model: "claude-opus-5",
      cwd: "H:/project",
      slash_commands: ["review", "compact"],
    });
    const state = h.state();
    expect(state.sessionId).toBe("abc");
    expect(state.model).toBe("claude-opus-5");
    expect(state.commands.map((c) => c.name)).toEqual(["/review", "/compact"]);
  });

  test("streams thinking and prose into separate timeline items", () => {
    const h = harness();
    h.feed({ type: "stream_event", event: { type: "message_start" } });
    for (const frame of streamBlock(0, { type: "thinking" }, [
      { type: "thinking_delta", thinking: "The user wants" },
      { type: "thinking_delta", thinking: " a one-word greeting." },
    ])) {
      h.feed(frame);
    }
    for (const frame of streamBlock(1, { type: "text" }, [
      { type: "text_delta", text: "Hey!" },
    ])) {
      h.feed(frame);
    }

    const items = h.state().items;
    expect(items.map((item) => item.kind)).toEqual(["thinking", "assistant"]);
    expect(items[0]).toMatchObject({
      text: "The user wants a one-word greeting.",
      streaming: false,
    });
    expect(items[1]).toMatchObject({ text: "Hey!", streaming: false });
  });

  test("uses the settled assistant message to catch up a lagging text stream", () => {
    const h = harness();
    h.feed({ type: "stream_event", event: { type: "message_start" } });
    h.feed({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
    });
    h.feed({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The partial answer" },
      },
    });

    h.feed({
      type: "assistant",
      message: {
        id: "message-1",
        content: [
          {
            type: "text",
            text: "The partial answer is replaced immediately by the complete response.",
          },
        ],
      },
    });

    expect(h.state().items).toEqual([
      expect.objectContaining({
        kind: "assistant",
        id: "m1-b0",
        text: "The partial answer is replaced immediately by the complete response.",
        streaming: false,
      }),
    ]);
  });

  test("does not duplicate text when the settled message omits streamed thinking", () => {
    const h = harness();
    h.feed({ type: "stream_event", event: { type: "message_start" } });
    for (const frame of streamBlock(0, { type: "thinking" }, [
      { type: "thinking_delta", thinking: "Checking the implementation." },
    ])) {
      h.feed(frame);
    }
    for (const frame of streamBlock(1, { type: "text" }, [
      { type: "text_delta", text: "The partial answer." },
    ])) {
      h.feed(frame);
    }

    h.feed({
      type: "assistant",
      message: {
        id: "message-with-hidden-thinking",
        content: [{ type: "text", text: "The complete answer." }],
      },
    });

    const answers = h.state().items.filter((item) => item.kind === "assistant");
    expect(answers).toEqual([
      expect.objectContaining({
        id: "m1-b1",
        text: "The complete answer.",
        streaming: false,
      }),
    ]);
  });

  test("keeps interim comments single across tool rounds", () => {
    const h = harness();
    const comments = [
      "I will inspect the end of the array.",
      "I will validate the new entries.",
      "Three entries overlap. I will replace them.",
    ];

    for (const [round, comment] of comments.entries()) {
      h.feed({ type: "stream_event", event: { type: "message_start" } });
      for (const frame of streamBlock(0, { type: "thinking" }, [
        { type: "thinking_delta", thinking: `Planning round ${round + 1}.` },
      ])) {
        h.feed(frame);
      }
      for (const frame of streamBlock(1, { type: "text" }, [
        { type: "text_delta", text: comment },
      ])) {
        h.feed(frame);
      }
      h.feed({
        type: "assistant",
        message: {
          id: `message-${round + 1}`,
          content: [{ type: "text", text: comment }],
        },
      });
      for (const frame of streamBlock(
        2,
        { type: "tool_use", id: `tool-${round + 1}`, name: "Bash" },
        [{ type: "input_json_delta", partial_json: '{"command":"echo ok"}' }],
      )) {
        h.feed(frame);
      }
    }

    const answers = h.state().items.filter((item) => item.kind === "assistant");
    expect(answers.map((item) => item.text)).toEqual(comments);
  });

  test("shows settled assistant text even when no text delta was received", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        id: "message-2",
        content: [{ type: "text", text: "Already complete." }],
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "assistant",
      id: "message-2-b0",
      text: "Already complete.",
      streaming: false,
    });
  });

  test("names a tool call from its streamed input before the result lands", () => {
    const h = harness();
    h.feed({ type: "stream_event", event: { type: "message_start" } });
    for (const frame of streamBlock(0, { type: "tool_use", id: "toolu_1", name: "Bash" }, [
      { type: "input_json_delta", partial_json: '{"command":"bun ' },
      { type: "input_json_delta", partial_json: 'test"}' },
    ])) {
      h.feed(frame);
    }

    const tool = h.state().items[0];
    expect(tool).toMatchObject({
      kind: "tool",
      callId: "toolu_1",
      tool: "execute",
      title: "Bash · bun test",
      command: "bun test",
      status: "running",
    });
  });

  test("lifts Agent identity and prompt into structured subagent metadata", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Agent",
            input: {
              description: "Inspect parser tests",
              subagent_type: "Explore",
              prompt: "Find the fixture that breaks the parser",
              model: "haiku",
            },
          },
        ],
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      tool: "task",
      title: "Inspect parser tests",
      subagent: {
        label: "Inspect parser tests",
        role: "Explore",
        prompt: "Find the fixture that breaks the parser",
        model: "haiku",
      },
    });
  });

  test("attributes complete child messages and tools through parent_tool_use_id", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "parent-task",
            name: "Agent",
            input: {
              description: "Inspect parser tests",
              prompt: "Find the failing parser fixture",
            },
          },
        ],
      },
    });
    h.feed({
      type: "assistant",
      parent_tool_use_id: "parent-task",
      message: {
        id: "child-message",
        content: [
          { type: "text", text: "I am checking the parser fixtures." },
          {
            type: "tool_use",
            id: "child-read",
            name: "Read",
            input: { file_path: "tests/parser.test.ts" },
          },
        ],
      },
    });
    h.feed({
      type: "user",
      parent_tool_use_id: "parent-task",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "child-read",
            content: "Found the legacy fixture",
            is_error: false,
          },
        ],
      },
    });

    expect(h.state().items).toHaveLength(1);
    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      callId: "parent-task",
      tool: "task",
      subagent: {
        activity: "Found the legacy fixture",
        items: [
          {
            kind: "assistant",
            text: "I am checking the parser fixtures.",
            streaming: false,
          },
          {
            kind: "tool",
            callId: "child-read",
            tool: "read",
            title: "Read · tests/parser.test.ts",
            status: "done",
            output: "Found the legacy fixture",
          },
        ],
      },
    });
  });

  test("keeps child-created tasks in the subagent workflow", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "parent-task",
            name: "Agent",
            input: { description: "Inspect parser tests" },
          },
        ],
      },
    });
    h.feed({
      type: "assistant",
      parent_tool_use_id: "parent-task",
      message: {
        content: [
          {
            type: "tool_use",
            id: "child-task-create",
            name: "TaskCreate",
            input: { subject: "Find the failing fixture" },
          },
        ],
      },
    });
    h.feed({
      type: "user",
      parent_tool_use_id: "parent-task",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "child-task-create",
            content: "Task #3 created successfully: Find the failing fixture",
          },
        ],
      },
    });

    expect(h.state().items[0]).toMatchObject({
      kind: "tool",
      callId: "parent-task",
      subagent: {
        items: [
          {
            kind: "plan",
            steps: [
              { text: "Find the failing fixture", status: "pending" },
            ],
          },
          {
            kind: "tool",
            callId: "child-task-create",
            tool: "todo",
            status: "done",
          },
        ],
      },
    });
  });

  test("turns an Edit tool into a file change with counted lines", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Edit",
            input: {
              file_path: "src/app.ts",
              old_string: "const a = 1;",
              new_string: "const a = 1;\nconst b = 2;",
            },
          },
        ],
      },
    });

    const tool = h.state().items[0];
    expect(tool).toMatchObject({ kind: "tool", tool: "edit" });
    expect(tool.kind === "tool" && tool.changes[0]).toMatchObject({
      path: "src/app.ts",
      insertions: 1,
      deletions: 0,
    });
  });

  test("lifts TodoWrite out of the tool list into the plan row", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Write the adapter", status: "completed" },
                { content: "Wire the UI", status: "in_progress" },
                { content: "Ship it", status: "pending" },
              ],
            },
          },
        ],
      },
    });

    const plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Write the adapter", status: "done" },
      { text: "Wire the UI", status: "running" },
      { text: "Ship it", status: "pending" },
    ]);
  });

  test("shows TaskCreate and TaskUpdate as one live Claudex workflow", () => {
    const h = harness({ program: "claudex" });
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "create-1",
            name: "TaskCreate",
            input: {
              subject: "Find matrix loading animation code",
              description: "Locate the animation implementation",
              activeForm: "Finding matrix animation code",
            },
          },
        ],
      },
    });

    let plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Find matrix loading animation code", status: "pending" },
    ]);

    h.feed({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "create-1",
            content:
              "Task #1 created successfully: Find matrix loading animation code",
          },
        ],
      },
    });
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "update-1",
            name: "TaskUpdate",
            input: { taskId: "1", status: "in_progress" },
          },
        ],
      },
    });

    plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Find matrix loading animation code", status: "running" },
    ]);
    expect(
      h.state().items.find(
        (item) => item.kind === "tool" && item.callId === "create-1",
      ),
    ).toMatchObject({
      tool: "todo",
      title: "Create task: Find matrix loading animation code",
      status: "done",
    });
  });

  test("rebuilds the workflow from a TaskList result", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "list-1", name: "TaskList", input: {} },
        ],
      },
    });
    h.feed({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "list-1",
            content:
              "#2 [completed] Build Uvicorn job API\n" +
              "#5 [in_progress] Add tests and verify\n" +
              "#11 [pending] Verify correctness findings",
          },
        ],
      },
    });

    const plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Build Uvicorn job API", status: "done" },
      { text: "Add tests and verify", status: "running" },
      { text: "Verify correctness findings", status: "pending" },
    ]);
  });

  test("restores a task when TaskUpdate fails", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "create-1",
            name: "TaskCreate",
            input: { subject: "Inspect parser" },
          },
        ],
      },
    });
    h.feed({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "create-1",
            content: "Task #7 created successfully: Inspect parser",
          },
        ],
      },
    });
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "delete-7",
            name: "TaskUpdate",
            input: { taskId: "7", status: "deleted" },
          },
        ],
      },
    });
    h.feed({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "delete-7",
            content: "Task could not be deleted",
            is_error: true,
          },
        ],
      },
    });

    const plan = h.state().items.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" && plan.steps).toEqual([
      { text: "Inspect parser", status: "pending" },
    ]);
  });

  test("closes a tool call when its result comes back", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_4", name: "Bash", input: { command: "ls" } }],
      },
    });
    h.feed({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_4", content: "a.txt\nb.txt", is_error: false },
        ],
      },
    });

    expect(h.state().items[0]).toMatchObject({ status: "done", output: "a.txt\nb.txt" });
  });

  test("marks a failed tool result as an error", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_5", name: "Bash", input: { command: "nope" } }],
      },
    });
    h.feed({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_5", content: "not found", is_error: true },
        ],
      },
    });

    expect(h.state().items[0]).toMatchObject({ status: "error" });
  });

  test("raises a permission prompt and answers it on the control channel", () => {
    const h = harness();
    h.feed({
      type: "control_request",
      request_id: "req_9",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf build" },
      },
    });

    const waiting = h.state();
    expect(waiting.status).toBe("waiting");
    expect(waiting.permission).toMatchObject({ command: "rm -rf build" });

    h.adapter.respond(waiting.permission!.id, "deny", h.ctx);
    expect(h.sent.at(-1)).toMatchObject({
      type: "control_response",
      response: { request_id: "req_9", response: { behavior: "deny" } },
    });
    expect(h.state().permission).toBeNull();
  });

  test("turns AskUserQuestion into an answerable question rather than an approval", () => {
    const h = harness();
    h.feed({
      type: "control_request",
      request_id: "req_q",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which date library should we use?",
              header: "Library",
              multiSelect: false,
              options: [
                { label: "date-fns", description: "Small and tree-shakeable" },
                { label: "Luxon", description: "Rich timezone support", preview: "DateTime.now()" },
              ],
            },
          ],
        },
      },
    });

    const waiting = h.state();
    expect(waiting.status).toBe("waiting");
    expect(waiting.permission).toMatchObject({
      kind: "question",
      title: "Which date library should we use?",
    });
    expect(waiting.permission?.questions?.[0]).toMatchObject({
      header: "Library",
      multiSelect: false,
    });
    expect(waiting.permission?.questions?.[0].options).toEqual([
      { id: "o0", label: "date-fns", description: "Small and tree-shakeable", preview: null },
      {
        id: "o1",
        label: "Luxon",
        description: "Rich timezone support",
        preview: "DateTime.now()",
      },
    ]);

    h.adapter.answer?.(
      waiting.permission!.id,
      [{ questionId: "q0", labels: ["date-fns"], custom: null }],
      h.ctx,
    );
    expect(h.sent.at(-1)).toMatchObject({
      type: "control_response",
      response: {
        request_id: "req_q",
        response: {
          behavior: "allow",
          updatedInput: { answers: { "Which date library should we use?": "date-fns" } },
        },
      },
    });
    expect(h.state().permission).toBeNull();
  });

  test("joins multi-select answers and carries typed text alongside a choice", () => {
    const h = harness();
    h.feed({
      type: "control_request",
      request_id: "req_multi",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which features should ship?",
              header: "Scope",
              multiSelect: true,
              options: [
                { label: "Search", description: "" },
                { label: "Export", description: "" },
              ],
            },
            {
              question: "Which database?",
              header: "Storage",
              multiSelect: false,
              options: [
                { label: "Postgres", description: "" },
                { label: "SQLite", description: "" },
              ],
            },
          ],
        },
      },
    });

    const waiting = h.state();
    expect(waiting.permission?.title).toBe("2 questions for you");

    h.adapter.answer?.(
      waiting.permission!.id,
      [
        { questionId: "q0", labels: ["Search", "Export"], custom: "Search matters most" },
        // Nothing picked: the typed text is the answer itself.
        { questionId: "q1", labels: [], custom: "Neither, use the existing store" },
      ],
      h.ctx,
    );

    expect(h.sent.at(-1)).toMatchObject({
      response: {
        response: {
          updatedInput: {
            answers: {
              "Which features should ship?": "Search, Export",
              "Which database?": "Neither, use the existing store",
            },
            annotations: {
              "Which features should ship?": { notes: "Search matters most" },
            },
          },
        },
      },
    });
  });

  test("tells Claude a skipped question was skipped, not that the tool was refused", () => {
    const h = harness();
    h.feed({
      type: "control_request",
      request_id: "req_skip",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Ship it?",
              header: "Ship",
              multiSelect: false,
              options: [
                { label: "Yes", description: "" },
                { label: "No", description: "" },
              ],
            },
          ],
        },
      },
    });

    h.adapter.respond(h.state().permission!.id, "deny", h.ctx);
    const sent = h.sent.at(-1) as {
      response: { response: { behavior: string; message: string } };
    };
    expect(sent.response.response.behavior).toBe("deny");
    expect(sent.response.response.message).toContain("skipped the question");
  });

  test("falls back to an approval when AskUserQuestion carries no usable questions", () => {
    const h = harness();
    h.feed({
      type: "control_request",
      request_id: "req_empty",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [] },
      },
    });
    expect(h.state().permission).toMatchObject({ kind: "approval" });
  });

  test("names the AskUserQuestion tool call after the question it asks", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_q",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Which approach?", options: [] }] },
          },
        ],
      },
    });
    expect(h.state().items[0]).toMatchObject({ title: "Which approach?" });
  });

  test("answers a control request it does not implement instead of stalling", () => {
    const h = harness();
    h.feed({ type: "control_request", request_id: "req_x", request: { subtype: "mcp_message" } });
    expect(h.sent.at(-1)).toMatchObject({
      type: "control_response",
      response: { subtype: "error", request_id: "req_x" },
    });
  });

  test("ends the turn with usage and cost from the result frame", () => {
    const h = harness();
    h.feed({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.019,
      usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 86 },
    });

    const state = h.state();
    expect(state.usage).toMatchObject({ inputTokens: 100, outputTokens: 86, costUsd: 0.019 });
    expect(state.status).toBe("idle");
  });

  test("reports a failed turn as an error notice", () => {
    const h = harness();
    h.feed({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
    const notice = h.state().items.find((item) => item.kind === "notice");
    expect(notice).toMatchObject({ tone: "error", text: "boom" });
  });

  test("shows a repeated API failure once per submitted turn", () => {
    const h = harness();
    const text = "You've hit your session limit · resets 11:20pm (America/Fortaleza)";
    const assistantError = {
      type: "assistant",
      error: "rate_limit",
      is_api_error_message: true,
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };

    h.adapter.prompt({ text: "analyze this folder", images: [] }, h.ctx);
    h.feed(assistantError);
    h.feed(assistantError);
    h.feed({ type: "result", subtype: "success", is_error: true, result: text });

    let notices = h.state().items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ tone: "error", text });

    h.adapter.prompt({ text: "try again", images: [] }, h.ctx);
    h.feed(assistantError);
    notices = h.state().items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(2);
  });

  test("sends a prompt as a stream-json user message", () => {
    const h = harness();
    h.adapter.prompt({ text: "fix the bug", images: [] }, h.ctx);
    expect(h.sent[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", text: "fix the bug" });
  });

  test("sends the original image instead of its thumbnail to Claude", () => {
    const h = harness();
    h.adapter.prompt({ text: "Describe this", images: [image] }, h.ctx);
    expect(h.sent[0]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
          },
          { type: "text", text: "Describe this" },
        ],
      },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", images: [image] });
  });

  test("steers the active turn through the open stream-json input", async () => {
    const h = harness();
    const accepted = await h.adapter.steer?.(
      { text: "Focus on the failing test instead", images: [image] },
      h.ctx,
    );

    expect(accepted).toBe(true);
    expect(h.sent[0]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
          },
          { type: "text", text: "Focus on the failing test instead" },
        ],
      },
    });
    expect(h.state().items[0]).toMatchObject({
      kind: "user",
      text: "Focus on the failing test instead",
      images: [image],
    });
  });

  test("interrupts over the control channel", () => {
    const h = harness();
    h.adapter.interrupt(h.ctx);
    expect(h.sent[0]).toMatchObject({ request: { subtype: "interrupt" } });
  });

  test("ignores log lines the CLI interleaves with the protocol", () => {
    const h = harness();
    h.adapter.receive("Loading plugins…", h.ctx);
    h.adapter.receive("{ not json", h.ctx);
    expect(h.events).toHaveLength(0);
  });

  test("passes the requested model and continue flag through as arguments", () => {
    const adapter = createClaudeAdapter();
    expect(adapter.args({ ...launch, model: "opus", resume: true })).toEqual([
      "--model",
      "opus",
      "--continue",
    ]);
    expect(adapter.args(launch)).toEqual([]);
  });

  test("resumes a named session with --resume, not --continue", () => {
    const adapter = createClaudeAdapter();
    expect(adapter.args({ ...launch, resumeId: "abc123" })).toEqual(["--resume", "abc123"]);
    // A picked session wins over "the most recent one".
    expect(adapter.args({ ...launch, resume: true, resumeId: "abc123" })).toEqual([
      "--resume",
      "abc123",
    ]);
  });

  test("has no in-protocol resume, so the session store relaunches the CLI", () => {
    expect(createClaudeAdapter().resume).toBeUndefined();
  });

  test("passes a requested effort through as an argument", () => {
    const adapter = createClaudeAdapter();
    expect(adapter.args({ ...launch, effort: "high" })).toEqual(["--effort", "high"]);
  });

  test("routes /model through the set_model control request", () => {
    const h = harness();
    expect(h.adapter.command?.("/model opus", h.ctx)).toBe("handled");
    expect(h.sent[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "set_model", model: "opus" },
    });
    // The user's command still echoes into the transcript.
    expect(h.state().items[0]).toMatchObject({ kind: "user", text: "/model opus" });

    const requestId = (h.sent[0] as { request_id: string }).request_id;
    h.feed({ type: "control_response", response: { subtype: "success", request_id: requestId } });
    const state = h.state();
    expect(state.model).toBe("opus");
    expect(state.items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "info",
      text: "Model set to opus.",
    });
  });

  test("changes permission mode through Claude's control protocol", () => {
    const h = harness();
    expect(h.adapter.configureAccess?.("full-access", h.ctx)).toBe(true);
    expect(h.sent[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
    });

    const requestId = (h.sent[0] as { request_id: string }).request_id;
    h.feed({
      type: "control_response",
      response: { subtype: "success", request_id: requestId },
    });
    expect(h.state().accessMode).toBe("full-access");
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "info",
      text: "Access set to Full access.",
    });
  });

  test("applies remembered access when the session starts", () => {
    const h = harness({ accessMode: "read-only" });
    h.adapter.start(h.ctx);

    expect(h.sent[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "set_permission_mode", mode: "plan" },
    });
    const requestId = (h.sent[0] as { request_id: string }).request_id;
    h.feed({
      type: "control_response",
      response: { subtype: "success", request_id: requestId },
    });
    expect(h.state().accessMode).toBe("read-only");
    expect(h.state().items.some((item) => item.kind === "notice")).toBe(false);
  });

  test("maps the other shared access levels onto Claude modes", () => {
    const h = harness();
    h.adapter.configureAccess?.("read-only", h.ctx);
    h.adapter.configureAccess?.("workspace", h.ctx);
    h.adapter.configureAccess?.("default", h.ctx);

    expect(h.sent).toMatchObject([
      { request: { subtype: "set_permission_mode", mode: "plan" } },
      { request: { subtype: "set_permission_mode", mode: "acceptEdits" } },
      { request: { subtype: "set_permission_mode", mode: "default" } },
    ]);
  });

  test("surfaces a refused model change instead of updating the header", () => {
    const h = harness();
    h.adapter.command?.("/model not-a-model", h.ctx);
    const requestId = (h.sent[0] as { request_id: string }).request_id;
    h.feed({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: "invalid_set_model_request" },
    });
    const state = h.state();
    expect(state.model).toBeNull();
    expect(state.items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: "invalid_set_model_request",
    });
  });

  test("lets a valid /effort through to the CLI and moves the header now", () => {
    const h = harness();
    expect(h.adapter.command?.("/effort high", h.ctx)).toBe("prompt");
    expect(h.state().effort).toBe("high");
    // The session then sends it as a normal user message, which the CLI
    // intercepts and confirms with a synthetic message of its own.
    h.adapter.prompt({ text: "/effort high", images: [] }, h.ctx);
    expect(h.sent[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "/effort high" }] },
    });
  });

  test("rejects an invalid effort locally instead of wasting a turn", () => {
    const h = harness();
    expect(h.adapter.command?.("/effort ludicrous", h.ctx)).toBe("handled");
    expect(h.sent).toHaveLength(0);
    expect(h.state().items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "error",
      text: 'Unknown effort "ludicrous". Pick low, medium, high, xhigh, max, auto, or ultracode.',
    });
  });

  test("renders the synthetic message that answers a slash command", () => {
    const h = harness();
    h.feed({
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "Set effort level to high (this session only)" }],
      },
    });
    expect(h.state().items[0]).toMatchObject({
      kind: "notice",
      tone: "info",
      text: "Effort set to high.",
    });
  });
});
