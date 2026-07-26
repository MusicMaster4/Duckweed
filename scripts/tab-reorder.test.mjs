import { describe, expect, test } from "bun:test";

import { clampLeft, dropIndex, restingLeft, slotShift } from "../src/lib/tabReorder.ts";

/** Three tabs of `width`, laid out from x = 0 with no gap. */
const strip = (count, width = 100) =>
  Array.from({ length: count }, (_, i) => ({ left: i * width, width }));

/** Drag the tab at `from` so its left edge lands on `left`. */
const drop = (slots, from, left) => dropIndex(slots, from, clampLeft(slots, from, left));

describe("tab reorder geometry", () => {
  test("a tab dragged to the far right lands last", () => {
    const slots = strip(3);
    // The middle tab dragged as far right as the strip allows. This is the
    // case that used to be impossible: the clamp stopped it exactly on the
    // last tab's midpoint, one pixel short of the swap.
    expect(drop(slots, 1, 999)).toBe(2);
  });

  test("a tab dragged to the far left lands first", () => {
    expect(drop(strip(3), 1, -999)).toBe(0);
  });

  test("the two directions swap at the same distance", () => {
    const slots = strip(3);
    // Half a tab either way is the tipping point in both directions.
    expect(drop(slots, 1, 100 + 51)).toBe(2);
    expect(drop(slots, 1, 100 - 51)).toBe(0);
    expect(drop(slots, 1, 100 + 49)).toBe(1);
    expect(drop(slots, 1, 100 - 49)).toBe(1);
  });

  test("a wide tab can still reach either end", () => {
    // Tabs are sized by their titles, so the dragged one is often wider than
    // the ones it passes.
    const slots = [
      { left: 0, width: 60 },
      { left: 60, width: 200 },
      { left: 260, width: 60 },
    ];
    expect(drop(slots, 1, -999)).toBe(0);
    expect(drop(slots, 1, 999)).toBe(2);
  });

  test("the first and last tabs cannot be dragged out of the strip", () => {
    const slots = strip(3);
    expect(clampLeft(slots, 0, -400)).toBe(0);
    expect(clampLeft(slots, 2, 400)).toBe(200);
    expect(drop(slots, 0, -400)).toBe(0);
    expect(drop(slots, 2, 400)).toBe(2);
  });

  test("passed tabs step aside by exactly the dragged tab's width", () => {
    // Dragging 0 → 2 pulls both tabs it passed to the left.
    expect(slotShift(1, 0, 2, 100)).toBe(-100);
    expect(slotShift(2, 0, 2, 100)).toBe(-100);
    // Dragging 2 → 0 pushes them right.
    expect(slotShift(0, 2, 0, 100)).toBe(100);
    expect(slotShift(1, 2, 0, 100)).toBe(100);
    // Tabs the drag never reached stay put.
    expect(slotShift(2, 0, 1, 100)).toBe(0);
    expect(slotShift(0, 1, 2, 100)).toBe(0);
  });

  test("the dragged tab rests in the gap its neighbours opened", () => {
    const slots = [
      { left: 0, width: 60 },
      { left: 60, width: 200 },
      { left: 260, width: 60 },
    ];
    // Moving right, it lands flush with the right edge of the tab it passed,
    // which by then has slid left by the dragged tab's width.
    expect(restingLeft(slots, 1, 2)).toBe(320 - 200);
    // Moving left, it takes the target's left edge outright.
    expect(restingLeft(slots, 1, 0)).toBe(0);
    expect(restingLeft(slots, 1, 1)).toBe(60);
  });
});

describe("pinned tab reorder bounds", () => {
  test("unpinned tabs cannot drop into the pinned block on the left", () => {
    const slots = strip(4);
    // Two pinned tabs at 0 and 1; drag tab 2 left as far as it goes.
    expect(dropIndex(slots, 2, clampLeft(slots, 2, -999, 2), 2)).toBe(2);
    expect(dropIndex(slots, 3, clampLeft(slots, 3, -999, 2), 2)).toBe(2);
  });

  test("clampLeft keeps unpinned tabs right of the pinned block", () => {
    const slots = strip(4);
    // First movable slot is index 2 (left = 200).
    expect(clampLeft(slots, 3, -999, 2)).toBe(200);
    expect(clampLeft(slots, 2, 0, 2)).toBe(200);
  });

  test("pinned tabs never step aside while an unpinned tab is dragged", () => {
    // minIndex = 2 → indices 0 and 1 stay put regardless of from/to.
    expect(slotShift(0, 3, 2, 100, 2)).toBe(0);
    expect(slotShift(1, 3, 2, 100, 2)).toBe(0);
    // Movable neighbour still shifts.
    expect(slotShift(2, 3, 2, 100, 2)).toBe(100);
  });
});
