/**
 * Visual cursor policy for terminal programs that repaint their own interface.
 *
 * Codex briefly leaves the hardware cursor on its animated status or footer
 * line and corrects it to the composer on the next render tick. A row change or
 * a large horizontal jump is therefore treated as provisional; movement by one
 * or two columns while typing remains immediate.
 */

/** Longer than the largest status → composer gap in the captured Codex stream. */
export const CURSOR_SETTLE_MS = 32;

export interface CursorPosition {
  row: number;
  column: number;
}

export function cursorMoveNeedsSettling(
  stable: CursorPosition | null,
  next: CursorPosition,
): boolean {
  if (stable === null || next.row !== stable.row) return true;
  // Two cells keeps full-width characters responsive while still catching the
  // large jump Codex emits from the composer to its footer/path text.
  return Math.abs(next.column - stable.column) > 2;
}

export interface CursorSettler {
  /** Replace a provisional position or paint a stable one immediately. */
  schedule(position: CursorPosition, paint: () => void, force?: boolean): void;
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
  let stable: CursorPosition | null = null;

  function cancel(): void {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  }

  return {
    schedule(position, paint, force = false) {
      cancel();
      if (!force && !cursorMoveNeedsSettling(stable, position)) {
        stable = position;
        paint();
        return;
      }

      timer = setTimer(() => {
        timer = undefined;
        stable = position;
        paint();
      }, CURSOR_SETTLE_MS);
    },
    cancel,
  };
}
