import { describe, expect, test } from "bun:test";

import {
  THINKING_PULSE_PATTERNS,
  thinkingPulsePatternFor,
} from "./thinkingPulsePatterns";

describe("thinking pulse patterns", () => {
  test("the pool includes every distinct quarter-turn orientation", () => {
    const rotatedSuffix = /-rotated-(90|180|270)$/;
    const originals = THINKING_PULSE_PATTERNS.filter(
      (pattern) => !rotatedSuffix.test(pattern.id),
    );
    const rotations = THINKING_PULSE_PATTERNS.filter((pattern) =>
      rotatedSuffix.test(pattern.id),
    );

    expect(originals).toHaveLength(163);
    expect(rotations).toHaveLength(413);
    expect(THINKING_PULSE_PATTERNS).toHaveLength(576);
    expect(
      rotations.filter((pattern) => pattern.id.endsWith("-rotated-90")),
    ).toHaveLength(147);
    expect(
      rotations.filter((pattern) => pattern.id.endsWith("-rotated-180")),
    ).toHaveLength(133);
    expect(
      rotations.filter((pattern) => pattern.id.endsWith("-rotated-270")),
    ).toHaveLength(133);

    const rotateClockwise = (steps: readonly number[]) =>
      steps.map((_, target) => {
        const targetRow = Math.floor(target / 3);
        const targetColumn = target % 3;
        const sourceRow = 2 - targetColumn;
        const sourceColumn = targetRow;
        return steps[sourceRow * 3 + sourceColumn]!;
      });
    const signature = (pattern: (typeof THINKING_PULSE_PATTERNS)[number]) =>
      JSON.stringify([
        pattern.steps,
        pattern.motion,
        pattern.durationMs,
        pattern.stepMs,
      ]);
    const expectedSignatures = new Set(originals.map(signature));

    for (const original of originals) {
      let steps = original.steps;
      for (const angle of [90, 180, 270] as const) {
        steps = rotateClockwise(steps);
        expectedSignatures.add(signature({ ...original, steps }));
      }
    }

    expect(new Set(THINKING_PULSE_PATTERNS.map(signature))).toEqual(
      expectedSignatures,
    );

    const originalsById = new Map(
      originals.map((pattern) => [pattern.id, pattern]),
    );
    for (const rotation of rotations) {
      const match = rotation.id.match(rotatedSuffix)!;
      const angle = Number(match[1]);
      const sourceId = rotation.id.replace(rotatedSuffix, "");
      const original = originalsById.get(sourceId)!;
      let steps = original.steps;

      for (let turn = 0; turn < angle / 90; turn += 1) {
        steps = rotateClockwise(steps);
      }

      expect(rotation).toEqual({ ...original, id: rotation.id, steps });
    }
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
        "bloom",
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

  /**
   * Tab switches and pane splits remount the thinking row. The pattern must be
   * keyed by cluster id, not component identity, or the matrix jumps mid-wait.
   */
  test("keeps one pattern per cluster across remount-style lookups", () => {
    const first = thinkingPulsePatternFor("term-a:group-1");
    const again = thinkingPulsePatternFor("term-a:group-1");
    const other = thinkingPulsePatternFor("term-a:group-2");

    expect(again).toBe(first);
    expect(other.id).not.toBe(first.id);
  });
});
