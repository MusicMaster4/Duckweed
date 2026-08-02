import { describe, expect, test } from "bun:test";

import { leaves, swapLeaves } from "./layout";
import type { LayoutNode, Tab } from "./types";
import {
  groupZoomRail,
  moveTerminalToSlot,
  nearestZoomRailSlot,
  previewZoomRailOrder,
  stepRailIndex,
  toggleLeafPin,
  zoomRailEntries,
  zoomRailShimmers,
  zoomRailStatus,
} from "./zoomRail";

const tabs: Tab[] = [
  {
    id: "tab-vps",
    title: "VPS",
    root: { kind: "leaf", id: "leaf-vps", term: "term-vps" },
    activeLeaf: "leaf-vps",
    zoomedLeaf: null,
    project: null,
    color: "amber",
  },
  {
    id: "tab-duckweed",
    title: "Duckweed",
    root: {
      kind: "split",
      id: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "leaf", id: "leaf-agent", term: "term-agent" },
        { kind: "leaf", id: "leaf-shell", term: "term-shell" },
      ],
    },
    activeLeaf: "leaf-agent",
    zoomedLeaf: "leaf-agent",
    project: null,
  },
];

describe("fullscreen rail entries", () => {
  test("keeps tabs in strip order, whichever one is on screen", () => {
    const asListed = zoomRailEntries(tabs, "tab-vps").map((entry) => entry.leafId);

    // Selecting a terminal in the second tab must not hoist that tab: the
    // switcher is a map of the window, and the map does not move.
    expect(zoomRailEntries(tabs, "tab-duckweed").map((entry) => entry.leafId)).toEqual(asListed);
    expect(asListed).toEqual(["leaf-vps", "leaf-agent", "leaf-shell"]);
  });

  test("marks the tab on screen without moving it", () => {
    const entries = zoomRailEntries(tabs, "tab-duckweed");

    expect(entries.map((entry) => entry.current)).toEqual([false, true, true]);
  });

  test("numbers panes inside their own tab, in layout order", () => {
    const entries = zoomRailEntries(tabs, "tab-duckweed");

    expect(entries.map((entry) => entry.position)).toEqual([1, 1, 2]);
    expect(entries.map((entry) => entry.termId)).toEqual([
      "term-vps",
      "term-agent",
      "term-shell",
    ]);
  });

  test("a pinned terminal holds the top of its own tab", () => {
    const pinned = tabs.map((tab) =>
      tab.id === "tab-duckweed" ? { ...tab, root: toggleLeafPin(tab.root, "leaf-shell") } : tab,
    );
    const entries = zoomRailEntries(pinned, "tab-duckweed");

    expect(entries.map((entry) => entry.leafId)).toEqual([
      "leaf-vps",
      "leaf-shell",
      "leaf-agent",
    ]);
    // The seat still names the slot the terminal occupies, not its row.
    expect(entries.map((entry) => entry.position)).toEqual([1, 2, 1]);
    expect(entries.map((entry) => entry.pinned)).toEqual([false, true, false]);
  });

  test("resolves the tab accent through the caller, not the stored id", () => {
    const entries = zoomRailEntries(tabs, "tab-vps", (tab) =>
      tab.color ? "#f0c052" : null,
    );

    expect(entries[0].tabColor).toBe("#f0c052");
    expect(entries[1].tabColor).toBeNull();
  });

  test("groups consecutive panes under their tab", () => {
    const groups = groupZoomRail(zoomRailEntries(tabs, "tab-duckweed"));

    expect(groups.map((group) => group.tabTitle)).toEqual(["VPS", "Duckweed"]);
    expect(groups[1].entries).toHaveLength(2);
    expect(groups[1].current).toBe(true);
    expect(groups[0].current).toBe(false);
  });
});

