/**
 * Pure helpers for keyboard block navigation.
 *
 * Block ids are ordered oldest → newest (same order as BlockTracker.blocks).
 * "Previous" moves toward older blocks (Up); "next" toward newer (Down).
 * Ends clamp — no wrap.
 */

export type BlockNavAction = "selectLast" | "prev" | "next";

export interface BlockNavigationState {
  busy: boolean;
  exited: boolean;
  hasAgentUi: boolean;
}

/** Block navigation is safe only while the shell owns an idle PTY. */
export function canNavigateBlocks(state: BlockNavigationState): boolean {
  return !state.busy && !state.exited && !state.hasAgentUi;
}

/**
 * Compute the block id to select after a navigation action.
 * Empty list → null (no-op). No selection + prev/next → last (start at newest).
 */
export function nextBlockSelection(
  ids: readonly number[],
  selectedId: number | null,
  action: BlockNavAction,
): number | null {
  if (ids.length === 0) return null;

  if (action === "selectLast") {
    return ids[ids.length - 1]!;
  }

  if (selectedId === null) {
    return ids[ids.length - 1]!;
  }

  const idx = ids.indexOf(selectedId);
  if (idx < 0) {
    return ids[ids.length - 1]!;
  }

  if (action === "prev") {
    return ids[Math.max(0, idx - 1)]!;
  }

  // next
  return ids[Math.min(ids.length - 1, idx + 1)]!;
}

/** Index of selected id in the list, or -1. */
export function selectionIndex(ids: readonly number[], selectedId: number | null): number {
  if (selectedId === null) return -1;
  return ids.indexOf(selectedId);
}
