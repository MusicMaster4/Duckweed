import { afterEach, describe, expect, test } from "bun:test";

import {
  DONE_RETENTION_MS,
  becameAllClear,
  hoursUntilSweep,
  openCount,
  ordered,
  resetForTests,
  sweep,
  type ChecklistItem,
} from "./checklist";

afterEach(() => resetForTests());

const item = (id: string, doneAt: number | null = null, createdAt = 0): ChecklistItem => ({
  id,
  text: id,
  createdAt,
  doneAt,
});

describe("sweep", () => {
  const now = 10 * DONE_RETENTION_MS;

  test("keeps open items no matter how old they are", () => {
    const lists = { tab1: [item("a", null, 0)] };
    expect(sweep(lists, now)).toBe(lists);
  });

  test("keeps checked items until the day is up", () => {
    const lists = { tab1: [item("a", now - DONE_RETENTION_MS + 1_000)] };
    expect(sweep(lists, now)).toBe(lists);
  });

  test("drops checked items once the day has passed", () => {
    const lists = {
      tab1: [item("stale", now - DONE_RETENTION_MS), item("fresh", now - 1_000), item("open")],
    };
    expect(sweep(lists, now).tab1.map((i) => i.id)).toEqual(["fresh", "open"]);
  });

  test("removes a list that swept itself empty rather than leaving a husk", () => {
    const swept = sweep({ tab1: [item("stale", now - DONE_RETENTION_MS)] }, now);
    expect(Object.keys(swept)).toEqual([]);
  });

  test("returns the same object when nothing changed, so callers can skip a write", () => {
    const lists = { tab1: [item("a")], tab2: [item("b", now)] };
    expect(sweep(lists, now)).toBe(lists);
  });

  test("sweeps each tab independently", () => {
    const swept = sweep(
      { tab1: [item("a"), item("gone", now - DONE_RETENTION_MS)], tab2: [item("b")] },
      now,
    );
    expect(swept.tab1.map((i) => i.id)).toEqual(["a"]);
    expect(swept.tab2.map((i) => i.id)).toEqual(["b"]);
  });
});

describe("ordered", () => {
  test("open items keep insertion order, ahead of everything finished", () => {
    const rows = ordered([item("done", 500), item("first"), item("second")]);
    expect(rows.map((i) => i.id)).toEqual(["first", "second", "done"]);
  });

  test("finished items show the most recently checked first", () => {
    const rows = ordered([item("old", 100), item("new", 900), item("mid", 500)]);
    expect(rows.map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("hoursUntilSweep", () => {
  test("counts whole hours left on a checked item", () => {
    expect(hoursUntilSweep(item("a", 0), 2 * 60 * 60 * 1000)).toBe(22);
  });

  test("is zero inside the last hour and never negative", () => {
    expect(hoursUntilSweep(item("a", 0), DONE_RETENTION_MS - 1)).toBe(0);
    expect(hoursUntilSweep(item("a", 0), DONE_RETENTION_MS * 3)).toBe(0);
  });

  test("is zero for an open item, which is not on the clock at all", () => {
    expect(hoursUntilSweep(item("a", null), 5_000)).toBe(0);
  });
});

describe("becameAllClear", () => {
  test("is true only when open count drops to zero with items still present", () => {
    expect(becameAllClear(1, 0, 1)).toBe(true);
    expect(becameAllClear(3, 0, 5)).toBe(true);
  });

  test("stays false on mount, empty list, and non-edge re-renders", () => {
    // Already clear (mount / tab switch onto finished list).
    expect(becameAllClear(0, 0, 2)).toBe(false);
    // Empty list is the blank state, not a celebration.
    expect(becameAllClear(0, 0, 0)).toBe(false);
    expect(becameAllClear(1, 0, 0)).toBe(false);
    // Still has open work, or open count rose / stayed.
    expect(becameAllClear(2, 1, 3)).toBe(false);
    expect(becameAllClear(0, 1, 1)).toBe(false);
    expect(becameAllClear(1, 1, 1)).toBe(false);
  });
});

describe("openCount", () => {
  test("counts only open work in the requested tab", () => {
    resetForTests({
      tab1: [item("open-a"), item("done", Date.now())],
      tab2: [item("open-b"), item("open-c")],
    });

    expect(openCount("tab1")).toBe(1);
    expect(openCount("tab2")).toBe(2);
    expect(openCount("missing-tab")).toBe(0);
  });
});
