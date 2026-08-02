import { leaves } from "./layout";
import type { AgentStatus } from "./agents/types";
import type { Tab } from "./types";

/**
 * One terminal in the fullscreen switcher. Zooming hides every other pane, so
 * the rail is the only place left that says what else is open — it therefore
 * carries the whole window, not just the visible tab.
 */
export interface ZoomRailEntry {
  tabId: string;
  tabTitle: string;
  tabColor: string | null;
  leafId: string;
  termId: string;
  /** 1-based seat inside its own tab, so panes stay nameable when titles repeat. */
  position: number;
  /** Belongs to the tab on screen: choosing it never changes tabs. */
  current: boolean;
}

export interface ZoomRailGroup {
  tabId: string;
  tabTitle: string;
  tabColor: string | null;
  current: boolean;
  entries: ZoomRailEntry[];
}

/**
 * Every open terminal, the visible tab first. Pane order inside a tab is the
 * layout's depth-first order — the same one `Ctrl+Shift+]` cycles through, so
 * the list and the keyboard agree about what "next" means.
 */
export function zoomRailEntries(
  tabs: readonly Tab[],
  activeTabId: string,
  colorFor: (tab: Tab) => string | null = (tab) => tab.color ?? null,
): ZoomRailEntry[] {
  const ordered = [
    ...tabs.filter((tab) => tab.id === activeTabId),
    ...tabs.filter((tab) => tab.id !== activeTabId),
  ];
  return ordered.flatMap((tab) =>
    leaves(tab.root).map((node, index) => ({
      tabId: tab.id,
      tabTitle: tab.title,
      tabColor: colorFor(tab),
      leafId: node.id,
      termId: node.term,
      position: index + 1,
      current: tab.id === activeTabId,
    })),
  );
}

/** Consecutive entries of one tab, so the list can be headed per tab. */
export function groupZoomRail(entries: readonly ZoomRailEntry[]): ZoomRailGroup[] {
  const groups: ZoomRailGroup[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.tabId === entry.tabId) {
      last.entries.push(entry);
      continue;
    }
    groups.push({
      tabId: entry.tabId,
      tabTitle: entry.tabTitle,
      tabColor: entry.tabColor,
      current: entry.current,
      entries: [entry],
    });
  }
  return groups;
}

export type ZoomRailTone = "working" | "waiting" | "running" | "exited" | "done";

export interface ZoomRailStatus {
  tone: ZoomRailTone;
  label: string;
}

/**
 * The one word a row gets. A terminal can be several things at once — an agent
 * waiting on an answer is also busy — so the states are ranked by what the user
 * has to act on first.
 */
export function zoomRailStatus(input: {
  exited: boolean;
  busy: boolean;
  /** Status of the structured agent session, when this terminal runs one. */
  agentStatus: AgentStatus | null;
  /** Unfinished agent work, raw CLI turns included. */
  working: boolean;
  /** Finished while nobody was watching, and still unreviewed. */
  unread?: boolean;
}): ZoomRailStatus | null {
  if (input.exited) return { tone: "exited", label: "exited" };
  if (input.agentStatus === "waiting") return { tone: "waiting", label: "needs you" };
  if (input.working || input.agentStatus === "working" || input.agentStatus === "starting") {
    return { tone: "working", label: "working" };
  }
  if (input.busy) return { tone: "running", label: "running" };
  // Nothing is happening any more, but the result has not been looked at — the
  // same "review me" state the pane outline and the tab dot carry.
  if (input.unread) return { tone: "done", label: "done" };
  return null;
}

/**
 * Rows that carry the tab strip's moving highlight. It marks a turn the user is
 * not watching, which is exactly what the rail is for while one pane owns the
 * whole window.
 */
export function zoomRailShimmers(status: ZoomRailStatus | null): boolean {
  return status?.tone === "working" || status?.tone === "waiting";
}

/** Wrap-around neighbour in the rail, for arrow-key travel through the list. */
export function stepRailIndex(count: number, index: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return step === 1 ? 0 : count - 1;
  return (index + step + count) % count;
}
