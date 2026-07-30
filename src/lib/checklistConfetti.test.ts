import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import {
  CONFETTI_DURATION_MS,
  CONFETTI_DURATION_S,
  CONFETTI_FALL_S,
  CONFETTI_H,
  CONFETTI_SPAWN_S,
  CONFETTI_W,
  confettiActive,
  paintChecklistConfetti,
} from "./checklistConfetti";

function nonSpaceCount(frame: string): number {
  return [...frame].filter((ch) => ch !== " " && ch !== "\n").length;
}

function rowNonSpace(frame: string, row: number): number {
  const lines = frame.split("\n");
  const line = lines[row] ?? "";
  return [...line].filter((ch) => ch !== " ").length;
}

describe("paintChecklistConfetti", () => {
  test("paints a fixed-size grid", () => {
    const frame = paintChecklistConfetti(0.4);
    const rows = frame.split("\n");
    expect(rows.length).toBe(CONFETTI_H);
    for (const row of rows) {
      expect(row.length).toBe(CONFETTI_W);
    }
  });

  test("spawns glyphs during the opening window near the top", () => {
    const early = paintChecklistConfetti(0.2);
    expect(nonSpaceCount(early)).toBeGreaterThan(8);
    let top = 0;
    for (let y = 0; y < Math.floor(CONFETTI_H / 3); y += 1) {
      top += rowNonSpace(early, y);
    }
    expect(top).toBeGreaterThan(0);
  });

  test("flakes keep moving through mid and late clocks", () => {
    const a = paintChecklistConfetti(0.45);
    const b = paintChecklistConfetti(0.55);
    const c = paintChecklistConfetti(1.1);
    // Continuous motion: nearby clocks are not identical freezes.
    expect(a).not.toBe(b);
    expect(nonSpaceCount(a)).toBeGreaterThan(10);
    expect(nonSpaceCount(c)).toBeGreaterThan(10);
  });

  test("morphs glyphs before a flake moves to the next row", () => {
    const a = paintChecklistConfetti(0.8);
    const b = paintChecklistConfetti(0.86);
    expect(a).not.toBe(b);
  });

  test("flakes reach the bottom rows before the celebration ends", () => {
    // Mid-late: flakes born early should be near the floor.
    const late = paintChecklistConfetti(CONFETTI_SPAWN_S + CONFETTI_FALL_S * 0.85);
    expect(nonSpaceCount(late)).toBeGreaterThan(0);

    let bottomBand = 0;
    for (let y = CONFETTI_H - 4; y < CONFETTI_H; y += 1) {
      bottomBand += rowNonSpace(late, y);
    }
    expect(bottomBand).toBeGreaterThan(0);
  });

  test("is deterministic for the same clock", () => {
    expect(paintChecklistConfetti(0.77)).toBe(paintChecklistConfetti(0.77));
  });

  test("clears after the celebration window", () => {
    const done = paintChecklistConfetti(CONFETTI_DURATION_S + 0.05);
    expect(nonSpaceCount(done)).toBe(0);
  });
});

describe("confettiActive", () => {
  test("stays live only for the short celebration window", () => {
    expect(confettiActive(0)).toBe(true);
    expect(confettiActive(CONFETTI_SPAWN_S)).toBe(true);
    expect(confettiActive(CONFETTI_DURATION_S - 0.01)).toBe(true);
    expect(confettiActive(CONFETTI_DURATION_S)).toBe(false);
    expect(confettiActive(-0.1)).toBe(false);
  });
});

describe("shipped checklist overlay wiring", () => {
  test("ChecklistTool mounts a full-area confetti overlay, not inline fireworks", () => {
    const src = readFileSync(new URL("../components/ChecklistTool.tsx", import.meta.url), "utf8");
    expect(src).toContain('className="check-celebrate-overlay"');
    expect(src).toContain('scene="confetti"');
    expect(src).toContain("CONFETTI_DURATION_MS");
    expect(src).toContain("fps={18}");
    expect(src).toContain("becameAllClear");
    expect(src).toContain("celebrateGenerationRef.current += 1");
    expect(src).not.toContain('scene="fireworks"');
    expect(src.indexOf("check-celebrate-overlay")).toBeLessThan(src.indexOf("check-head"));
  });

  test("CSS covers the checklist surface without intercepting clicks", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const blockStart = css.indexOf(".check-celebrate-overlay");
    expect(blockStart).toBeGreaterThan(-1);
    const block = css.slice(blockStart, blockStart + 1200);
    expect(block).toContain("position: absolute");
    expect(block).toContain("inset: 0");
    expect(block).toContain("pointer-events: none");
    expect(block).toContain("z-index: 6");
    // Rows are sized to the panel height so the last row is the visual bottom.
    expect(block).toContain("100cqh / 32");
  });

  test("celebration duration waits for spawn plus a full fall", () => {
    expect(CONFETTI_DURATION_MS).toBe(Math.round(CONFETTI_DURATION_S * 1000));
    expect(CONFETTI_SPAWN_S).toBeGreaterThan(1);
    expect(CONFETTI_FALL_S).toBeGreaterThan(3);
    expect(CONFETTI_DURATION_S).toBeGreaterThan(CONFETTI_SPAWN_S + CONFETTI_FALL_S);
  });
});
