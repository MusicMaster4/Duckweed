import { describe, expect, it } from "bun:test";

import {
  ALL_EDGES,
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  edgeRadius,
  edgesForChild,
} from "./layout";

const R = "var(--pane-edge-radius)";

describe("edgesForChild", () => {
  it("keeps top and bottom for every child of a row split", () => {
    for (const index of [0, 1, 2]) {
      expect(edgesForChild(ALL_EDGES, "row", index, 3) & (EDGE_TOP | EDGE_BOTTOM)).toBe(EDGE_TOP | EDGE_BOTTOM);
    }
  });

  it("gives the outer side only to the first and last child", () => {
    expect(edgesForChild(ALL_EDGES, "row", 0, 3) & EDGE_LEFT).toBe(EDGE_LEFT);
    expect(edgesForChild(ALL_EDGES, "row", 1, 3) & (EDGE_LEFT | EDGE_RIGHT)).toBe(0);
    expect(edgesForChild(ALL_EDGES, "row", 2, 3) & EDGE_RIGHT).toBe(EDGE_RIGHT);
    expect(edgesForChild(ALL_EDGES, "col", 0, 2) & EDGE_TOP).toBe(EDGE_TOP);
    expect(edgesForChild(ALL_EDGES, "col", 1, 2) & EDGE_BOTTOM).toBe(EDGE_BOTTOM);
  });

  it("never hands back an edge the parent had already lost", () => {
    const parent = edgesForChild(ALL_EDGES, "row", 1, 3); // middle column
    expect(edgesForChild(parent, "col", 0, 2)).toBe(EDGE_TOP);
  });
});

describe("edgeRadius", () => {
  it("rounds all four corners for a lone pane", () => {
    expect(edgeRadius(ALL_EDGES)).toBe(`${R} ${R} ${R} ${R}`);
  });

  it("rounds only the corners where two outer sides meet", () => {
    // Left column of a row split: outer on top, left and bottom.
    expect(edgeRadius(EDGE_TOP | EDGE_LEFT | EDGE_BOTTOM)).toBe(`${R} 0px 0px ${R}`);
    // Bottom-right pane of a 2x2 grid.
    expect(edgeRadius(EDGE_BOTTOM | EDGE_RIGHT)).toBe(`0px 0px ${R} 0px`);
  });

  it("leaves an interior pane square", () => {
    expect(edgeRadius(0)).toBe("0px 0px 0px 0px");
    // A single outer side is not a corner.
    expect(edgeRadius(EDGE_TOP)).toBe("0px 0px 0px 0px");
  });
});
