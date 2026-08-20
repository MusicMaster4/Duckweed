/**
 * Per-tab checklists: the notes you would otherwise keep in a scratch buffer,
 * kept next to the shell they belong to.
 *
 * Each tab gets its own list, because a checklist is about the work in front of
 * you and tabs are how that work is divided here. The lists outlive restarts and
 * updates: they ride the same durable app-data copy as command history, so an
 * update that swaps the WebView origin cannot quietly take them.
 *
 * Checked items are not deleted on the spot. They stay, struck through, for a
 * day. That is long enough to see what you finished this session, undo a
 * mis-click, or come back tomorrow and find the list already tidy. The sweep
 * runs on load and on a slow timer, so a window left open overnight clears
 * itself.
 */

import { saveDurably } from "./durableStorage";

export interface ChecklistItem {
  id: string;
  text: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms it was checked, or null while it is still open. */
  doneAt: number | null;
}

interface Store {
  version: 1;
  /** Keyed by tab id, which persist keeps stable across restarts. */
  lists: Record<string, ChecklistItem[]>;
}

export const CHECKLIST_KEY = "duckweed:checklist:v1";

/** How long a checked item stays visible before it is swept. */
export const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Guard against a runaway paste; a sidebar list is not a document. */
const MAX_ITEMS_PER_LIST = 200;
const MAX_TEXT_LENGTH = 500;

// ------------------------------------------------------------------- pure

/**
 * Drop checked items that have outlived their day.
 *
 * Returns the same object when nothing changed so callers can skip a write and
 * a re-render, since this runs on a timer against every list in the app.
 */
export function sweep(lists: Record<string, ChecklistItem[]>, now: number): Record<string, ChecklistItem[]> {
  let changed = false;
  const next: Record<string, ChecklistItem[]> = {};
  for (const [scope, items] of Object.entries(lists)) {
    const kept = items.filter((item) => item.doneAt === null || now - item.doneAt < DONE_RETENTION_MS);
    if (kept.length !== items.length) changed = true;
    // An emptied list is dropped outright rather than kept as an empty array.
    if (kept.length > 0) next[scope] = kept;
    else if (items.length > 0) changed = true;
  }
  return changed ? next : lists;
}

/**
 * Open items first in the order they were added, then finished ones with the
 * newest at the top of that group, the reverse of how they were checked off,
 * so the most recent mistake is the easiest one to undo.
 */
export function ordered(items: readonly ChecklistItem[]): ChecklistItem[] {
  const open = items.filter((item) => item.doneAt === null);
  const done = items
    .filter((item) => item.doneAt !== null)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return [...open, ...done];
}

/** Whole hours until a checked item is swept; 0 once it is within the last hour. */
export function hoursUntilSweep(item: ChecklistItem, now: number): number {
  if (item.doneAt === null) return 0;
  return Math.max(0, Math.floor((item.doneAt + DONE_RETENTION_MS - now) / (60 * 60 * 1000)));
}

/**
 * True only on the edge from some open work to none, with items still present.
 * Mount, tab switch, empty list, and already-clear re-renders all stay false.
 */
export function becameAllClear(prevOpen: number, nextOpen: number, total: number): boolean {
  return prevOpen > 0 && nextOpen === 0 && total > 0;
}

// ------------------------------------------------------------------- store

let store: Store = { version: 1, lists: {} };
const listeners = new Set<() => void>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let counter = 0;

function newId(): string {
  counter += 1;
  return `c${Date.now().toString(36)}${counter.toString(36)}`;
}

function parse(raw: string | null): Record<string, ChecklistItem[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !parsed.lists || typeof parsed.lists !== "object") return {};
    const lists: Record<string, ChecklistItem[]> = {};
    for (const [scope, items] of Object.entries(parsed.lists)) {
      if (!Array.isArray(items)) continue;
      const clean = items
        .filter((item): item is ChecklistItem =>
          !!item &&
          typeof item.id === "string" &&
          typeof item.text === "string" &&
          typeof item.createdAt === "number" &&
          (item.doneAt === null || typeof item.doneAt === "number"),
        )
        .slice(0, MAX_ITEMS_PER_LIST);
      if (clean.length > 0) lists[scope] = clean;
    }
    return lists;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(CHECKLIST_KEY, raw);
    saveDurably(CHECKLIST_KEY, raw);
  } catch {
    // Storage can be unavailable; the in-memory list still works this session.
  }
}

