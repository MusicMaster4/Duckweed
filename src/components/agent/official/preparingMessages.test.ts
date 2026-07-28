import { describe, expect, test } from "bun:test";

import { PREPARING_MESSAGES, nextPreparingMessage } from "./preparingMessages";

describe("preparingMessages", () => {
  test("the pool has fifty short lines", () => {
    expect(PREPARING_MESSAGES).toHaveLength(50);
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
});
