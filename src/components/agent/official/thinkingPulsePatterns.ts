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
  | "settle"
  | "echo"
  | "triplet"
  | "bloom"
  | "shimmer"
  | "throb"
  | "cascade"
  | "stutter"
  | "orbit"
  | "quiver"
  | "pop"
  | "gleam"
  | "tumble"
  | "surge";

export interface ThinkingPulsePattern {
  id: string;
  /** Animation step for each cell in the 3 by 3 matrix. -1 keeps a cell dark. */
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

/** Rotate a row-major 3 by 3 timing grid 90 degrees clockwise. */
function rotateStepsClockwise(steps: readonly number[]): number[] {
  const rotated = Array.from({ length: 9 }, () => 0);

  for (let source = 0; source < steps.length; source += 1) {
    const row = Math.floor(source / 3);
    const column = source % 3;
    const targetRow = column;
    const targetColumn = 2 - row;
    rotated[targetRow * 3 + targetColumn] = steps[source]!;
  }

  return rotated;
}

function patternSignature(pattern: ThinkingPulsePattern): string {
  return JSON.stringify([
    pattern.steps,
    pattern.motion,
    pattern.durationMs,
    pattern.stepMs,
  ]);
}

/**
 * Add every clockwise quarter-turn wherever it creates a genuinely different
 * animation. Symmetric rotations and rotations already represented in the
 * pool are skipped.
 */
function withRotatedVariants(
  patterns: readonly ThinkingPulsePattern[],
): ThinkingPulsePattern[] {
  const signatures = new Set(patterns.map(patternSignature));
  const rotatedPatterns: ThinkingPulsePattern[] = [];

  for (const pattern of patterns) {
    let steps = pattern.steps;

    for (const angle of [90, 180, 270] as const) {
      steps = rotateStepsClockwise(steps);
      const rotatedPattern: ThinkingPulsePattern = {
        ...pattern,
        id: `${pattern.id}-rotated-${angle}`,
        steps,
      };
      const signature = patternSignature(rotatedPattern);

      if (signatures.has(signature)) continue;
      signatures.add(signature);
      rotatedPatterns.push(rotatedPattern);
    }
  }

  return [...patterns, ...rotatedPatterns];
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

/**
 * Patterns with an explicit motion. -1 keeps a cell dark for the whole cycle;
 * every mask of lit cells is symmetric under a 180 degree rotation so partial
 * grids read as designed instead of broken. The echo and triplet motions make
 * each lit cell fire more than once per cycle.
 *
 * Anything that used to light fewer than half the cells now runs the bloom
 * motion instead: a springy pop that starts on the cells the sparse mask lit
 * first, then keeps going until all nine cells have bloomed.
 */
const ACCENTS: ReadonlyArray<
  readonly [string, readonly number[], ThinkingPulseMotion]
> = [
  ["corners-alternate", [0, 4, 2, 5, 6, 7, 3, 8, 1], "bloom"],
  ["corners-orbit-solo", [0, 4, 1, 5, 6, 7, 3, 8, 2], "bloom"],
  ["x-bloom", [1, -1, 1, -1, 0, -1, 1, -1, 1], "ripple"],
  ["x-chase", [0, -1, 1, -1, 2, -1, 3, -1, 4], "comet"],
  ["plus-bloom", [-1, 1, -1, 1, 0, 1, -1, 1, -1], "breathe"],
  ["plus-orbit", [-1, 0, -1, 3, 2, 1, -1, 4, -1], "triplet"],
  ["edge-orbit", [4, 0, 5, 3, 6, 1, 7, 2, 8], "bloom"],
  ["edge-pairs", [4, 0, 5, 2, 6, 3, 7, 1, 8], "bloom"],
  ["ring-orbit", [0, 1, 2, 7, -1, 3, 6, 5, 4], "comet"],
  ["ring-counter", [0, 7, 6, 1, -1, 5, 2, 3, 4], "spark"],
  ["ring-converge", [0, 1, 2, 3, -1, 3, 2, 1, 0], "ripple"],
  ["diagonal-solo", [0, 3, 4, 5, 1, 6, 7, 8, 2], "bloom"],
  ["anti-diagonal-solo", [3, 4, 0, 5, 1, 6, 2, 7, 8], "bloom"],
  ["rows-apart", [0, 0, 0, -1, -1, -1, 1, 1, 1], "blink"],
  ["rows-clap", [0, 1, 0, -1, -1, -1, 0, 1, 0], "echo"],
  ["columns-apart", [0, -1, 1, 0, -1, 1, 0, -1, 1], "swell"],
  ["columns-clap", [0, -1, 0, 1, -1, 1, 0, -1, 0], "triplet"],
  ["middle-row-pulse", [3, 4, 5, 0, 2, 1, 6, 7, 8], "bloom"],
  ["middle-column-pulse", [3, 0, 4, 5, 2, 6, 7, 1, 8], "bloom"],
  ["center-beat", [5, 1, 6, 2, 0, 3, 7, 4, 8], "bloom"],
  ["corner-pair-main", [0, 2, 3, 4, 5, 6, 7, 8, 1], "bloom"],
  ["corner-pair-anti", [2, 3, 0, 4, 5, 6, 1, 7, 8], "bloom"],
  ["vertical-gates", [2, 0, 3, 4, 5, 6, 7, 1, 8], "bloom"],
  ["horizontal-gates", [2, 3, 4, 0, 5, 1, 6, 7, 8], "bloom"],
  ["diamond-spin", [4, 0, 5, 1, 6, 3, 7, 2, 8], "bloom"],
  ["checker-echo", [0, 1, 0, 1, 0, 1, 0, 1, 0], "echo"],
  ["frame-echo", [0, 0, 0, 0, 1, 0, 0, 0, 0], "echo"],
  ["x-alternate", [0, -1, 0, -1, 1, -1, 0, -1, 0], "blink"],
  ["ring-skip", [0, 4, 1, 7, -1, 5, 3, 6, 2], "spark"],
  ["h-bridge", [0, -1, 0, 1, 2, 1, 0, -1, 0], "swell"],
  ["i-beam", [0, 0, 0, -1, 1, -1, 2, 2, 2], "settle"],
  ["x-collapse", [0, -1, 1, -1, 4, -1, 2, -1, 3], "comet"],
  ["plus-collapse", [-1, 0, -1, 3, 4, 1, -1, 2, -1], "ripple"],
  ["ring-beat", [0, 0, 0, 0, -1, 0, 0, 0, 0], "triplet"],
  ["x-beat", [0, -1, 0, -1, 0, -1, 0, -1, 0], "echo"],
  ["plus-beat", [-1, 0, -1, 0, 0, 0, -1, 0, -1], "triplet"],
  ["corner-beat", [0, 4, 1, 5, 6, 7, 2, 8, 3], "bloom"],
];

/**
 * Ten new timing formations paired with five distinct animation profiles.
 * Keeping the formations and profiles separate makes the 50 authored patterns
 * easy to audit while still giving each one a unique motion and cadence.
 */
const MATRIX_FORMATIONS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["radial-burst", [4, 2, 4, 2, 0, 2, 4, 2, 4]],
  ["radial-collapse", [0, 2, 0, 2, 4, 2, 0, 2, 0]],
  ["corner-pinwheel", [0, 3, 1, 7, 8, 4, 2, 6, 5]],
  ["edge-pinwheel", [3, 0, 4, 7, 8, 1, 6, 5, 2]],
  ["double-helix", [0, 4, 8, 6, 2, 1, 5, 7, 3]],
  ["cross-stitch", [0, 5, 2, 7, 4, 1, 6, 3, 8]],
  ["corner-cascade", [0, 1, 3, 2, 4, 6, 5, 7, 8]],
  ["center-switchback", [5, 1, 6, 3, 0, 7, 4, 2, 8]],
  ["orbit-hop", [0, 3, 6, 7, 4, 1, 2, 5, 8]],
  ["woven-diamond", [2, 0, 4, 6, 1, 8, 5, 3, 7]],
];

const MATRIX_PROFILES: ReadonlyArray<
  readonly [string, ThinkingPulseMotion, number, number]
> = [
  ["quick", "chase", 1680, 54],
  ["soft", "breathe", 1810, 71],
  ["bright", "spark", 1940, 63],
  ["trailing", "echo", 2070, 82],
  ["elastic", "bloom", 2200, 76],
];

const MATRIX_PULSE_PATTERNS: readonly ThinkingPulsePattern[] =
  MATRIX_FORMATIONS.flatMap(([formationId, steps], formationIndex) =>
    MATRIX_PROFILES.map(([profileId, motion, durationMs, stepMs], profileIndex) => ({
      id: `${formationId}-${profileId}`,
      steps,
      motion,
      durationMs: durationMs + formationIndex * 17 + profileIndex,
      stepMs: stepMs + formationIndex * 3,
    })),
  );

/**
 * A second bank of ten formations, paired with five motions that exist only
 * here. A brand new motion per profile means none of these 50 can collide with
 * an earlier signature, and the matrix gains five cadences the first bank
 * never had: a fast glint, a heavy swell, a falling trail, a stepped climb,
 * and a circling wobble.
 */
const EXTRA_MATRIX_FORMATIONS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["tide-fold", [0, 1, 2, 3, 4, 5, 8, 7, 6]],
  ["corner-braid", [0, 4, 1, 5, 8, 3, 2, 7, 6]],
  ["spiral-tri", [2, 3, 4, 1, 0, 5, 8, 7, 6]],
  ["zigzag-weave", [0, 5, 2, 7, 4, 1, 6, 3, 8]],
  ["star-sweep", [1, 6, 3, 8, 0, 7, 4, 5, 2]],
  ["ladder-climb", [8, 6, 7, 5, 3, 4, 2, 0, 1]],
  ["diamond-cascade", [3, 0, 3, 2, 1, 2, 5, 4, 5]],
  ["twin-comet", [0, 2, 4, 1, 3, 5, 6, 8, 7]],
  ["petal-open", [5, 2, 5, 3, 0, 3, 4, 1, 4]],
  ["lattice-hop", [0, 6, 1, 7, 4, 8, 2, 5, 3]],
];

