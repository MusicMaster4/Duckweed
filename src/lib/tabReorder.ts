/**
 * The geometry behind dragging a tab along the strip.
 *
 * The strip is measured once, when the drag starts, and never again: the tabs
 * are being pushed around by transforms while the gesture runs, so measuring
 * them live would feed the gesture its own output. Everything here works off
 * that frozen layout, which makes it plain arithmetic — and testable.
 */

/** Where a tab sat when the drag began. */
export interface TabSlot {
  left: number;
  width: number;
}

/** Clamp the dragged tab so it can reach the far edges of the strip, no further. */
export function clampLeft(slots: TabSlot[], from: number, wanted: number): number {
  const last = slots[slots.length - 1];
  const minLeft = slots[0].left;
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
 */
export function dropIndex(slots: TabSlot[], from: number, left: number): number {
  let to = 0;
  let best = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const gap = Math.abs(left - restingLeft(slots, from, i));
    if (gap < best) {
      best = gap;
      to = i;
    }
  }
  return to;
}

/** How far tab `i` steps aside while the dragged tab travels from `from` to `to`. */
export function slotShift(i: number, from: number, to: number, width: number): number {
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
