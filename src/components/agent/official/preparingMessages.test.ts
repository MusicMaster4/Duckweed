import { afterEach, describe, expect, test } from "bun:test";

import {
  FUNNY_THINKING_LABEL_CHANCE,
  PREPARING_MESSAGES,
  nextPreparingMessage,
  preparingMessageFor,
  resetPreparingMessageAssignmentsForTests,
  setFunnyThinkingLabelRandomForTests,
  thinkingHeadlineFor,
} from "./preparingMessages";

afterEach(() => {
  resetPreparingMessageAssignmentsForTests();
});

describe("preparingMessages", () => {
  test("the pool has six hundred short lines", () => {
    expect(PREPARING_MESSAGES).toHaveLength(600);
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

  test("keeps Thinking as the headline except for a rare live swap", () => {
    expect(FUNNY_THINKING_LABEL_CHANCE).toBe(0.01);

    expect(
      thinkingHeadlineFor("term-a:live:idle", { working: false, hasLatest: true }),
    ).toBe("Thinking");
    expect(
      thinkingHeadlineFor("term-a:live:empty", { working: true, hasLatest: false }),
    ).toBe("Thinking");

    setFunnyThinkingLabelRandomForTests(() => 1);
    expect(
      thinkingHeadlineFor("term-a:live:miss", { working: true, hasLatest: true }),
    ).toBe("Thinking");

    setFunnyThinkingLabelRandomForTests(() => 0);
    const swapped = thinkingHeadlineFor("term-a:live:hit", {
      working: true,
      hasLatest: true,
    });
    expect(PREPARING_MESSAGES).toContain(swapped);
    expect(
      thinkingHeadlineFor("term-a:live:hit", { working: true, hasLatest: true }),
    ).toBe(swapped);
    expect(
      thinkingHeadlineFor("term-a:live:hit", { working: false, hasLatest: true }),
    ).toBe("Thinking");
  });
});
