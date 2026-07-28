import { createCooldownPicker } from "../../../lib/cooldownPicker";

export type ThinkingPulseMotion =
  | "chase"
  | "blink"
  | "ripple"
  | "comet"
  | "breathe"
  | "flicker"
  | "swell"
  | "drift"
  | "sway"
  | "spark"
  | "settle";

export interface ThinkingPulsePattern {
  id: string;
  /** Animation step for each cell in the 3 by 3 matrix. */
  steps: readonly number[];
  motion: ThinkingPulseMotion;
  durationMs: number;
  stepMs: number;
}

interface BasePattern {
  id: string;
  steps: readonly number[];
}

function stepsFromSequence(sequence: readonly number[]): number[] {
  const steps = Array.from({ length: 9 }, () => 0);
  sequence.forEach((cell, step) => {
    steps[cell] = step;
  });
  return steps;
}

function invertSteps(steps: readonly number[]): number[] {
  const maximum = Math.max(...steps);
  return steps.map((step) => maximum - step);
}

const PATHS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["rows", [0, 1, 2, 3, 4, 5, 6, 7, 8]],
  ["row-snake", [0, 1, 2, 5, 4, 3, 6, 7, 8]],
  ["columns", [0, 3, 6, 1, 4, 7, 2, 5, 8]],
  ["column-snake", [0, 3, 6, 7, 4, 1, 2, 5, 8]],
  ["spiral-clockwise", [0, 1, 2, 5, 8, 7, 6, 3, 4]],
  ["spiral-counter", [2, 5, 8, 7, 6, 3, 0, 1, 4]],
  ["center-cross", [4, 1, 5, 7, 3, 0, 2, 8, 6]],
  ["center-diagonals", [4, 0, 2, 8, 6, 1, 5, 7, 3]],
  ["corner-orbit", [0, 2, 8, 6, 1, 5, 7, 3, 4]],
  ["main-diagonals", [0, 4, 8, 2, 6, 1, 3, 5, 7]],
  ["split-diagonals", [2, 4, 6, 0, 8, 1, 5, 7, 3]],
  ["diagonal-zigzag", [0, 1, 3, 6, 4, 2, 5, 7, 8]],
  ["diagonal-zag", [2, 1, 5, 8, 4, 0, 3, 7, 6]],
  ["knight-one", [0, 5, 6, 1, 8, 3, 2, 7, 4]],
  ["knight-two", [2, 3, 8, 1, 6, 5, 0, 7, 4]],
  ["pinwheel", [1, 2, 5, 8, 7, 6, 3, 0, 4]],
  ["edge-weave", [0, 4, 8, 5, 2, 1, 3, 6, 7]],
  ["outer-inner", [0, 2, 8, 6, 4, 1, 3, 5, 7]],
  ["rows-bottom-up", [6, 7, 8, 3, 4, 5, 0, 1, 2]],
  ["columns-right-first", [2, 5, 8, 1, 4, 7, 0, 3, 6]],
  ["spiral-in-counter", [0, 3, 6, 7, 8, 5, 2, 1, 4]],
  ["spiral-out-clockwise", [4, 0, 1, 2, 5, 8, 7, 6, 3]],
  ["letter-z", [0, 1, 2, 4, 6, 7, 8, 3, 5]],
  ["letter-s", [2, 1, 0, 4, 8, 7, 6, 3, 5]],
  ["letter-n", [6, 3, 0, 4, 8, 5, 2, 1, 7]],
  ["bowtie", [0, 6, 4, 2, 8, 1, 7, 3, 5]],
  ["perimeter-from-bottom", [7, 6, 3, 0, 1, 2, 5, 8, 4]],
  ["opposite-pairs", [0, 8, 2, 6, 1, 7, 3, 5, 4]],
  ["plus-sweep", [4, 3, 5, 1, 7, 0, 2, 6, 8]],
  ["knight-center-first", [4, 0, 5, 6, 1, 8, 3, 2, 7]],
  ["edge-then-corner", [1, 7, 3, 5, 0, 2, 6, 8, 4]],
  ["column-converge", [0, 2, 3, 5, 6, 8, 1, 7, 4]],
  ["row-converge", [0, 6, 1, 7, 2, 8, 3, 5, 4]],
  ["middle-out-rows", [3, 4, 5, 0, 1, 2, 6, 7, 8]],
  ["middle-out-columns", [1, 4, 7, 0, 3, 6, 2, 5, 8]],
  ["hourglass", [0, 2, 4, 6, 8, 1, 7, 3, 5]],
  ["helix", [0, 5, 6, 2, 3, 8, 7, 4, 1]],
  ["diagonal-fan", [0, 3, 1, 6, 4, 2, 7, 5, 8]],
  ["ricochet", [0, 4, 8, 5, 1, 3, 7, 6, 2]],
  ["starburst", [4, 0, 2, 6, 8, 1, 3, 5, 7]],
  ["funnel", [0, 2, 3, 5, 1, 7, 6, 8, 4]],
];

