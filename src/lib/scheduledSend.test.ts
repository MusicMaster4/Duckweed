import { describe, expect, test } from "bun:test";
import { deliverDueSends, deliverDueMessageQueues } from "./scheduledSend";

describe("recovered timed messages", () => {
  test("sends an overdue message after restart and keeps future messages", () => {
    const sent: string[] = [];
    const pending = new Map([["overdue", { at: 1000 }], ["future", { at: 10000 }]]);
    const remaining = deliverDueSends(pending, 5000, (id) => { sent.push(id); return true; });
    expect(sent).toEqual(["overdue"]);
    expect([...remaining.keys()]).toEqual(["future"]);
    deliverDueSends(remaining, 5000, (id) => { sent.push(id); return true; });
    expect(sent).toEqual(["overdue"]);
  });

  test("keeps overdue drafts while an agent is starting, loading history, or failed", () => {
    const pending = new Map([["agent", { at: 1000 }]]);
    for (const now of [1000, 5000, 10000]) {
      expect(deliverDueSends(pending, now, () => false)).toEqual(pending);
    }
    expect(deliverDueSends(pending, 20000, () => true).size).toBe(0);
  });
});

describe("independent scheduled messages", () => {
  test("delivers multiple messages in time order without consuming future messages", () => {
    const sent: string[] = [];
    const queues = new Map([["pane", [
      { id: "later", at: 9000, text: "Later" },
      { id: "second", at: 2000, text: "Second" },
      { id: "first", at: 1000, text: "First" },
    ]]]);
    const remaining = deliverDueMessageQueues(queues, 5000, (_, send) => {
      sent.push(send.text!);
      return true;
    });
    expect(sent).toEqual(["First", "Second"]);
    expect(remaining.get("pane")?.map(send => send.id)).toEqual(["later"]);
    expect(queues.get("pane")).toHaveLength(3);
  });

  test("retains a failed message and later messages while other terminals can send", () => {
    const queues = new Map([
      ["blocked", [{ at: 1000, text: "First" }, { at: 2000, text: "Second" }]],
      ["ready", [{ at: 1000, text: "Other terminal" }]],
    ]);
    const attempts: string[] = [];
    const remaining = deliverDueMessageQueues(queues, 5000, (id, send) => {
      attempts.push(send.text!);
      return id !== "blocked";
    });
    expect(attempts).toEqual(["First", "Other terminal"]);
    expect(remaining.get("blocked")).toHaveLength(2);
    expect(remaining.has("ready")).toBe(false);
    expect(deliverDueMessageQueues(remaining, 5000, () => true).size).toBe(0);
  });
});
