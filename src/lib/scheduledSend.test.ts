import { describe, expect, test } from "bun:test";
import { deliverDueSends } from "./scheduledSend";

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
