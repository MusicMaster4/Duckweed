import { describe, expect, it } from "bun:test";

import { insertBeside, preferredLeaf, removeLeafFromSplit, touchPaneMru } from "./layout";
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

describe("removeLeafFromSplit", () => {
  it("keeps a two-pane owner around its surviving child", () => {
    const left = leaf("left");
    const right = leaf("right");
    const root = row(left, right);

    expect(removeLeafFromSplit(root, "left", "split")).toEqual({
      ...root,
      children: [right],
      sizes: [1],
    });
  });

  it("only removes from the specified owner split", () => {
    const nested: LayoutNode = {
      kind: "split",
      id: "nested",
      dir: "col",
      children: [leaf("top"), leaf("bottom")],
      sizes: [0.5, 0.5],
    };
    const right = leaf("right");
    const root: LayoutNode = {
      kind: "split",
      id: "root",
      dir: "row",
      children: [nested, right],
      sizes: [0.5, 0.5],
    };

    expect(removeLeafFromSplit(root, "top", "nested")).toEqual({
      ...root,
      children: [
        {
          ...nested,
          children: [leaf("bottom")],
          sizes: [1],
        },
        right,
      ],
    });
  });

  it("reuses a retained one-pane owner for a split on either axis", () => {
    const existing = leaf("existing");
    const retained: LayoutNode = {
      kind: "split",
      id: "retained",
      dir: "row",
      children: [existing],
      sizes: [1],
    };
    const incoming = leaf("incoming");

    expect(insertBeside(retained, "existing", incoming, "bottom")).toEqual({
      ...retained,
      dir: "col",
      children: [existing, incoming],
      sizes: [0.5, 0.5],
    });
  });
});
