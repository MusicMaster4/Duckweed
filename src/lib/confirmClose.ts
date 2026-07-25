/**
 * In-app close confirmation — promise API + a small store the dialog mounts on.
 *
 * Native OS dialogs look out of place next to the rest of Duckweed; this keeps
 * the prompt inside the app chrome (Warp-style).
 */

export interface ConfirmCloseRequest {
  title: string;
  message: string;
  /** Primary action label, e.g. "Yes, close". */
  confirmLabel: string;
}

type Pending = {
  request: ConfirmCloseRequest;
  resolve: (ok: boolean) => void;
};

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

/** Show the close-confirmation dialog. Resolves true if the user confirms. */
export function confirmCloseRunning(request: ConfirmCloseRequest): Promise<boolean> {
  // A second prompt while one is open cancels the first (should be rare).
  if (pending) {
    const prev = pending;
    pending = null;
    prev.resolve(false);
  }
  return new Promise((resolve) => {
    pending = { request, resolve };
    notify();
  });
}

export function getConfirmClose(): ConfirmCloseRequest | null {
  return pending?.request ?? null;
}

export function answerConfirmClose(ok: boolean): void {
  if (!pending) return;
  const { resolve } = pending;
  pending = null;
  notify();
  resolve(ok);
}

export function subscribeConfirmClose(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
