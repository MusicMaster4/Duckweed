/**
 * Power watch — "when everything here is done, put the machine away."
 *
 * The user picks suspend or shut down and arms it. From then on the watch keeps
 * reading what is still working: shells with a live child process, and agent
 * sessions that are starting, mid-turn, or blocked on a permission prompt. When
 * all of that is quiet it starts a visible countdown, and only then fires.
 *
 * Two deliberate choices:
 *
 * - The countdown is not cosmetic. An agent that finished a turn is idle for a
 *   moment before the user's next prompt, and a machine that suspended in that
 *   gap would be worse than useless. The grace period has to elapse *without
 *   interruption*; anything starting up puts the watch back to waiting.
 * - Arming is never restored on launch. It lives for the session only. Losing an
 *   arm to a restart means the machine stays on, which is a boring failure;
 *   restoring a stale one means the machine suspends while somebody is using it.
 *
 * The state is global rather than component-owned because the watch has to keep
 * running with the tools panel closed — that is the whole point of walking away.
 */

export type PowerAction = "suspend" | "shutdown";

export type PowerWatchPhase =
  /** Not armed. */
  | "off"
  /** Armed, and something is still working. */
  | "armed"
  /** Nothing is working; the grace period is running down. */
  | "countdown"
  /** The action has been handed to the OS. */
  | "firing"
  /** The OS refused; `error` explains, and the watch disarms itself. */
  | "failed";

/** Why one pane counts as still working. */
export type BusyReason = "process" | "agent-starting" | "agent-working" | "agent-waiting";

export interface BusyEntry {
  termId: string;
  /** Human label for the panel list, e.g. "Terminal 2 · claude". */
  label: string;
  reason: BusyReason;
}

export interface PowerWatchState {
  action: PowerAction;
  phase: PowerWatchPhase;
  /** Uninterrupted quiet required before firing. */
  graceMs: number;
  /** Epoch ms the countdown ends at — null outside `countdown`. */
  firesAt: number | null;
  /** What is keeping the watch waiting, as of the last poll. */
  busy: BusyEntry[];
  error: string | null;
}

export const GRACE_CHOICES = [
  { ms: 30_000, label: "30s" },
  { ms: 60_000, label: "1 min" },
  { ms: 120_000, label: "2 min" },
  { ms: 300_000, label: "5 min" },
  { ms: 900_000, label: "15 min" },
] as const;

const DEFAULT_GRACE_MS = 120_000;
const POLL_MS = 1_000;
const PREFS_KEY = "duckweed:powerwatch:v1";

export const POWER_ACTION_LABELS: Record<PowerAction, string> = {
  suspend: "Sleep",
  shutdown: "Shut down",
};

/** Present tense, for the countdown banner: "Sleeping in 1:20". */
export const POWER_ACTION_GERUNDS: Record<PowerAction, string> = {
  suspend: "Sleeping",
  shutdown: "Shutting down",
};

export const BUSY_REASON_LABELS: Record<BusyReason, string> = {
  process: "running",
  "agent-starting": "starting",
  "agent-working": "working",
  "agent-waiting": "needs you",
};

// ------------------------------------------------------------------ machine

interface Timing {
  phase: PowerWatchPhase;
  firesAt: number | null;
}

/**
 * Where the watch goes next, given whether anything is still working.
 *
 * Kept pure and separate from the store so the interesting part — quiet has to
 * hold for the whole grace period — can be tested without a clock or a window.
 */
export function nextTiming(
  current: { phase: PowerWatchPhase; firesAt: number | null; graceMs: number },
  busy: boolean,
  now: number,
): Timing {
  switch (current.phase) {
    case "armed":
      return busy ? { phase: "armed", firesAt: null } : { phase: "countdown", firesAt: now + current.graceMs };
    case "countdown":
      // Anything waking up cancels the countdown outright; the next quiet spell
      // starts a fresh one rather than resuming this one.
      if (busy) return { phase: "armed", firesAt: null };
      if (current.firesAt !== null && now >= current.firesAt) return { phase: "firing", firesAt: current.firesAt };
      return { phase: "countdown", firesAt: current.firesAt };
    default:
      return { phase: current.phase, firesAt: current.firesAt };
  }
}

