/**
 * Visual cursor policy for terminal programs that repaint their own interface.
 *
 * Codex briefly leaves the hardware cursor on its animated status line and
 * corrects it to the composer on the next render tick. Moving upward is
 * therefore treated as provisional; same-row movement (typing) and movement
 * toward the bottom (the usual composer direction) remain immediate.
 */

/** Longer than the largest status → composer gap in the captured Codex stream. */
export const CURSOR_SETTLE_MS = 32;

export function cursorMoveNeedsSettling(stableRow: number | null, nextRow: number): boolean {
  return stableRow === null || nextRow < stableRow;
}

export interface CursorSettler {
  /** Replace a provisional position or paint a stable one immediately. */
  schedule(row: number, paint: () => void, force?: boolean): void;
  /** Prevent a delayed cursor from appearing after blur, scroll, or disposal. */
  cancel(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** Testable timing controller shared by the real terminal and replay tests. */
export function createCursorSettler(
  setTimer: (callback: () => void, delay: number) => Timer = setTimeout,
  clearTimer: (timer: Timer) => void = clearTimeout,
): CursorSettler {
  let timer: Timer | undefined;
  let stableRow: number | null = null;

  function cancel(): void {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  return {
    schedule(row, paint, force = false) {
      cancel();
      if (!force && !cursorMoveNeedsSettling(stableRow, row)) {
        stableRow = row;
        paint();
        return;
      }

      timer = setTimer(() => {
        timer = undefined;
        stableRow = row;
        paint();
      }, CURSOR_SETTLE_MS);
    },
    cancel,
  };
}
