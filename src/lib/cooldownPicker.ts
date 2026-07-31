/**
 * Random selection with a 70% pool cooldown.
 *
 * Once an item is chosen it stays unavailable for floor(n * 0.7) later picks.
 * This keeps variety high without turning the order into a predictable shuffle.
 *
 * When a `poolId` is set, the recent-index history is written to localStorage and
 * mirrored into durable app-data, so an update that reloads the WebView does not
 * forget which greetings, animations, or stand-in lines just ran.
 */

import { saveDurably, type DurableKey } from "./durableStorage";

export const COOLDOWN_POOLS_KEY = "duckweed:cooldown-pools:v1" as const satisfies DurableKey;

interface PoolRecord {
  /** Stable keys for the last floor(n * 0.7) picks, oldest first. */
  recent: string[];
}

interface Store {
  version: 1;
  pools: Record<string, PoolRecord>;
}

export interface CooldownPickerOptions<T> {
  /**
   * When set, recent picks for this pool survive restarts and app updates.
   * Use a short stable id ("greetings", "ascii-animations", …).
   */
  poolId?: string;
  /**
   * Stable identity for an item. Prefer content for strings so reordering the
   * authored list does not revive a just-shown line. Defaults to the index as
   * a string, which is enough for append-only factory pools.
   */
  keyOf?: (item: T, index: number) => string;
}

let store: Store | null = null;

function emptyStore(): Store {
  return { version: 1, pools: {} };
}

function parse(raw: string | null): Store {
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !parsed.pools || typeof parsed.pools !== "object") {
      return emptyStore();
    }
    const pools: Record<string, PoolRecord> = {};
    for (const [id, record] of Object.entries(parsed.pools)) {
      if (!record || typeof record !== "object" || !Array.isArray(record.recent)) continue;
      const recent = record.recent.filter((key): key is string => typeof key === "string");
      if (recent.length > 0) pools[id] = { recent };
    }
    return { version: 1, pools };
  } catch {
    return emptyStore();
  }
}

function readStore(): Store {
  if (store) return store;
  try {
    if (typeof localStorage === "undefined") {
      store = emptyStore();
      return store;
    }
    store = parse(localStorage.getItem(COOLDOWN_POOLS_KEY));
  } catch {
    store = emptyStore();
  }
  return store;
}

function writeStore(next: Store): void {
  store = next;
  try {
    const raw = JSON.stringify(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(COOLDOWN_POOLS_KEY, raw);
    }
    saveDurably(COOLDOWN_POOLS_KEY, raw);
  } catch {
    // Storage can be unavailable; in-memory cooldown still works this session.
  }
}

function defaultKeyOf<T>(_item: T, index: number): string {
  return String(index);
}

function loadRecentKeys(poolId: string, maxLength: number): string[] {
  if (maxLength <= 0) return [];
  const record = readStore().pools[poolId];
  if (!record) return [];
  return record.recent.slice(-maxLength);
}

function saveRecentKeys(poolId: string, recent: readonly string[]): void {
  const current = readStore();
  const pools = { ...current.pools };
  if (recent.length === 0) {
    delete pools[poolId];
  } else {
    pools[poolId] = { recent: [...recent] };
  }
  writeStore({ version: 1, pools });
}

/**
 * Resolve stored keys back to live indices. Drop keys that no longer exist
 * (phrase removed, factory list shortened) so a stale snapshot cannot block
 * the whole pool.
 */
function resolveRecent(
  items: readonly unknown[],
  keys: readonly string[],
  keyOf: (item: unknown, index: number) => string,
  maxLength: number,
): number[] {
  if (items.length === 0 || keys.length === 0 || maxLength <= 0) return [];

  const indexByKey = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const key = keyOf(items[index], index);
    // First occurrence wins when two items share a key (should not happen).
    if (!indexByKey.has(key)) indexByKey.set(key, index);
  }

  const resolved: number[] = [];
  for (const key of keys) {
    const index = indexByKey.get(key);
    if (index === undefined) continue;
    // Keep only the latest sit-out if the same key appears twice.
    const prior = resolved.indexOf(index);
    if (prior >= 0) resolved.splice(prior, 1);
    resolved.push(index);
  }
  return resolved.slice(-maxLength);
}

/** Test helper: drop the in-memory snapshot so the next picker reloads storage. */
export function resetCooldownPoolStoreForTests(): void {
  store = null;
}

export function createCooldownPicker<T>(
  items: readonly T[],
  fallback: T,
  random: () => number = Math.random,
  options: CooldownPickerOptions<T> = {},
): () => T {
  const cooldown = Math.floor(items.length * 0.7);
  const keyOf = options.keyOf ?? defaultKeyOf;
  const poolId = options.poolId;

  const recent: number[] = poolId
    ? resolveRecent(
        items,
        loadRecentKeys(poolId, cooldown),
        keyOf as (item: unknown, index: number) => string,
        cooldown,
      )
    : [];

  return () => {
    if (items.length === 0) return fallback;
    if (cooldown <= 0) {
      return items[Math.floor(random() * items.length)] ?? fallback;
    }

    const blocked = new Set(recent);
    const available: number[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (!blocked.has(index)) available.push(index);
    }
    const pool =
      available.length > 0 ? available : items.map((_, index) => index);
    const chosen = pool[Math.floor(random() * pool.length)] ?? pool[0]!;

    recent.push(chosen);
    if (recent.length > cooldown) recent.shift();

    if (poolId) {
      saveRecentKeys(
        poolId,
        recent.map((index) => keyOf(items[index] as T, index)),
      );
    }

    return items[chosen] ?? fallback;
  };
}
