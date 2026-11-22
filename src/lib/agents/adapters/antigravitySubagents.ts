import { oneLine, type AdapterContext, type AntigravitySubagentUpdate } from "../adapter";

interface TrackedCall {
  lastSeenAt: number;
  snapshot?: AntigravitySubagentUpdate;
}

const POLL_INTERVAL_MS = 750;
const MISSING_STATUS_GRACE_MS = 8_000;
const UNAVAILABLE = { statusUnavailable: true, activity: "Launch acknowledged" };

/** AGY completes the invocation at launch. The child runs on its own timeline. */
export function createAntigravitySubagentTracker() {
  const calls = new Map<string, TrackedCall>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let active: {
    read: NonNullable<AdapterContext["readAntigravitySubagents"]>;
    emit: AdapterContext["emit"];
    sessionId: string;
  } | undefined;

  function schedule(delay: number) {
    const session = active;
    if (!session || timer !== undefined || !calls.size) return;
    timer = setTimeout(() => {
      void poll(session).finally(() => {
        if (active !== session) return;
        timer = undefined;
        schedule(POLL_INTERVAL_MS);
      });
    }, delay);
  }

  async function poll(session: NonNullable<typeof active>) {
    const current = new Map(calls);
    const { read, emit, sessionId } = session;
    const updates = await read(sessionId, [...current.keys()])
      .catch(() => []);
    if (active !== session) return;
    const snapshots = new Map(updates.map((update) => [update.callId, update]));
    const now = Date.now();
    for (const [callId, call] of current) {
      if (calls.get(callId) !== call) continue;
      const update = snapshots.get(callId);
      if (!update) {
        if (now - call.lastSeenAt >= MISSING_STATUS_GRACE_MS) {
          calls.delete(callId);
          emit({ type: "tool", callId, status: "done", subagent: UNAVAILABLE });
        }
        continue;
      }
      call.lastSeenAt = now;
      const previous = call.snapshot;
      if (previous?.status === update.status && previous.toolName === update.toolName &&
          previous.output === update.output && previous.threadId === update.threadId) continue;
      call.snapshot = update;
      const terminal = update.status === "done" || update.status === "error";
      if (terminal) calls.delete(callId);
      const activity = update.status === "error"
        ? "Delegated work stopped"
        : update.status === "done"
          ? "Delegated work completed"
          : update.status === "pending"
            ? "Waiting to start"
            : update.toolName
              ? oneLine(`Using ${update.toolName.replace(/_/g, " ")}`)
              : "Working";
      emit({
        type: "tool",
        callId,
        status: update.status,
        ...(update.output ? { output: update.output } : {}),
        subagent: { activity, threadId: update.threadId, statusUnavailable: false },
      });
    }
  }

  function pause() {
    active = undefined;
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    track(callId: string, ctx: AdapterContext) {
      if (!disposed && ctx.readAntigravitySubagents) {
        calls.set(callId, { lastSeenAt: Date.now() });
        schedule(0);
      }
      // On replay the ACP acknowledgement has no current-status information.
      return active
        ? { status: "running" as const, subagent: { activity: "Working" } }
        : { status: "done" as const, subagent: UNAVAILABLE };
    },
    untrack(callId: string) {
      calls.delete(callId);
    },
    start(ctx: AdapterContext, sessionId: string) {
      if (disposed || !ctx.readAntigravitySubagents) return;
      active = { read: ctx.readAntigravitySubagents, emit: ctx.emit, sessionId };
      schedule(0);
    },
    pause,
    reset() {
      pause();
      calls.clear();
    },
    dispose(ctx: AdapterContext) {
      disposed = true;
      pause();
      for (const callId of calls.keys()) {
        ctx.emit({ type: "tool", callId, status: "done", subagent: UNAVAILABLE });
      }
      calls.clear();
    },
  };
}
