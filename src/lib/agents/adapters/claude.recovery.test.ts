import { describe, expect, test } from "bun:test";
import type { AdapterContext } from "../adapter";
import type { AgentEvent } from "../events";
import { createClaudeAdapter } from "./claude";

function harness() {
  const adapter = createClaudeAdapter();
  const events: AgentEvent[] = [];
  const sent: unknown[] = [];
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch: { agent: "claude", program: "claudex", env: {}, args: [], wrapperArgs: [], forwardArgs: [],
      prompt: null, model: null, effort: null, resume: false, resumeId: null },
    send: (message) => { sent.push(message); },
    emit: (event) => { events.push(event); },
  };
  const feed = (frame: unknown) => adapter.receive(JSON.stringify(frame), ctx);
  const stream = (event: unknown) => feed({ type: "stream_event", event });
  return { adapter, ctx, events, sent, feed, stream };
}

describe("Claude renderer recovery", () => {
  test("restores incomplete tool JSON from an independent serializable checkpoint", () => {
    const old = harness();
    old.stream({ type: "message_start" });
    old.stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "shell", name: "Bash" } });
    old.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"echo ' } });
    const checkpoint = old.adapter.checkpoint?.();
    const serialized = JSON.stringify(checkpoint);
    old.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "stale" } });
    expect(JSON.stringify(checkpoint)).toBe(serialized);

    const restored = harness();
    expect(restored.adapter.restore?.(JSON.parse(serialized))).toBe(true);
    restored.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'recovered"}' } });
    restored.stream({ type: "content_block_stop", index: 0 });
    expect(restored.events).toContainEqual(expect.objectContaining({ type: "tool", callId: "shell", command: "echo recovered" }));
    expect(restored.sent).toEqual([]);
    // Completed input no longer occupies the recovery snapshot.
    expect(JSON.stringify(restored.adapter.checkpoint?.())).not.toContain("echo recovered");
  });

  test("keeps background agents running after a restored foreground result", () => {
    const old = harness();
    old.feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "child", name: "Agent", input: { description: "Background task" } }] } });
    old.feed({ type: "user", toolUseResult: { status: "async_launched", agentId: "native-child" },
      message: { content: [{ type: "tool_result", tool_use_id: "child", content: "Async agent launched successfully. Agent ID: native-child" }] } });
    const restored = harness();
    expect(restored.adapter.restore?.(JSON.parse(JSON.stringify(old.adapter.checkpoint?.())))).toBe(true);
    restored.feed({ type: "result", is_error: false });
    expect(restored.events.some((event) => event.type === "turn-end")).toBe(false);
    expect(restored.sent).toEqual([]);
    restored.feed({ type: "system", subtype: "task_notification", task_id: "native-child", status: "completed", summary: "Finished" });
    expect(restored.events).toContainEqual(expect.objectContaining({ type: "tool", callId: "child", status: "done" }));
  });
});
