/**
 * The geometry behind dragging a tab along the strip.
 *
 * The strip is measured once, when the drag starts, and never again: the tabs
 * are being pushed around by transforms while the gesture runs, so measuring
 * them live would feed the gesture its own output. Everything here works off
 * that frozen layout, which makes it plain arithmetic — and testable.
 *
 * Pinned tabs occupy a fixed block on the left. Unpinned tabs can only reorder
 * among themselves; `minIndex` (count of pinned tabs) clamps every calculation.
 *
 * The Settings tab is a strip citizen too (`SETTINGS_TAB_ID`), but it is not a
 * real terminal tab — helpers below keep its index in sync with the tab list.
 */

/** Stable id for the Settings strip entry (not a real Tab). */
export const SETTINGS_TAB_ID = "__settings__";

/** Where a tab sat when the drag began. */
export interface TabSlot {
  left: number;
  width: number;
}

/**
 * Visual strip order: tab ids with Settings spliced in when open.
 * `settingsIndex` is 0..tabIds.length (inclusive = after every tab).
 */
export function buildStripOrder(
  tabIds: string[],
  settingsOpen: boolean,
  settingsIndex: number,
): string[] {
  if (!settingsOpen) return [...tabIds];
  const order = [...tabIds];
  const idx = Math.min(Math.max(0, settingsIndex), order.length);
  order.splice(idx, 0, SETTINGS_TAB_ID);
  return order;
}

/**
 * Reorder the strip (tabs + optional Settings). Returns the new tab id order
 * and Settings index, or null when nothing should change.
 */
export function applyStripReorder(
  tabIds: string[],
  settingsOpen: boolean,
  settingsIndex: number,
  from: number,
  to: number,
  pinnedCount: number,
): { tabIds: string[]; settingsIndex: number } | null {
  const strip = buildStripOrder(tabIds, settingsOpen, settingsIndex);
  if (from === to || from < 0 || to < 0 || from >= strip.length || to >= strip.length) {
    return null;
  }
  // Pinned tabs (and anything in their block) never move.
  if (from < pinnedCount) return null;
  const clampedTo = Math.max(to, pinnedCount);
  if (from === clampedTo) return null;

  const next = [...strip];
  const [moved] = next.splice(from, 1);
  next.splice(clampedTo, 0, moved);

  const newTabIds = next.filter((id) => id !== SETTINGS_TAB_ID);
  const newSettingsIndex = settingsOpen
    ? Math.max(0, next.indexOf(SETTINGS_TAB_ID))
    : settingsIndex;
  return { tabIds: newTabIds, settingsIndex: newSettingsIndex };
}

/** After a terminal tab is closed, keep Settings' index consistent. */
export function adjustSettingsIndexOnClose(
  settingsIndex: number,
  closedTabIndex: number,
): number {
  if (closedTabIndex < settingsIndex) return settingsIndex - 1;
  return settingsIndex;
}

/** After a terminal tab is appended, keep Settings at the end if it was there. */
export function adjustSettingsIndexOnAppend(
  settingsIndex: number,
  previousTabCount: number,
): number {
  return settingsIndex >= previousTabCount ? settingsIndex + 1 : settingsIndex;
}

/** Clamp the dragged tab so it can reach the far edges of the movable range. */
export function clampLeft(
  slots: TabSlot[],
  from: number,
  wanted: number,
  minIndex = 0,
): number {
  const first = slots[Math.min(Math.max(minIndex, 0), slots.length - 1)];
  const last = slots[slots.length - 1];
  const minLeft = first.left;
  const maxLeft = Math.max(minLeft, last.left + last.width - slots[from].width);
  return Math.min(Math.max(wanted, minLeft), maxLeft);
}

/**
 * The index the dragged tab would take if dropped at `left`.
 *
 * Each index has one resting place, and the drag simply picks the nearest —
 * which is symmetrical by construction, and stays right when the dragged tab
 * is wider or narrower than the ones it passes. Comparing the dragged tab's
 * centre against its neighbours' centres instead, as this used to, is not:
 * the clamp that keeps the tab inside the strip stops it exactly on the outer
 * neighbours' midpoints, a hair short of ever swapping with them.
 *
 * `minIndex` keeps unpinned tabs from landing inside the pinned block.
 */
export function dropIndex(
  slots: TabSlot[],
  from: number,
  left: number,
  minIndex = 0,
): number {
  const lo = Math.min(Math.max(minIndex, 0), slots.length - 1);
  let to = lo;
  let best = Infinity;
  for (let i = lo; i < slots.length; i++) {
    const gap = Math.abs(left - restingLeft(slots, from, i));
    if (gap < best) {
      best = gap;
      to = i;
    }
  }
  return to;
}

/**
 * How far tab `i` steps aside while the dragged tab travels from `from` to `to`.
 * Tabs at index < `minIndex` (pinned) never shift.
 */
export function slotShift(
  i: number,
  from: number,
  to: number,
  width: number,
  minIndex = 0,
): number {
  if (i < minIndex) return 0;
  if (i > from && i <= to) return -width;
  if (i < from && i >= to) return width;
  return 0;
}

/** The left edge the dragged tab comes to rest on at index `to`. */
export function restingLeft(slots: TabSlot[], from: number, to: number): number {
  const target = slots[to];
  if (to <= from) return target.left;
  return target.left + target.width - slots[from].width;
}