function commit(lists: Record<string, ChecklistItem[]>): void {
  store = { version: 1, lists };
  persist();
  for (const listener of listeners) listener();
}

/**
 * Read the saved lists and start the sweep timer. Called once at boot, after
 * durable storage has been restored into the WebView copy.
 */
export function init(): void {
  store = { version: 1, lists: sweep(parse(localStorage.getItem(CHECKLIST_KEY)), Date.now()) };
  if (sweepTimer === null) {
    sweepTimer = setInterval(() => {
      const swept = sweep(store.lists, Date.now());
      if (swept !== store.lists) commit(swept);
    }, SWEEP_INTERVAL_MS);
  }
  for (const listener of listeners) listener();
}

export function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

const EMPTY: readonly ChecklistItem[] = [];

export function items(scope: string): readonly ChecklistItem[] {
  return store.lists[scope] ?? EMPTY;
}

/** Open items in `scope`, which is what the rail badge counts. */
export function openCount(scope: string): number {
  return (store.lists[scope] ?? EMPTY).filter((item) => item.doneAt === null).length;
}

/** Open work across every tab, used by app-wide activity chrome. */
export function totalOpenCount(): number {
  return Object.values(store.lists).reduce(
    (total, list) => total + list.filter((item) => item.doneAt === null).length,
    0,
  );
}

export function add(scope: string, text: string): void {
  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH);
  if (!trimmed) return;
  const existing = store.lists[scope] ?? [];
  if (existing.length >= MAX_ITEMS_PER_LIST) return;
  commit({
    ...store.lists,
    [scope]: [...existing, { id: newId(), text: trimmed, createdAt: Date.now(), doneAt: null }],
  });
}

/** Check an open item, or put a checked one back. The same click either way. */
export function toggle(scope: string, id: string): void {
  const existing = store.lists[scope];
  if (!existing) return;
  commit({
    ...store.lists,
    [scope]: existing.map((item) =>
      item.id === id ? { ...item, doneAt: item.doneAt === null ? Date.now() : null } : item,
    ),
  });
}

export function rename(scope: string, id: string, text: string): void {
  const existing = store.lists[scope];
  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH);
  if (!existing || !trimmed) return;
  commit({
    ...store.lists,
    [scope]: existing.map((item) => (item.id === id ? { ...item, text: trimmed } : item)),
  });
}

export function remove(scope: string, id: string): void {
  const existing = store.lists[scope];
  if (!existing) return;
  const kept = existing.filter((item) => item.id !== id);
  const lists = { ...store.lists };
  if (kept.length > 0) lists[scope] = kept;
  else delete lists[scope];
  commit(lists);
}

/** Sweep this list's checked items now instead of waiting out the day. */
export function clearDone(scope: string): void {
  const existing = store.lists[scope];
  if (!existing) return;
  const kept = existing.filter((item) => item.doneAt === null);
  if (kept.length === existing.length) return;
  const lists = { ...store.lists };
  if (kept.length > 0) lists[scope] = kept;
  else delete lists[scope];
  commit(lists);
}

/**
 * Forget lists whose tab is gone. Closing a tab takes its checklist with it,
 * otherwise the file grows a list per tab the user ever opened.
 */
export function prune(liveScopes: readonly string[]): void {
  const live = new Set(liveScopes);
  const lists: Record<string, ChecklistItem[]> = {};
  let changed = false;
  for (const [scope, entries] of Object.entries(store.lists)) {
    if (live.has(scope)) lists[scope] = entries;
    else changed = true;
  }
  if (changed) commit(lists);
}

/** Test seam: start from a known store without touching the timer. */
export function resetForTests(lists: Record<string, ChecklistItem[]> = {}): void {
  store = { version: 1, lists };
}
