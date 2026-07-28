import { describe, expect, test } from "bun:test";

import { THINKING_PULSE_PATTERNS } from "./thinkingPulsePatterns";

describe("thinking pulse patterns", () => {
  test("the pool holds every path and wave in both directions plus accents", () => {
    expect(THINKING_PULSE_PATTERNS).toHaveLength(163);
  });

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
      expect(pattern.steps.every((step) => Number.isInteger(step) && step >= -1)).toBe(true);
      expect(pattern.steps.some((step) => step >= 0)).toBe(true);
      expect(pattern.durationMs).toBeGreaterThan(0);
      expect(pattern.stepMs).toBeGreaterThan(0);
      motions.add(pattern.motion);
    }

    expect(motions).toEqual(
      new Set([
        "chase",
        "blink",
        "ripple",
        "comet",
        "breathe",
        "flicker",
        "swell",
        "drift",
        "sway",
        "spark",
        "settle",
        "echo",
        "triplet",
      ]),
    );
  });

  test("dark cells always form a mask symmetric under a 180 degree rotation", () => {
    // Partial grids must read as intentional, not as a rendering bug.
    for (const pattern of THINKING_PULSE_PATTERNS) {
      for (let cell = 0; cell < 9; cell += 1) {
        expect(pattern.steps[cell]! >= 0).toBe(pattern.steps[8 - cell]! >= 0);
      }
    }
  });

  test("every motion has a keyframe to run", async () => {
    // A motion with no matching CSS silently renders a still matrix, so keep
    // the pool and the stylesheet locked together.
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();

    for (const motion of new Set(THINKING_PULSE_PATTERNS.map((p) => p.motion))) {
      expect(css).toContain(`[data-motion="${motion}"]`);
      expect(css).toContain(`@keyframes agent-activity-${motion}`);
    }
  });
});
