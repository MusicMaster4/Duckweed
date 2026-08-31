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
  let pendingPosition: CursorPosition | null = null;
  let pendingPaint: (() => void) | null = null;

  function cancel(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    pendingPosition = null;
    pendingPaint = null;
  }

  return {
    schedule(position, paint, force = false) {
      const needsSettling = force || cursorMoveNeedsSettling(stable, position);
      if (!needsSettling) {
        cancel();
        stable = position;
        paint();
        return;
      }

      pendingPosition = position;
      pendingPaint = paint;

      // Keep the first deadline for a provisional move. A long wrapped prompt
      // can produce a new row/column on every keystroke; restarting this timer
      // for each update starves it while the user is typing and leaves the
      // painted cursor several lines behind the actual terminal cursor. Later
      // provisional updates replace the target, but still settle no later than
      // CURSOR_SETTLE_MS after the jump began.
      if (timer !== undefined && !force) return;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => {
        timer = undefined;
        const nextPosition = pendingPosition;
        const nextPaint = pendingPaint;
        pendingPosition = null;
        pendingPaint = null;
        if (!nextPosition || !nextPaint) return;
        stable = nextPosition;
        nextPaint();
      }, CURSOR_SETTLE_MS);
    },
    cancel,
  };
}
