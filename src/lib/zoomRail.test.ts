import { describe, expect, test } from "bun:test";

import type { Tab } from "./types";
import {
  groupZoomRail,
  stepRailIndex,
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
  test("leads with the visible tab so the zoomed pane's siblings come first", () => {
    const entries = zoomRailEntries(tabs, "tab-duckweed");

    expect(entries.map((entry) => entry.leafId)).toEqual([
      "leaf-agent",
      "leaf-shell",
      "leaf-vps",
    ]);
    expect(entries.map((entry) => entry.current)).toEqual([true, true, false]);
  });

  test("numbers panes inside their own tab, in layout order", () => {
    const entries = zoomRailEntries(tabs, "tab-duckweed");

    expect(entries.map((entry) => entry.position)).toEqual([1, 2, 1]);
    expect(entries.map((entry) => entry.termId)).toEqual([
      "term-agent",
      "term-shell",
      "term-vps",
    ]);
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

    expect(groups.map((group) => group.tabTitle)).toEqual(["Duckweed", "VPS"]);
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[0].current).toBe(true);
    expect(groups[1].current).toBe(false);
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
