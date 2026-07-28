import { describe, expect, test } from "bun:test";

import { THINKING_PULSE_PATTERNS } from "./thinkingPulsePatterns";

describe("thinking pulse patterns", () => {
  test("no two patterns are the same animation", () => {
    // Ids key the pool; identical timing signatures would read as a repeat on
    // screen even with distinct ids.
    const ids = THINKING_PULSE_PATTERNS.map((pattern) => pattern.id);
    expect(new Set(ids).size).toBe(THINKING_PULSE_PATTERNS.length);

    const signatures = THINKING_PULSE_PATTERNS.map((pattern) =>
      JSON.stringify([pattern.steps, pattern.motion, pattern.durationMs, pattern.stepMs]),
    );
    expect(new Set(signatures).size).toBe(THINKING_PULSE_PATTERNS.length);
  });

  test("defines every cell and uses every motion style", () => {
    const motions = new Set<string>();

    for (const pattern of THINKING_PULSE_PATTERNS) {
      expect(pattern.steps).toHaveLength(9);
      expect(pattern.steps.every((step) => Number.isInteger(step) && step >= 0)).toBe(true);
      expect(pattern.durationMs).toBeGreaterThan(0);
      expect(pattern.stepMs).toBeGreaterThan(0);
      motions.add(pattern.motion);
    }

    expect(motions).toEqual(new Set(["chase", "blink", "ripple", "comet", "breathe"]));
  });
});
