import { saveDurably } from "./durableStorage";
import {
  MAX_HISTORY_ENTRIES,
  mergeHistory,
  parseHistory,
  type HistoryEntry,
} from "./historyMerge";

/**
 * Shared command history for ghost-text autosuggestions.
 *
 * Entries are app-wide (not per-pane) and durable in localStorage *and* in the
 * native app-data copy, so a command run in one pane can suggest in another
 * after a restart or an app update. Per-pane ↑/↓ walk lives on each terminal
 * session (see terminals.localHistory).
 */

export type { HistoryEntry };

const STORAGE_KEY = "duckweed:command-history:v1";
const MAX_ENTRIES = MAX_HISTORY_ENTRIES;

let entries: HistoryEntry[] = load();
const listeners = new Set<() => void>();

function load(): HistoryEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return mergeHistory(parseHistory(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return [];
  }
}

function persist(options?: { replace?: boolean }): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
    // The native copy merges by default, so a window holding an older snapshot
    // (or a build running on a different WebView origin) can never truncate it.
    saveDurably(STORAGE_KEY, JSON.stringify(entries), options);
  } catch {
    // Quota / private mode — history is a convenience, not a requirement.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Observe history changes, including updates written by another app window. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot of history, oldest first. */
export function list(): readonly HistoryEntry[] {
  return entries;
}

/** Commands only, oldest first (tests / callers that need bare strings). */
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
  notify();
}

/** Test / reset helper — replaces the in-memory list and persists. */
export function replaceAll(next: HistoryEntry[]): void {
  entries = next.slice(-MAX_ENTRIES);
  persist({ replace: true });
  notify();
}

/** Clear history (user reset / tests) — drops the native copy too. */
export function clear(): void {
  entries = [];
  persist({ replace: true });
  notify();
}

// localStorage survives a Tauri webview restart, and durableStorage restores it
// after an app update. The storage event additionally keeps ghost suggestions
// coherent when more than one Duckweed window is open.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const incoming = parseHistory(event.newValue);
    // An explicit clear in another window empties the key — honour it. Anything
    // else is a union, so neither window can shrink the other's history.
    entries = event.newValue === "[]" ? [] : mergeHistory(entries, incoming);
    notify();
  });
}