const EXTRA_MATRIX_PROFILES: ReadonlyArray<
  readonly [string, ThinkingPulseMotion, number, number]
> = [
  ["glint", "shimmer", 2380, 51],
  ["heavy", "throb", 2520, 88],
  ["falling", "cascade", 2660, 69],
  ["stepped", "stutter", 2800, 47],
  ["circling", "orbit", 2940, 74],
];

const EXTRA_MATRIX_PULSE_PATTERNS: readonly ThinkingPulsePattern[] =
  EXTRA_MATRIX_FORMATIONS.flatMap(([formationId, steps], formationIndex) =>
    EXTRA_MATRIX_PROFILES.map(
      ([profileId, motion, durationMs, stepMs], profileIndex) => ({
        id: `${formationId}-${profileId}`,
        steps,
        motion,
        durationMs: durationMs + formationIndex * 19 + profileIndex * 2,
        stepMs: stepMs + formationIndex * 4,
      }),
    ),
  );

/**
 * A third bank of ten formations with five more motions of its own. The same
 * trick as the bank above keeps its 50 signatures clear of everything else:
 * the motions exist nowhere but here. The cadences it adds are a nervous
 * tremble, a hard snap, a slow polish, a rolling lean, and a rising push.
 */
const THIRD_MATRIX_FORMATIONS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["pulse-gate", [0, 2, 0, 4, 6, 4, 0, 2, 0]],
  ["tilt-sweep", [0, 2, 4, 1, 3, 5, 2, 4, 6]],
  ["chevron-run", [0, 3, 0, 1, 4, 1, 2, 5, 2]],
  ["quarter-turn", [3, 6, 7, 0, 8, 4, 2, 1, 5]],
  ["twin-arc", [2, 0, 2, 4, 1, 4, 6, 3, 6]],
  ["scatter-hop", [5, 0, 7, 2, 4, 6, 1, 8, 3]],
  ["fold-in", [0, 4, 1, 5, 8, 6, 2, 7, 3]],
  ["rung-climb", [6, 7, 8, 3, 5, 4, 0, 2, 1]],
  ["swirl-out", [4, 5, 6, 3, 0, 7, 2, 1, 8]],
  ["beacon-sweep", [0, 1, 0, 3, 2, 3, 4, 5, 4]],
];

