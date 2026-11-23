import { oneLine, type AdapterContext, type AntigravitySubagentUpdate } from "../adapter";

interface TrackedCall {
  lastSeenAt: number;
  snapshot?: AntigravitySubagentUpdate;
}

const POLL_INTERVAL_MS = 750;
const MISSING_STATUS_GRACE_MS = 12_000;
const UNAVAILABLE = { statusUnavailable: true, activity: "Launch acknowledged" };

/** AGY completes the invocation at launch. The child runs on its own timeline. */
export function createAntigravitySubagentTracker() {
  const calls = new Map<string, TrackedCall>();
  /** Remembers threadId -> callId even after completion so send_message can revive tracking. */
  const callIdByThreadId = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerImmediate = false;
  let polling = false;
  let pollAgain = false;
  let disposed = false;
  let active: {
    read: NonNullable<AdapterContext["readAntigravitySubagents"]>;
    emit: AdapterContext["emit"];
    sessionId: string;
  } | undefined;

  function schedule(delay: number) {
    const session = active;
    if (!session || timer !== undefined || polling || !calls.size) return;
    timerImmediate = delay <= 0;
    timer = setTimeout(() => {
      timer = undefined;
      timerImmediate = false;
      void runPoll(session);
    }, delay);
  }

  async function runPoll(session: NonNullable<typeof active>) {
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    try {
      await poll(session);
    } finally {
      polling = false;
      if (active === session && calls.size) {
        const immediate = pollAgain;
        pollAgain = false;
        schedule(immediate ? 0 : POLL_INTERVAL_MS);
      } else {
        pollAgain = false;
      }
    }
  }

  async function poll(session: NonNullable<typeof active>) {
    const current = new Map(calls);
    if (!current.size) return;
    const { read, emit, sessionId } = session;
    let updates: AntigravitySubagentUpdate[];
    try {
      updates = await read(sessionId, [...current.keys()]);
    } catch {
      // Transient SQLite busy / IPC errors must not falsely retire live children.
      return;
    }
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
      if (update.threadId) callIdByThreadId.set(update.threadId, callId);
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
    timerImmediate = false;
    pollAgain = false;
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
    retrack(callId: string, ctx: AdapterContext) {
      if (disposed || !ctx.readAntigravitySubagents) return;
      calls.set(callId, { lastSeenAt: Date.now() });
      if (timer !== undefined && !timerImmediate) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (polling) {
        pollAgain = true;
      } else {
        schedule(0);
      }
    },
    pollNow() {
      if (!active || !calls.size) return;
      if (timer !== undefined && !timerImmediate) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (polling) {
        pollAgain = true;
      } else {
        schedule(0);
      }
    },
    callIdForThread(threadId: string): string | null {
      return callIdByThreadId.get(threadId) ?? null;
    },
    hasTracked(): boolean {
      return calls.size > 0;
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
      callIdByThreadId.clear();
    },
    dispose(ctx: AdapterContext) {
      disposed = true;
      pause();
      for (const callId of calls.keys()) {
        ctx.emit({ type: "tool", callId, status: "done", subagent: UNAVAILABLE });
      }
      calls.clear();
      callIdByThreadId.clear();
    },
  };
}