describe("fullscreen rail reordering", () => {
  const row = (...terms: string[]): LayoutNode => ({
    kind: "split",
    id: "split",
    dir: "row",
    sizes: terms.map(() => 1 / terms.length),
    children: terms.map((term) => ({ kind: "leaf", id: `leaf-${term}`, term })),
  });
  const order = (root: LayoutNode) => leaves(root).map((node) => node.term);

  test("previews the exact committed slot in both directions", () => {
    const entries = zoomRailEntries(
      [{ ...tabs[1], root: row("a", "b", "c", "d") }],
      "tab-duckweed",
    );
    const ids = (list: readonly { leafId: string }[]) => list.map((entry) => entry.leafId);

    expect(ids(previewZoomRailOrder(entries, "leaf-a", "leaf-c"))).toEqual([
      "leaf-b",
      "leaf-c",
      "leaf-a",
      "leaf-d",
    ]);
    expect(ids(previewZoomRailOrder(entries, "leaf-d", "leaf-a"))).toEqual([
      "leaf-d",
      "leaf-a",
      "leaf-b",
      "leaf-c",
    ]);
  });

  test("tracks every downward slot and clamps beyond the list", () => {
    const centers = [100, 160, 220, 280];

    expect(nearestZoomRailSlot(centers, 100)).toBe(0);
    expect(nearestZoomRailSlot(centers, 175)).toBe(1);
    expect(nearestZoomRailSlot(centers, 225)).toBe(2);
    expect(nearestZoomRailSlot(centers, 400)).toBe(3);
  });

  test("tracks upward slots and clamps above the list", () => {
    const centers = [100, 160, 220, 280];

    expect(nearestZoomRailSlot(centers, 265)).toBe(3);
    expect(nearestZoomRailSlot(centers, 205)).toBe(2);
    expect(nearestZoomRailSlot(centers, 145)).toBe(1);
    expect(nearestZoomRailSlot(centers, 0)).toBe(0);
    expect(nearestZoomRailSlot([], 100)).toBe(-1);
  });

  test("dropping a terminal further down settles it in that slot", () => {
    const moved = moveTerminalToSlot(row("a", "b", "c", "d"), "leaf-a", "leaf-c");

    expect(order(moved)).toEqual(["b", "c", "a", "d"]);
  });

  test("dropping one further up settles it before the card it landed on", () => {
    const moved = moveTerminalToSlot(row("a", "b", "c", "d"), "leaf-d", "leaf-b");

    expect(order(moved)).toEqual(["a", "d", "b", "c"]);
  });

  test("the layout keeps its shape: only the terminals travel", () => {
    const before = row("a", "b", "c");
    const moved = moveTerminalToSlot(before, "leaf-c", "leaf-a");

    expect(leaves(moved).map((node) => node.id)).toEqual(leaves(before).map((node) => node.id));
    expect(moved.kind === "split" && moved.sizes).toEqual(
      before.kind === "split" ? before.sizes : [],
    );
  });

  test("a pin rides along with the terminal it was put on", () => {
    const pinned = toggleLeafPin(row("a", "b", "c"), "leaf-a");
    const moved = moveTerminalToSlot(pinned, "leaf-a", "leaf-c");

    expect(leaves(moved).map((node) => [node.term, node.pinned === true])).toEqual([
      ["b", false],
      ["c", false],
      ["a", true],
    ]);
  });

  test("a pin rides along when panes are swapped through the grid", () => {
    const pinned = toggleLeafPin(row("a", "b"), "leaf-a");
    const moved = swapLeaves(pinned, "leaf-a", "leaf-b");

    expect(leaves(moved).map((node) => [node.term, node.pinned === true])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  test("dropping a card on itself, or on a pane that is gone, changes nothing", () => {
    const before = row("a", "b");

    expect(moveTerminalToSlot(before, "leaf-a", "leaf-a")).toBe(before);
    expect(moveTerminalToSlot(before, "leaf-a", "leaf-gone")).toBe(before);
  });

  test("pinning toggles, and leaves every other pane alone", () => {
    const once = toggleLeafPin(row("a", "b"), "leaf-b");
    expect(leaves(once).map((node) => node.pinned === true)).toEqual([false, true]);

    const twice = toggleLeafPin(once, "leaf-b");
    expect(leaves(twice).map((node) => node.pinned === true)).toEqual([false, false]);
  });
});

describe("fullscreen rail status", () => {
  const resting = { exited: false, busy: false, agentStatus: null, working: false };

  test("an idle shell says nothing at all", () => {
    expect(zoomRailStatus(resting)).toBeNull();
  });

  test("an agent waiting on the user outranks the process it is running", () => {
    expect(zoomRailStatus({ ...resting, busy: true, agentStatus: "waiting", working: true }))
      .toEqual({ tone: "waiting", label: "needs you" });
  });

  test("a raw agent turn reads as working without a structured session", () => {
    expect(zoomRailStatus({ ...resting, busy: true, working: true })).toEqual({
      tone: "working",
      label: "working",
    });
  });

  test("a plain child process is running, not working", () => {
    expect(zoomRailStatus({ ...resting, busy: true })).toEqual({
      tone: "running",
      label: "running",
    });
  });

  test("work that finished unwatched still asks to be reviewed", () => {
    expect(zoomRailStatus({ ...resting, unread: true })).toEqual({
      tone: "done",
      label: "done",
    });
  });

  test("a live process outranks the review marker left by the last one", () => {
    expect(zoomRailStatus({ ...resting, busy: true, unread: true })).toEqual({
      tone: "running",
      label: "running",
    });
  });

  test("a dead shell reports that first, whatever it was doing", () => {
    expect(zoomRailStatus({ exited: true, busy: true, agentStatus: "working", working: true }))
      .toEqual({ tone: "exited", label: "exited" });
  });

  test("only unfinished agent work carries the shimmer", () => {
    expect(zoomRailShimmers(zoomRailStatus({ ...resting, working: true }))).toBe(true);
    expect(zoomRailShimmers(zoomRailStatus({ ...resting, agentStatus: "waiting" }))).toBe(true);
    expect(zoomRailShimmers(zoomRailStatus({ ...resting, busy: true }))).toBe(false);
    expect(zoomRailShimmers(zoomRailStatus(resting))).toBe(false);
  });
});

describe("fullscreen rail keyboard travel", () => {
  test("wraps around both ends", () => {
    expect(stepRailIndex(3, 2, 1)).toBe(0);
    expect(stepRailIndex(3, 0, -1)).toBe(2);
  });

  test("an unfocused list enters from the end the arrow points at", () => {
    expect(stepRailIndex(3, -1, 1)).toBe(0);
    expect(stepRailIndex(3, -1, -1)).toBe(2);
  });

  test("an empty list has nowhere to go", () => {
    expect(stepRailIndex(0, -1, 1)).toBe(-1);
  });
});