const THIRD_MATRIX_PROFILES: ReadonlyArray<
  readonly [string, ThinkingPulseMotion, number, number]
> = [
  ["tremor", "quiver", 3080, 58],
  ["snap", "pop", 3220, 66],
  ["polish", "gleam", 3360, 79],
  ["rolling", "tumble", 3500, 44],
  ["rising", "surge", 3640, 85],
];

const THIRD_MATRIX_PULSE_PATTERNS: readonly ThinkingPulsePattern[] =
  THIRD_MATRIX_FORMATIONS.flatMap(([formationId, steps], formationIndex) =>
    THIRD_MATRIX_PROFILES.map(
      ([profileId, motion, durationMs, stepMs], profileIndex) => ({
        id: `${formationId}-${profileId}`,
        steps,
        motion,
        durationMs: durationMs + formationIndex * 23 + profileIndex * 3,
        stepMs: stepMs + formationIndex * 5,
      }),
    ),
  );

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
 * Every base path and wave in both directions, plus the accent set.
 *
 * For the base pool, motion, duration, and cadence step through cycles of 11,
 * 7, and 6, so the three only realign after 462 entries. That keeps each
 * pattern's timing signature unique for any pool this side of that bound.
 * Accents carry their own motion, while the matrix formations use a separate
 * timing range so their signatures cannot overlap the earlier catalog. The
 * extra and third banks are safe by construction: each carries five motions
 * that appear nowhere else.
 */
