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
  args: [],
  prompt: null,
  model: null,
  effort: null,
  resume: false,
  resumeId: null,
};

function harness() {
  const events: AgentEvent[] = [];
  const sent: unknown[] = [];
  const adapter = createClaudeAdapter();
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch,
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

    h.adapter.prompt("analyze this folder", h.ctx);
    h.feed(assistantError);
    h.feed(assistantError);
    h.feed({ type: "result", subtype: "success", is_error: true, result: text });

    let notices = h.state().items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ tone: "error", text });

    h.adapter.prompt("try again", h.ctx);
    h.feed(assistantError);
    notices = h.state().items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(2);
  });

  test("sends a prompt as a stream-json user message", () => {
    const h = harness();
    h.adapter.prompt("fix the bug", h.ctx);
    expect(h.sent[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    });
    expect(h.state().items[0]).toMatchObject({ kind: "user", text: "fix the bug" });
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
    h.adapter.prompt("/effort high", h.ctx);
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
      text: 'Unknown effort "ludicrous" — pick low, medium, high, xhigh, max, auto, or ultracode.',
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
