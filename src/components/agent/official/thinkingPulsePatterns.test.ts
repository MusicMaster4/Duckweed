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

    expect(originals).toHaveLength(563);
    expect(rotations).toHaveLength(1563);
    expect(THINKING_PULSE_PATTERNS).toHaveLength(2126);
    expect(
      rotations.filter((pattern) => pattern.id.endsWith("-rotated-90")),
    ).toHaveLength(537);
    expect(
      rotations.filter((pattern) => pattern.id.endsWith("-rotated-180")),
    ).toHaveLength(513);
    expect(
      rotations.filter((pattern) => pattern.id.endsWith("-rotated-270")),
    ).toHaveLength(513);

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

  test("includes all 50 new matrix formation profiles", () => {
    const formations = [
      "radial-burst",
      "radial-collapse",
      "corner-pinwheel",
      "edge-pinwheel",
      "double-helix",
      "cross-stitch",
      "corner-cascade",
      "center-switchback",
      "orbit-hop",
      "woven-diamond",
    ];
    const profiles = ["quick", "soft", "bright", "trailing", "elastic"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  test("includes the extra 50 matrix formation profiles", () => {
    const formations = [
      "tide-fold",
      "corner-braid",
      "spiral-tri",
      "zigzag-weave",
      "star-sweep",
      "ladder-climb",
      "diamond-cascade",
      "twin-comet",
      "petal-open",
      "lattice-hop",
    ];
    const profiles = ["glint", "heavy", "falling", "stepped", "circling"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  /**
   * The extra bank's motions exist nowhere else, which is what keeps its 50
   * signatures from colliding with the earlier catalog. Guard that property.
   */
  test("includes the third 50 matrix formation profiles", () => {
    const formations = [
      "pulse-gate",
      "tilt-sweep",
      "chevron-run",
      "quarter-turn",
      "twin-arc",
      "scatter-hop",
      "fold-in",
      "rung-climb",
      "swirl-out",
      "beacon-sweep",
    ];
    const profiles = ["tremor", "snap", "polish", "rolling", "rising"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  test("includes the fourth 50 matrix formation profiles", () => {
    const formations = [
      "arrow-north",
      "arrow-east",
      "comb-teeth",
      "nested-square",
      "clover-turn",
      "step-ladder",
      "wave-crest",
      "cross-fade",
      "corner-drift",
      "pivot-swing",
    ];
    const profiles = ["wobbling", "flaring", "sinking", "skidding", "haloing"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  test("includes the fifth 50 matrix formation profiles", () => {
    const formations = [
      "tide-race",
      "anchor-drop",
      "reef-fan",
      "net-haul",
      "gull-turn",
      "mast-climb",
      "keel-roll",
      "harbour-sweep",
      "lantern-swing",
      "undercurrent",
    ];
    const profiles = ["crackling", "dragging", "beaming", "swinging", "sprouting"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  /**
   * Each formation in the fifth bank is a permutation of 0 through 8, which is
   * what guarantees all three of its quarter-turns are distinct animations.
   */
  test("every fifth bank formation gives three distinct rotations", () => {
    const formations = [
      "tide-race",
      "anchor-drop",
      "reef-fan",
      "net-haul",
      "gull-turn",
      "mast-climb",
      "keel-roll",
      "harbour-sweep",
      "lantern-swing",
      "undercurrent",
    ];

    for (const formation of formations) {
      const family = THINKING_PULSE_PATTERNS.filter((pattern) =>
        pattern.id.startsWith(`${formation}-`),
      );
      /* Five profiles, each with an original and three rotations. */
      expect(family).toHaveLength(20);
      expect(new Set(family.map((pattern) => JSON.stringify(pattern.steps))).size).toBe(4);
      for (const pattern of family) {
        expect([...pattern.steps].sort((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
      }
    }
  });

  test("includes the sixth 50 matrix formation profiles", () => {
    const formations = [
      "window-lights",
      "street-lamps",
      "marquee-blink",
      "signal-box",
      "porch-light",
      "circuit-test",
      "switch-board",
      "relay-click",
      "filament-warm",
      "dial-glow",
    ];
    const profiles = ["lamping", "winking", "smouldering", "signalling", "dimming"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  test("includes the seventh 50 matrix formation profiles", () => {
    const formations = [
      "cog-turn",
      "escapement",
      "ratchet-step",
      "flywheel",
      "piston-run",
      "cam-lobe",
      "spindle-wind",
      "governor-swing",
      "chain-drive",
      "bellows-fold",
    ];
    const profiles = ["bobbing", "squashing", "gliding", "bouncing", "faceting"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  /**
   * Same guarantee the fifth bank carries: a formation that uses every step
   * exactly once cannot match any of its own quarter-turns.
   */
  test("every seventh bank formation gives three distinct rotations", () => {
    const formations = [
      "cog-turn",
      "escapement",
      "ratchet-step",
      "flywheel",
      "piston-run",
      "cam-lobe",
      "spindle-wind",
      "governor-swing",
      "chain-drive",
      "bellows-fold",
    ];

    for (const formation of formations) {
      const family = THINKING_PULSE_PATTERNS.filter((pattern) =>
        pattern.id.startsWith(`${formation}-`),
      );
      /* Five profiles, each with an original and three rotations. */
      expect(family).toHaveLength(20);
      expect(new Set(family.map((pattern) => JSON.stringify(pattern.steps))).size).toBe(4);
      for (const pattern of family) {
        expect([...pattern.steps].sort((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
      }
    }
  });

  test("includes the eighth 50 matrix formation profiles", () => {
    const formations = [
      "shuttle-pass",
      "heddle-lift",
      "reed-beat",
      "treadle-fall",
      "bobbin-wind",
      "selvedge-turn",
      "twill-climb",
      "warp-cross",
      "damask-fold",
      "carder-comb",
    ];
    const profiles = ["turning", "vaulting", "peeling", "chiming", "fluttering"];
    const ids = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.id));

    for (const formation of formations) {
      for (const profile of profiles) {
        expect(ids.has(`${formation}-${profile}`)).toBe(true);
      }
    }
  });

  /**
   * Same guarantee the fifth and seventh banks carry: a formation that uses
   * every step exactly once cannot match any of its own quarter-turns.
   */
  test("every eighth bank formation gives three distinct rotations", () => {
    const formations = [
      "shuttle-pass",
      "heddle-lift",
      "reed-beat",
      "treadle-fall",
      "bobbin-wind",
      "selvedge-turn",
      "twill-climb",
      "warp-cross",
      "damask-fold",
      "carder-comb",
    ];

    for (const formation of formations) {
      const family = THINKING_PULSE_PATTERNS.filter((pattern) =>
        pattern.id.startsWith(`${formation}-`),
      );
      /* Five profiles, each with an original and three rotations. */
      expect(family).toHaveLength(20);
      expect(new Set(family.map((pattern) => JSON.stringify(pattern.steps))).size).toBe(4);
      for (const pattern of family) {
        expect([...pattern.steps].sort((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
      }
    }
  });

  /**
   * The sixth bank is the still one: its cells light and go dark where they
   * are. A transform in any of its keyframes would put the grid back in
   * motion, so guard the stylesheet as well as the pool.
   */
  test("the sixth bank's motions never move a cell", async () => {
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();

    for (const motion of ["lamp", "wink", "ember", "morse", "fade"]) {
      const block = css.match(
        new RegExp(`@keyframes agent-activity-${motion}\\s*\\{[\\s\\S]*?\\n\\}`),
      );
      expect(block).not.toBeNull();
      expect(block![0]).not.toContain("transform");
    }
  });

  /**
   * Because the still bank cannot scale, a resting-size cell is the only size
   * it ever shows, which reads as a smaller grid beside a matrix that opens to
   * 1.1 and past it. The stylesheet compensates with a wider cell; if that
   * rule goes, the bank silently looks undersized again.
   */
  test("the still bank's cells are sized up to make up for not scaling", async () => {
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();
    const rule = css.match(
      /((?:\.agent-activity-pulse\[data-motion="(?:lamp|wink|ember|morse|fade)"\],?\s*)+)\{([^}]*)\}/,
    );

    expect(rule).not.toBeNull();
    for (const motion of ["lamp", "wink", "ember", "morse", "fade"]) {
      expect(rule![1]).toContain(`[data-motion="${motion}"]`);
    }
    expect(Number(rule![2]!.match(/--pulse-cell:\s*([\d.]+)px/)?.[1])).toBeGreaterThan(2.5);
    /* The cell has to read that variable, or the override is dead weight. */
    expect(css).toContain("width: var(--pulse-cell");
    expect(css).toContain("height: var(--pulse-cell");
  });

  /**
   * A cell reads at whatever size it holds when it is brightest, so a motion
   * whose lit frame scales under 1 renders a matrix of visibly smaller dots
   * than the pane next to it. Full size is the floor; growing past it is fine.
   */
  test("no motion lights a cell below its resting size", async () => {
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();
    const motions = new Set(THINKING_PULSE_PATTERNS.map((pattern) => pattern.motion));
    const undersized: string[] = [];

    for (const motion of motions) {
      const block = css.match(
        new RegExp(`@keyframes agent-activity-${motion}\\s*\\{[\\s\\S]*?\\n\\}`),
      )![0];
      const frames = [...block.matchAll(/\{([^}]*)\}/g)].map((frame) => {
        /* No scale in the frame means the cell sits at its resting size. A
           two-axis scale is read as the size of the ellipse it draws, so a
           squash that keeps its area counts as full size. */
        const axes = (frame[1]!.match(/scale\(([\d.,\s]+)\)/)?.[1] ?? "1")
          .split(",")
          .map((axis) => Number(axis));
        return {
          opacity: Number(frame[1]!.match(/opacity:\s*([\d.]+)/)?.[1] ?? 1),
          scale: Math.sqrt(axes[0]! * (axes[1] ?? axes[0]!)),
        };
      });
      const brightest = frames.reduce((peak, frame) =>
        frame.opacity > peak.opacity ? frame : peak,
      );

      if (brightest.scale < 1) undersized.push(`${motion} (${brightest.scale})`);
    }

    expect(undersized).toEqual([]);
  });

  test("each late bank's motions are exclusive to it", () => {
    const banks = [
      {
        motions: new Set(["shimmer", "throb", "cascade", "stutter", "orbit"]),
        formations: [
          "tide-fold",
          "corner-braid",
          "spiral-tri",
          "zigzag-weave",
          "star-sweep",
          "ladder-climb",
          "diamond-cascade",
          "twin-comet",
          "petal-open",
          "lattice-hop",
        ],
      },
      {
        motions: new Set(["quiver", "pop", "gleam", "tumble", "surge"]),
        formations: [
          "pulse-gate",
          "tilt-sweep",
          "chevron-run",
          "quarter-turn",
          "twin-arc",
          "scatter-hop",
          "fold-in",
          "rung-climb",
          "swirl-out",
          "beacon-sweep",
        ],
      },
      {
        motions: new Set(["wobble", "flare", "sink", "skid", "halo"]),
        formations: [
          "arrow-north",
          "arrow-east",
          "comb-teeth",
          "nested-square",
          "clover-turn",
          "step-ladder",
          "wave-crest",
          "cross-fade",
          "corner-drift",
          "pivot-swing",
        ],
      },
      {
        motions: new Set(["crackle", "undertow", "beacon", "swing", "sprout"]),
        formations: [
          "tide-race",
          "anchor-drop",
          "reef-fan",
          "net-haul",
          "gull-turn",
          "mast-climb",
          "keel-roll",
          "harbour-sweep",
          "lantern-swing",
          "undercurrent",
        ],
      },
      {
        motions: new Set(["lamp", "wink", "ember", "morse", "fade"]),
        formations: [
          "window-lights",
          "street-lamps",
          "marquee-blink",
          "signal-box",
          "porch-light",
          "circuit-test",
          "switch-board",
          "relay-click",
          "filament-warm",
          "dial-glow",
        ],
      },
      {
        motions: new Set(["bob", "squash", "glide", "bounce", "facet"]),
        formations: [
          "cog-turn",
          "escapement",
          "ratchet-step",
          "flywheel",
          "piston-run",
          "cam-lobe",
          "spindle-wind",
          "governor-swing",
          "chain-drive",
          "bellows-fold",
        ],
      },
      {
        motions: new Set(["spin", "vault", "peel", "chime", "flutter"]),
        formations: [
          "shuttle-pass",
          "heddle-lift",
          "reed-beat",
          "treadle-fall",
          "bobbin-wind",
          "selvedge-turn",
          "twill-climb",
          "warp-cross",
          "damask-fold",
          "carder-comb",
        ],
      },
    ];

    for (const bank of banks) {
      for (const pattern of THINKING_PULSE_PATTERNS) {
        if (!bank.motions.has(pattern.motion)) continue;
        expect(
          bank.formations.some((formation) => pattern.id.startsWith(`${formation}-`)),
        ).toBe(true);
      }
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
        "shimmer",
        "throb",
        "cascade",
        "stutter",
        "orbit",
        "quiver",
        "pop",
        "gleam",
        "tumble",
        "surge",
        "wobble",
        "flare",
        "sink",
        "skid",
        "halo",
        "crackle",
        "undertow",
        "beacon",
        "swing",
        "sprout",
        "lamp",
        "wink",
        "ember",
        "morse",
        "fade",
        "bob",
        "squash",
        "glide",
        "bounce",
        "facet",
        "spin",
        "vault",
        "peel",
        "chime",
        "flutter",
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