const ORIGINAL_PULSE_PATTERNS: readonly ThinkingPulsePattern[] = [
  ...BASE_PATTERNS.flatMap((base, index) => {
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
  }),
  ...ACCENTS.map(([id, steps, motion], index) => ({
    id,
    steps,
    motion,
    durationMs: 920 + (index % 8) * 90,
    stepMs: 48 + (index % 5) * 16,
  })),
  ...MATRIX_PULSE_PATTERNS,
  ...EXTRA_MATRIX_PULSE_PATTERNS,
  ...THIRD_MATRIX_PULSE_PATTERNS,
];

/**
 * The authored pool plus every distinct 90, 180, and 270 degree variant.
 * Rotating the timing grid keeps all cell motions and masks valid while
 * giving directional paths and waves every possible orientation.
 */
export const THINKING_PULSE_PATTERNS: readonly ThinkingPulsePattern[] =
  withRotatedVariants(ORIGINAL_PULSE_PATTERNS);

const pickPattern = createCooldownPicker(
  THINKING_PULSE_PATTERNS,
  THINKING_PULSE_PATTERNS[0]!,
  Math.random,
  { poolId: "thinking-pulse-patterns" },
);

/** Shared across panes, matching the greeting selector's 70% pool cooldown. */
export function nextThinkingPulsePattern(): ThinkingPulsePattern {
  return pickPattern();
}

/** Enough for any plausible number of live thinking clusters. */
const REGISTRY_LIMIT = 128;

/**
 * Thinking clusters remount when a pane is re-parented (tab switch, split).
 * Component state cannot survive that; keying the draw off a stable cluster id
 * keeps the same matrix running instead of rolling a new pattern mid-wait.
 */
const patternAssignments = new Map<string, ThinkingPulsePattern>();

/** Same pattern for the same cluster across remounts; a new id draws again. */
export function thinkingPulsePatternFor(clusterId: string): ThinkingPulsePattern {
  const existing = patternAssignments.get(clusterId);
  if (existing) return existing;

  const pattern = nextThinkingPulsePattern();
  if (patternAssignments.size >= REGISTRY_LIMIT) {
    const oldest = patternAssignments.keys().next().value;
    if (oldest !== undefined) patternAssignments.delete(oldest);
  }
  patternAssignments.set(clusterId, pattern);
  return pattern;
}
