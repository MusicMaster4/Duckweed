/** Coalesce change events without discarding a completed read. */
export function createRefreshQueue<T>(
  read: () => Promise<T>,
  accept: (value: T) => void,
  reject: (error: unknown) => void,
  timeoutMs = 60_000,
) {
  let stopped = false;
  let running = false;
  let pending = false;
  let revision = 0;
  let cancelTimer: (() => void) | undefined;

  const refresh = () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const startedRevision = revision;
    let settled = false;
    const timer = setTimeout(() => {
      finish(undefined, new Error("Reading changes timed out. Click refresh to try again."));
    }, timeoutMs);
    cancelTimer = () => clearTimeout(timer);

    function finish(value?: T, error?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTimer = undefined;
      running = false;
      if (stopped) return;
      if (startedRevision !== revision) {
        if (pending) {
          pending = false;
          refresh();
        }
        return;
      }
      if (error !== undefined) {
        // Drop the queued retry after a failure; a new refresh can try again.
        pending = false;
        reject(error);
      } else {
        accept(value as T);
        if (pending) {
          pending = false;
          refresh();
        }
      }
    }

    void Promise.resolve().then(() => stopped ? undefined : read()).then(
      (value) => { if (!stopped) finish(value); },
      (error: unknown) => finish(undefined, error ?? new Error("Could not read changes.")),
    );
  };

  return {
    refresh,
    /** A completed mutation makes any older in-flight snapshot unusable. */
    invalidate() {
      revision++;
      refresh();
    },
    stop() {
      stopped = true;
      pending = false;
      cancelTimer?.();
    },
  };
}
