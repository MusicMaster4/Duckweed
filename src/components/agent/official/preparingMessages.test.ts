import { describe, expect, test } from "bun:test";

import {
  PREPARING_MESSAGES,
  nextPreparingMessage,
  preparingMessageFor,
} from "./preparingMessages";

describe("preparingMessages", () => {
  test("the pool has one hundred short lines", () => {
    expect(PREPARING_MESSAGES).toHaveLength(100);
    for (const line of PREPARING_MESSAGES) {
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(24);
    }
    expect(new Set(PREPARING_MESSAGES).size).toBe(PREPARING_MESSAGES.length);
  });

  test("nextPreparingMessage draws from the pool", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const line = nextPreparingMessage();
      expect(PREPARING_MESSAGES).toContain(line);
      seen.add(line);
    }
    // Half-pool cooldown should force real variety across many picks.
    expect(seen.size).toBeGreaterThan(20);
  });

  test("keeps one preparing line per cluster across remount-style lookups", () => {
    const first = preparingMessageFor("term-a:live:prompt-1");
    const again = preparingMessageFor("term-a:live:prompt-1");
    const other = preparingMessageFor("term-a:live:prompt-2");

    expect(again).toBe(first);
    expect(PREPARING_MESSAGES).toContain(first);
    // Distinct clusters draw independently; with cooldown they usually differ.
    expect(typeof other).toBe("string");
  });
});
