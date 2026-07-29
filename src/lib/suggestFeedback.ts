import { saveDurably } from "./durableStorage";

/**
 * Unlearning for ghost-text autosuggestions.
 *
 * History ranking alone keeps proposing a command the user has visibly stopped
 * wanting: it stays in history forever, so it keeps winning the prefix match.
 * This store records the other half of the loop — was the suggestion actually
 * taken? A command that is shown and ignored repeatedly is first demoted (so a
 * rival completion can win) and finally suppressed altogether.
 *
 * Signals, all recorded per suggested command:
 * - accept: the user took the ghost (Tab/→/Ctrl+F/Ctrl+→). Clears the reject
 *   streak — the pattern is re-learned immediately.
 * - reject: a ghost was *shown* during the draft and never accepted. Typing
 *   past it, running another command, or discarding the draft all count — the
 *   suggestion was unused. Running the same command by hand still clears the
 *   streak via {@link recordUsed}.
 *
 * Rejects are a *streak*, not a lifetime total, so one bad week cannot bury a
 * command the user has since gone back to.
 */

const STORAGE_KEY = "duckweed:suggest-feedback:v1";

/** Rejects before ranking starts pushing the command down. */
export const DEMOTE_AFTER = 3;
/** Rejects before the command stops being suggested at all. */
export const SUPPRESS_AFTER = 10;
/** Ranking cost per reject past DEMOTE_AFTER — outweighs recency, not cwd. */
const REJECT_PENALTY = 60 * 60 * 1000;
/** Cap so the table cannot grow without bound. */
const MAX_ENTRIES = 500;

export interface FeedbackEntry {
  /** Consecutive rejects since the last accept. */
  rejects: number;
  /** Lifetime accepts — kept for debugging / future tuning. */
  accepts: number;
  /** Last update, used to evict the stalest rows when over cap. */
  at: number;
}

let entries: Record<string, FeedbackEntry> = load();
const listeners = new Set<() => void>();

function load(): Record<string, FeedbackEntry> {
  try {
    if (typeof localStorage === "undefined") return {};
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function parse(raw: string | null): Record<string, FeedbackEntry> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, FeedbackEntry> = {};
    for (const [command, value] of Object.entries(data as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const { rejects, accepts, at } = value as Partial<FeedbackEntry>;
      if (typeof rejects !== "number" || typeof accepts !== "number") continue;
      out[command] = {
        rejects: Math.max(0, rejects),
        accepts: Math.max(0, accepts),
        at: typeof at === "number" ? at : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(options?: { replace?: boolean }): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
    saveDurably(STORAGE_KEY, JSON.stringify(entries), options);
  } catch {
    // Quota / private mode — unlearning is a nicety, not a requirement.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function trim(): void {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return;
  // Drop the least recently touched rows first.
  const stale = keys
    .sort((a, b) => (entries[a]!.at ?? 0) - (entries[b]!.at ?? 0))
    .slice(0, keys.length - MAX_ENTRIES);
  for (const key of stale) delete entries[key];
}

/** Observe feedback changes (ranking must re-run when a command is demoted). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current counters for a command (zeros when untracked). */
export function entry(command: string): FeedbackEntry {
  return entries[command] ?? { rejects: 0, accepts: 0, at: 0 };
}

/** Snapshot of the whole table (settings UI / tests). */
export function all(): Readonly<Record<string, FeedbackEntry>> {
  return entries;
}

/**
 * The user took the suggestion — or ran the command themselves. Either way the
 * pattern is wanted, so the reject streak resets and suppression lifts.
 */
export function recordAccept(command: string, at = Date.now()): void {
  if (!command) return;
  const prev = entry(command);
  if (prev.rejects === 0 && prev.accepts === 0 && !entries[command]) {
    // Nothing learned against it yet; only start a row once it matters.
    entries[command] = { rejects: 0, accepts: 1, at };
  } else {
    entries[command] = { rejects: 0, accepts: prev.accepts + 1, at };
  }
  trim();
  persist();
  notify();
}

/**
 * The user ran this command by hand. Only forgives commands we already learned
 * against — every other submission would otherwise create a row for nothing.
 */
export function recordUsed(command: string, at = Date.now()): void {
  const prev = entries[command];
  if (!prev || prev.rejects === 0) return;
  entries[command] = { rejects: 0, accepts: prev.accepts, at };
  persist();
  notify();
}

/** A ghost was on screen and the user did something else with it. */
export function recordReject(command: string, at = Date.now()): void {
  if (!command) return;
  const prev = entry(command);
  if (prev.rejects >= SUPPRESS_AFTER) return; // Already fully unlearned.
  entries[command] = { rejects: prev.rejects + 1, accepts: prev.accepts, at };
  trim();
  persist();
  notify();
}

/** True once the command has been ignored enough to stop suggesting it. */
export function isSuppressed(command: string): boolean {
  return entry(command).rejects >= SUPPRESS_AFTER;
}

/**
 * Ranking cost for a command. Zero until DEMOTE_AFTER rejects, then grows so a
 * less-rejected sibling wins before the command disappears entirely.
 */
export function demotion(command: string): number {
  const { rejects } = entry(command);
  if (rejects <= DEMOTE_AFTER) return 0;
  return (rejects - DEMOTE_AFTER) * REJECT_PENALTY;
}

/** Forget what we learned about one command (user asked for it back). */
export function forget(command: string): void {
  if (!(command in entries)) return;
  delete entries[command];
  persist({ replace: true });
  notify();
}

/** Reset every learned preference. */
export function clear(): void {
  entries = {};
  persist({ replace: true });
  notify();
}

/** Test helper — install a table wholesale. */
export function replaceAll(next: Record<string, FeedbackEntry>): void {
  entries = { ...next };
  trim();
  persist({ replace: true });
  notify();
}

// Keep multiple windows coherent, same as command history.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    entries = parse(event.newValue);
    notify();
  });
}
