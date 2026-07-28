import { describe, expect, test } from "bun:test";

import { nextBlockSelection, selectionIndex } from "./blockNav";

describe("block navigation helpers", () => {
  const ids = [1, 2, 3, 4];

  test("empty block list is a no-op", () => {
    expect(nextBlockSelection([], null, "selectLast")).toBeNull();
    expect(nextBlockSelection([], 1, "prev")).toBeNull();
    expect(nextBlockSelection([], null, "next")).toBeNull();
  });

  test("from no selection → select last", () => {
    expect(nextBlockSelection(ids, null, "selectLast")).toBe(4);
    expect(nextBlockSelection(ids, null, "prev")).toBe(4);
    expect(nextBlockSelection(ids, null, "next")).toBe(4);
  });

  test("prev moves toward older and clamps at first", () => {
    expect(nextBlockSelection(ids, 4, "prev")).toBe(3);
    expect(nextBlockSelection(ids, 3, "prev")).toBe(2);
    expect(nextBlockSelection(ids, 2, "prev")).toBe(1);
    expect(nextBlockSelection(ids, 1, "prev")).toBe(1);
  });

  test("next moves toward newer and clamps at last", () => {
    expect(nextBlockSelection(ids, 1, "next")).toBe(2);
    expect(nextBlockSelection(ids, 2, "next")).toBe(3);
    expect(nextBlockSelection(ids, 3, "next")).toBe(4);
    expect(nextBlockSelection(ids, 4, "next")).toBe(4);
  });

  test("selectLast always picks newest", () => {
    expect(nextBlockSelection(ids, 1, "selectLast")).toBe(4);
    expect(nextBlockSelection(ids, 4, "selectLast")).toBe(4);
  });

  test("stale selected id falls back to last", () => {
    expect(nextBlockSelection(ids, 99, "prev")).toBe(4);
    expect(nextBlockSelection(ids, 99, "next")).toBe(4);
  });

  test("selectionIndex reports position or -1", () => {
    expect(selectionIndex(ids, 3)).toBe(2);
    expect(selectionIndex(ids, null)).toBe(-1);
    expect(selectionIndex(ids, 99)).toBe(-1);
  });
});
