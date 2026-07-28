import { describe, expect, it } from "bun:test";

import { preferredLeaf, touchPaneMru } from "./layout";
import type { LayoutNode } from "./types";

function leaf(id: string): LayoutNode {
  return { kind: "leaf", id, term: `t-${id}` };
}

function row(...children: LayoutNode[]): LayoutNode {
  return {
    kind: "split",
    id: "split",
    dir: "row",
    children,
    sizes: children.map(() => 1 / children.length),
  };
}

describe("preferredLeaf", () => {
  it("returns the first preferred leaf that still exists", () => {
    const root = row(leaf("a"), leaf("b"), leaf("c"));
    expect(preferredLeaf(root, ["gone", "c", "a"])).toBe("c");
  });

  it("falls back to depth-first order when nothing preferred remains", () => {
    const root = row(leaf("a"), leaf("b"));
    expect(preferredLeaf(root, ["x", "y"])).toBe("a");
  });
});

describe("touchPaneMru", () => {
  it("puts the new active leaf first and keeps prior history", () => {
    const root = row(leaf("a"), leaf("b"), leaf("c"));
    expect(touchPaneMru(["a", "b"], "c", root)).toEqual(["c", "a", "b"]);
  });

  it("seeds the previous active leaf when history was empty", () => {
    const root = row(leaf("a"), leaf("b"));
    expect(touchPaneMru([], "b", root, "a")).toEqual(["b", "a"]);
  });

  it("drops leaves that no longer exist in the tree", () => {
    const root = row(leaf("a"), leaf("c"));
    expect(touchPaneMru(["b", "a", "c"], "c", root)).toEqual(["c", "a"]);
  });
});
