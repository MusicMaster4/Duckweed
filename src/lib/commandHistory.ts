/**
 * Shared command history for autosuggestions and ↑ history walk.
 *
 * Entries are app-wide (not per-pane) and durable in localStorage so a command
 * run in one pane can ghost-suggest in another after restarts.
 */

export interface HistoryEntry {
  command: string;
  /** Working directory when the command was submitted, if known. */
  cwd: string | null;
  /** Epoch ms when recorded. */
  at: number;
}

const STORAGE_KEY = "duckweed:command-history:v1";
/** Keep the list bounded; oldest entries drop first. */
const MAX_ENTRIES = 500;

let entries: HistoryEntry[] = load();

function load(): HistoryEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is HistoryEntry => {
        if (!e || typeof e !== "object") return false;
        const o = e as Record<string, unknown>;
        return typeof o.command === "string" && typeof o.at === "number";
      })
      .map((e) => ({
        command: e.command,
        cwd: typeof e.cwd === "string" ? e.cwd : null,
        at: e.at,
      }))
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota / private mode — history is a convenience, not a requirement.
  }
}

/** Snapshot of history, oldest first. */
export function list(): readonly HistoryEntry[] {
  return entries;
}

/** Commands only, oldest first (for ↑ history navigation). */
export function commands(): string[] {
  return entries.map((e) => e.command);
}

/**
 * Record a submitted command. Consecutive duplicates of the same string are
 * collapsed (recency bumped); empty/whitespace-only is ignored.
 */
export function record(command: string, cwd: string | null = null, at = Date.now()): void {
  const trimmed = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (!trimmed.trim()) return;

  const last = entries[entries.length - 1];
  if (last && last.command === trimmed) {
    entries[entries.length - 1] = {
      command: trimmed,
      cwd: cwd ?? last.cwd,
      at,
    };
  } else {
    entries = [...entries, { command: trimmed, cwd, at }].slice(-MAX_ENTRIES);
  }
  persist();
}

/** Test / reset helper — replaces the in-memory list and persists. */
export function replaceAll(next: HistoryEntry[]): void {
  entries = next.slice(-MAX_ENTRIES);
  persist();
}

/** Clear history (tests). */
export function clear(): void {
  entries = [];
  persist();
}
