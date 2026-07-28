import { describe, expect, test } from "bun:test";

import {
  nextThinkingPulsePattern,
  THINKING_PULSE_PATTERNS,
} from "./thinkingPulsePatterns";

describe("thinking pulse patterns", () => {
  test("provides fifty distinct matrix animations", () => {
    expect(THINKING_PULSE_PATTERNS).toHaveLength(50);
    expect(new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id)).size).toBe(50);

    const signatures = THINKING_PULSE_PATTERNS.map((pattern) =>
      JSON.stringify([
        pattern.steps,
        pattern.motion,
        pattern.durationMs,
        pattern.stepMs,
      ]),
    );
    expect(new Set(signatures).size).toBe(50);
  });

  test("defines every cell and uses every motion style", () => {
    const motions = new Set<string>();

    for (const pattern of THINKING_PULSE_PATTERNS) {
      expect(pattern.steps).toHaveLength(9);
      expect(pattern.steps.every((step) => Number.isInteger(step) && step >= 0)).toBe(
        true,
      );
      expect(pattern.durationMs).toBeGreaterThan(0);
      expect(pattern.stepMs).toBeGreaterThan(0);
      motions.add(pattern.motion);
    }

    expect(motions).toEqual(
      new Set(["chase", "blink", "ripple", "comet", "breathe"]),
    );
  });

  test("does not repeat a pattern within the latest half of the pool", () => {
    const selected = Array.from({ length: 100 }, () => nextThinkingPulsePattern().id);

    selected.forEach((id, index) => {
      const protectedWindow = selected.slice(Math.max(0, index - 25), index);
      expect(protectedWindow).not.toContain(id);
    });
  });
});
