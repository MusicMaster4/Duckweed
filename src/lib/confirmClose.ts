/**
 * In-app close confirmation — promise API + a small store the dialog mounts on.
 *
 * Native OS dialogs look out of place next to the rest of Duckweed; this keeps
 * the prompt inside the app chrome (Warp-style).
 *
 * Process-close prompts can offer "Don't show this again", which flips a
 * preference so the same kind of close goes through without asking. File
 * discard prompts leave that off — losing edits is not a "set and forget" risk.
 */

export interface ConfirmCloseRequest {
  title: string;
  message: string;
  /** Primary action label, e.g. "Yes, close". */
  confirmLabel: string;
  /**
   * When true, the dialog shows "Don't show this again", and if the user has
   * already opted out this call resolves true without opening the UI.
   */
  allowDontShowAgain?: boolean;
}

type Pending = {
  request: ConfirmCloseRequest;
  resolve: (ok: boolean) => void;
};

let pending: Pending | null = null;
const listeners = new Set<() => void>();

/** Prefer showing the prompt (Warp default). App loads/saves this via persist. */
let confirmEnabled = true;
const prefListeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

function notifyPref(): void {
  for (const cb of prefListeners) cb();
}

/** Whether process-close prompts should appear (settings + "don't show again"). */
export function isConfirmCloseRunningEnabled(): boolean {
  return confirmEnabled;
}

export function setConfirmCloseRunningEnabled(value: boolean): void {
  if (confirmEnabled === value) return;
  confirmEnabled = value;
  notifyPref();
}

export function subscribeConfirmClosePref(cb: () => void): () => void {
  prefListeners.add(cb);
  return () => {
    prefListeners.delete(cb);
  };
}

/** Show the close-confirmation dialog. Resolves true if the user confirms. */
export function confirmCloseRunning(request: ConfirmCloseRequest): Promise<boolean> {
  if (request.allowDontShowAgain && !confirmEnabled) {
    return Promise.resolve(true);
  }

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

/**
 * Resolve the open prompt. When `dontShowAgain` is true and the request
 * allowed it, future process-close prompts are skipped until settings re-enable them.
 */
export function answerConfirmClose(ok: boolean, dontShowAgain = false): void {
  if (!pending) return;
  const { resolve, request } = pending;
  pending = null;
  notify();
  if (ok && dontShowAgain && request.allowDontShowAgain) {
    setConfirmCloseRunningEnabled(false);
  }
  resolve(ok);
}

export function subscribeConfirmClose(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
