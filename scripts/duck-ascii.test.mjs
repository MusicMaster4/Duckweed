import { describe, expect, test } from "bun:test";

import {
  DUCK_FPS,
  duckLayout,
  renderDuckFrame,
  renderWalkingDuckFrame,
} from "../src/lib/duckAscii.ts";

function assertGrid(text, cols, rows) {
  const lines = text.split("\n");
  expect(lines).toHaveLength(rows);
  for (const line of lines) expect(line).toHaveLength(cols);
}

describe("empty-pane ASCII duck", () => {
  test("fills two aligned grids at normal pane size", () => {
    const layout = duckLayout(960, 420, 8, 17.6, 16);
    const frame = renderDuckFrame(layout, 1.25);

    assertGrid(frame.duck, layout.cols, layout.rows);
    assertGrid(frame.water, layout.cols, layout.rows);
    expect(frame.duck.trim()).not.toBe("");
    expect(frame.water.trim()).not.toBe("");
  });

  test("still draws when a split is extremely small", () => {
    const layout = duckLayout(36, 18, 4.2, 7.7, 7);
    const frame = renderDuckFrame(layout, 2);

    assertGrid(frame.duck, layout.cols, layout.rows);
    assertGrid(frame.water, layout.cols, layout.rows);
    expect(frame.duck.trim()).not.toBe("");
  });

  test("both bird and waves keep changing over time", () => {
    const layout = duckLayout(240, 86, 4.2, 7.7, 7);
    const first = renderDuckFrame(layout, 0);
    const later = renderDuckFrame(layout, 0.7);

    expect(later.duck).not.toBe(first.duck);
    expect(later.water).not.toBe(first.water);
  });

  test("walking duck uses the same 15 FPS ASCII renderer", () => {
    const layout = duckLayout(960, 420, 8, 17.6, 16);
    const first = renderWalkingDuckFrame(layout, 0);
    const nextFrame = renderWalkingDuckFrame(layout, 1 / DUCK_FPS);

    expect(DUCK_FPS).toBe(15);
    assertGrid(first.duck, layout.cols, layout.rows);
    assertGrid(first.water, layout.cols, layout.rows);
    expect(first.duck.trim()).not.toBe("");
    expect(first.water.trim()).not.toBe("");
    const feet = first.duck.split("\n").slice(-4).join("");
    const inkRows = first.duck.split("\n").filter((row) => row.trim());
    expect(inkRows.length).toBeGreaterThan(10);
    expect(feet.trim()).not.toBe("");
    expect(nextFrame.duck).not.toBe(first.duck);
    expect(nextFrame.water).not.toBe(first.water);
  });
});
