import type { Tab, TabGroup } from "./types";

export function readTabGroup(value: unknown): TabGroup | null {
  if (!value || typeof value !== "object") return null;
  const group = value as Partial<TabGroup>;
  if (typeof group.id !== "string" || !group.id || typeof group.name !== "string") return null;
  return { id: group.id, name: group.name.trim() || "New group", collapsed: group.collapsed === true };
}

/** Keep each group contiguous and pinned tabs outside groups. */
export function arrangeTabGroups(tabs: Tab[]): Tab[] {
  const result = tabs.filter((tab) => tab.pinned).map((tab) => tab.group ? { ...tab, group: null } : tab);
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (!tab.group) result.push(tab);
    else if (!seen.has(tab.group.id)) {
      seen.add(tab.group.id);
      const group = tab.group;
      result.push(...tabs.filter((member) => !member.pinned && member.group?.id === group.id)
        .map((member) => ({ ...member, group })));
    }
  }
  return result;
}

export function assignTabGroup(tabs: Tab[], tabIds: string[], group: TabGroup | null): Tab[] {
  const ids = new Set(tabIds);
  return arrangeTabGroups(tabs.map((tab) => ids.has(tab.id)
    ? { ...tab, group, pinned: group ? false : tab.pinned } : tab));
}

export function updateTabGroup(tabs: Tab[], groupId: string, patch: Partial<Pick<TabGroup, "name" | "collapsed">> | null): Tab[] {
  return tabs.map((tab) => tab.group?.id === groupId
    ? { ...tab, group: patch ? { ...tab.group, ...patch, name: patch.name?.trim() || tab.group.name } : null }
    : tab);
}