const WAVES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["row-wave", [0, 0, 0, 1, 1, 1, 2, 2, 2]],
  ["column-wave", [0, 1, 2, 0, 1, 2, 0, 1, 2]],
  ["diagonal-down", [0, 1, 2, 1, 2, 3, 2, 3, 4]],
  ["diagonal-up", [2, 1, 0, 3, 2, 1, 4, 3, 2]],
  ["center-ripple", [2, 1, 2, 1, 0, 1, 2, 1, 2]],
  ["corner-ripple", [0, 1, 0, 1, 2, 1, 0, 1, 0]],
  ["checker", [0, 1, 0, 1, 0, 1, 0, 1, 0]],
  ["frame-wave", [0, 0, 0, 0, 1, 0, 0, 0, 0]],
  ["row-fold", [0, 0, 0, 1, 1, 1, 0, 0, 0]],
  ["column-fold", [0, 1, 0, 0, 1, 0, 0, 1, 0]],
  ["row-snake-wave", [0, 1, 2, 2, 1, 0, 0, 1, 2]],
  ["diagonal-pairs", [0, 2, 1, 2, 3, 2, 1, 2, 0]],
  ["sweep-wave", [0, 0, 1, 3, 2, 1, 3, 2, 2]],
  ["top-arc", [1, 0, 1, 2, 1, 2, 3, 2, 3]],
  ["bottom-arc", [3, 2, 3, 2, 1, 2, 1, 0, 1]],
  ["left-arc", [1, 2, 3, 0, 1, 2, 1, 2, 3]],
  ["right-arc", [3, 2, 1, 2, 1, 0, 3, 2, 1]],
  ["rain-wave", [0, 2, 1, 1, 3, 2, 2, 4, 3]],
  ["corner-block-wave", [0, 1, 2, 1, 1, 2, 2, 2, 2]],
  ["main-diagonal-fold", [0, 1, 2, 1, 0, 1, 2, 1, 0]],
  ["anti-diagonal-fold", [2, 1, 0, 1, 0, 1, 0, 1, 2]],
  ["spiral-band", [0, 0, 1, 3, 3, 1, 2, 2, 2]],
];

const BASE_PATTERNS: readonly BasePattern[] = [
  ...PATHS.map(([id, sequence]) => ({ id, steps: stepsFromSequence(sequence) })),
  ...WAVES.map(([id, steps]) => ({ id, steps })),
];

const MOTIONS: readonly ThinkingPulseMotion[] = [
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
];

/**
 * Every base path and wave in both directions.
 *
 * Motion, duration, and cadence step through cycles of 11, 7, and 6, so the
 * three only realign after 462 entries. That keeps each pattern's timing
 * signature unique for any pool this side of that bound.
 */
export const THINKING_PULSE_PATTERNS: readonly ThinkingPulsePattern[] =
  BASE_PATTERNS.flatMap((base, index) => {
    const durationMs = 880 + (index % 7) * 105;
    const stepMs = 42 + (index % 6) * 13;
    return [
      {
        id: `${base.id}-forward`,
        steps: base.steps,
        motion: MOTIONS[index % MOTIONS.length],
        durationMs,
        stepMs,
      },
      {
        id: `${base.id}-reverse`,
        steps: invertSteps(base.steps),
        motion: MOTIONS[(index + 2) % MOTIONS.length],
        durationMs: durationMs + 75,
        stepMs: stepMs + 7,
      },
    ];
  });

const pickPattern = createCooldownPicker(
  THINKING_PULSE_PATTERNS,
  THINKING_PULSE_PATTERNS[0]!,
);

/** Shared across panes, matching the greeting selector's half-pool cooldown. */
export function nextThinkingPulsePattern(): ThinkingPulsePattern {
  return pickPattern();
}
