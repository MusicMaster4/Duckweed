import { describe, expect, test } from "bun:test";
import { mobileConversationTimeline, type MobileOutgoingMessage } from "./mobileConversation";
import type { AgentItem } from "./agents/types";

const send = (id: string, at: number, text = id): MobileOutgoingMessage => ({ id, at, text, state: "sent" });
const answer = (id: string, at: number, streaming = false): AgentItem => ({ kind: "assistant", id, at, text: id, streaming });
const ids = (items: AgentItem[]) => items.map(item => item.id);

describe("mobile conversation order", () => {
  test("keeps local sends before responses received ahead of desktop confirmation", () => {
    const items: AgentItem[] = [answer("previous", 100), answer("reply", 300, true)];
    const outgoing = [send("prompt", 200)];
    const result = mobileConversationTimeline(items, outgoing);
    expect(ids(result.visibleItems)).toEqual(["previous", "prompt", "reply"]);
    expect(result.outgoing).toEqual(outgoing);
    expect(ids(items)).toEqual(["previous", "reply"]);
  });

  test("interleaves multiple sends with streaming and completed responses", () => {
    const outgoing = [send("first", 200), send("second", 400)];
    for (const streaming of [true, false]) {
      const result = mobileConversationTimeline([answer("reply-1", 300), answer("reply-2", 500, streaming)], outgoing);
      expect(ids(result.visibleItems)).toEqual(["first", "reply-1", "second", "reply-2"]);
    }
  });

  test("replaces a local send with its desktop echo without moving it below the answer", () => {
    const outgoing = [send("local", 20_000, "Hello")];
    const items: AgentItem[] = [
      { kind: "user", id: "desktop", at: 20_100, text: "Hello" },
      answer("reply", 20_200),
    ];
    const result = mobileConversationTimeline(items, outgoing);
    expect(ids(result.visibleItems)).toEqual(["desktop", "reply"]);
    expect(result.outgoing).toEqual([]);
  });

  test("places a prompt before a reply with the same timestamp and retains activity order", () => {
    const items: AgentItem[] = [
      { kind: "thinking", id: "thinking", at: 200, text: "Checking", streaming: false },
      answer("reply", 200),
    ];
    expect(ids(mobileConversationTimeline(items, [send("prompt", 200)]).visibleItems))
      .toEqual(["prompt", "thinking", "reply"]);
  });

  test("keeps failed sends in chronological position for retry", () => {
    const message = { ...send("failed", 100), state: "failed" };
    const result = mobileConversationTimeline([answer("reply", 200)], [message]);
    expect(ids(result.visibleItems)).toEqual(["failed", "reply"]);
    expect(result.outgoing[0].state).toBe("failed");
  });
});
