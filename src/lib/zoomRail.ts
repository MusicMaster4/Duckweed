import { leaves } from "./layout";
import type { AgentStatus } from "./agents/types";
import type { LayoutNode, Tab } from "./types";

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
  /** Kept at the top of its tab, the way a pinned tab keeps the left of the strip. */
  pinned: boolean;
}

export interface ZoomRailGroup {
  tabId: string;
  tabTitle: string;
  tabColor: string | null;
  current: boolean;
  entries: ZoomRailEntry[];
}

/**
 * Every open terminal, tabs in strip order. The list never re-sorts itself
 * around whichever tab is on screen: the switcher is a map of the window, and
 * a map that rearranges itself as you look at it is no map. Moving a tab in
 * the strip moves its terminals here with it.
 *
 * Pane order inside a tab is the layout's depth-first order — the same one
 * `Ctrl+Shift+]` cycles through, so the list and the keyboard agree about what
 * "next" means. Pinned terminals rise to the top of their own tab and hold
 * that spot; their seat number still says which slot they occupy.
 */
export function zoomRailEntries(
  tabs: readonly Tab[],
  activeTabId: string,
  colorFor: (tab: Tab) => string | null = (tab) => tab.color ?? null,
): ZoomRailEntry[] {
  return tabs.flatMap((tab) => {
    const entries = leaves(tab.root).map((node, index) => ({
      tabId: tab.id,
      tabTitle: tab.title,
      tabColor: colorFor(tab),
      leafId: node.id,
      termId: node.term,
      position: index + 1,
      current: tab.id === activeTabId,
      pinned: node.pinned === true,
    }));
    return [...entries.filter((entry) => entry.pinned), ...entries.filter((entry) => !entry.pinned)];
  });
}

/**
 * Move a terminal into another slot of its own tab, sliding the ones in
 * between — the switcher's drag gesture.
 *
 * The layout keeps its shape: terminals travel between the panes the tree
 * already has, which is the same exchange the "move pane here" drop does. The
 * pin travels with the terminal rather than staying on the slot it left.
 */
export function moveTerminalToSlot(
  root: LayoutNode,
  leafId: string,
  targetLeafId: string,
): LayoutNode {
  const order = leaves(root);
  const from = order.findIndex((node) => node.id === leafId);
  const to = order.findIndex((node) => node.id === targetLeafId);
  if (from < 0 || to < 0 || from === to) return root;

  const moved = order.map((node) => ({ term: node.term, pinned: node.pinned === true }));
  const [carried] = moved.splice(from, 1);
  moved.splice(to, 0, carried);

  let index = 0;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      const next = moved[index++];
      return { ...node, term: next.term, pinned: next.pinned ? true : undefined };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

/** Pin or unpin one terminal; everything else about the layout stays put. */
export function toggleLeafPin(root: LayoutNode, leafId: string): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      return { ...node, pinned: node.pinned === true ? undefined : true };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
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