/** Seconds left on the countdown, floored at zero. */
export function secondsLeft(state: PowerWatchState, now: number): number {
  if (state.firesAt === null) return 0;
  return Math.max(0, Math.ceil((state.firesAt - now) / 1000));
}

/** `m:ss`, the shape a countdown is read in. */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// -------------------------------------------------------------------- store

function loadPrefs(): { action: PowerAction; graceMs: number } {
  const fallback = { action: "suspend" as PowerAction, graceMs: DEFAULT_GRACE_MS };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { action?: unknown; graceMs?: unknown };
    return {
      action: parsed.action === "shutdown" ? "shutdown" : "suspend",
      graceMs: GRACE_CHOICES.some((choice) => choice.ms === parsed.graceMs)
        ? (parsed.graceMs as number)
        : DEFAULT_GRACE_MS,
    };
  } catch {
    return fallback;
  }
}

function savePrefs(state: PowerWatchState): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ action: state.action, graceMs: state.graceMs }));
  } catch {
    // A remembered dropdown position is not worth failing over.
  }
}

const initial = loadPrefs();

let state: PowerWatchState = {
  action: initial.action,
  phase: "off",
  graceMs: initial.graceMs,
  firesAt: null,
  busy: [],
  error: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<PowerWatchState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState(): PowerWatchState {
  return state;
}

export function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * What the watch needs from the rest of the app: a way to read current activity,
 * and a way to carry the action out. Injected rather than imported so this
 * module stays free of xterm and Tauri, and so tests can drive both sides.
 */
export interface PowerWatchRuntime {
  probe: () => BusyEntry[];
  fire: (action: PowerAction) => Promise<void>;
}

let runtime: PowerWatchRuntime | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Hand the watch its view of the app. Returns a disconnect for unmount. */
export function connect(next: PowerWatchRuntime): () => void {
  runtime = next;
  if (state.phase !== "off") startPolling();
  return () => {
    if (runtime === next) {
      runtime = null;
      stopPolling();
    }
  };
}

function startPolling(): void {
  if (timer !== null) return;
  timer = setInterval(poll, POLL_MS);
}

function stopPolling(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * One tick: re-read activity, advance the machine, and fire if it says so.
 *
 * Exported for tests, which drive it directly instead of waiting on a timer.
 */
export function poll(now = Date.now()): void {
  if (state.phase === "off" || state.phase === "firing" || !runtime) return;

  const busy = runtime.probe();
  const timing = nextTiming(state, busy.length > 0, now);
  set({ busy, phase: timing.phase, firesAt: timing.firesAt });

  if (timing.phase !== "firing") return;

  stopPolling();
  const action = state.action;
  void runtime
    .fire(action)
    // Sleep resolves on the far side of the nap; the watch has done its job
    // either way, so it stands down instead of arming itself again.
    .then(() => {
      set({ phase: "off", firesAt: null, busy: [], error: null });
    })
    .catch((error: unknown) => {
      set({ phase: "failed", firesAt: null, error: String(error) });
    });
}

export function arm(): void {
  if (state.phase === "armed" || state.phase === "countdown") return;
  set({ phase: "armed", firesAt: null, error: null, busy: runtime?.probe() ?? [] });
  startPolling();
  // Evaluate immediately so arming with nothing running shows its countdown at
  // once rather than a second of blank "waiting".
  poll();
}

export function disarm(): void {
  stopPolling();
  set({ phase: "off", firesAt: null, busy: [], error: null });
}

export function setAction(action: PowerAction): void {
  if (state.action === action) return;
  set({ action });
  savePrefs(state);
}

export function setGrace(graceMs: number): void {
  if (state.graceMs === graceMs) return;
  // Re-time a running countdown against the new period rather than letting the
  // old deadline stand — the number on screen has to be the one that applies.
  const firesAt = state.phase === "countdown" ? Date.now() + graceMs : state.firesAt;
  set({ graceMs, firesAt });
  savePrefs(state);
}

/** Test seam: drop every scrap of state between cases. */
export function resetForTests(next?: Partial<PowerWatchState>): void {
  stopPolling();
  runtime = null;
  state = {
    action: "suspend",
    phase: "off",
    graceMs: DEFAULT_GRACE_MS,
    firesAt: null,
    busy: [],
    error: null,
    ...next,
  };
}
