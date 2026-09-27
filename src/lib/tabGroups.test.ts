import { describe, expect, test } from "bun:test";
import { arrangeTabGroups, assignTabGroup, readTabGroup, updateTabGroup } from "./tabGroups";
import type { Tab, TabGroup } from "./types";

const group: TabGroup = { id: "g", name: "Project", collapsed: false };
const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({
  id, title: id, root: { kind: "leaf", id, term: id }, activeLeaf: id,
  zoomedLeaf: null, project: null, ...extra,
});

describe("tab groups", () => {
  test("adding a distant tab keeps the group contiguous without losing tabs", () => {
    const original = [tab("a", { group }), tab("b"), tab("c")];
    const result = assignTabGroup(original, ["c"], group);
    expect(result.map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(original[2].group).toBeUndefined();
  });
  test("group all also unpins members and preserves their order", () => {
    const tabs = [tab("a", { pinned: true }), tab("b"), tab("c")];
    const result = assignTabGroup(tabs, tabs.map((t) => t.id), group);
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result.every((t) => !t.pinned && t.group?.id === "g")).toBe(true);
  });
  test("rename and collapse affect all members but leave other groups intact", () => {
    const tabs = [tab("a", { group }), tab("b", { group }), tab("c", { group: { ...group, id: "other" } })];
    const result = updateTabGroup(tabs, "g", { name: "  Release  ", collapsed: true });
    expect(result.slice(0, 2).map((t) => t.group)).toEqual([
      { ...group, name: "Release", collapsed: true }, { ...group, name: "Release", collapsed: true },
    ]);
    expect(result[2]).toBe(tabs[2]);
    expect(updateTabGroup(result, "g", { name: " " })[0].group?.name).toBe("Release");
  });
  test("removing and ungrouping never closes terminals", () => {
    const tabs = [tab("a", { group }), tab("b", { group }), tab("c")];
    const removed = assignTabGroup(tabs, ["a"], null);
    expect(removed.find((t) => t.id === "a")?.group).toBeNull();
    expect(removed.find((t) => t.id === "b")?.group).toEqual(group);
    const result = updateTabGroup(tabs, "g", null);
    expect(result.map((t) => t.root)).toEqual(tabs.map((t) => t.root));
    expect(result.every((t) => !t.group)).toBe(true);
  });
  test("pinning takes a tab outside its group", () => {
    const result = arrangeTabGroups([tab("a", { group }), tab("b", { group, pinned: true }), tab("c", { group })]);
    expect(result.map((t) => t.id)).toEqual(["b", "a", "c"]);
    expect(result[0].group).toBeNull();
  });
  test("saved groups survive JSON and reject malformed or legacy data", () => {
    expect(readTabGroup(JSON.parse(JSON.stringify({ ...group, collapsed: true })))).toEqual({ ...group, collapsed: true });
    for (const invalid of [undefined, null, {}, "g", { id: 3, name: "Bad" }]) expect(readTabGroup(invalid)).toBeNull();
    expect(readTabGroup({ id: "g", name: " ", collapsed: "yes" })).toEqual({ ...group, name: "New group" });
  });
});
