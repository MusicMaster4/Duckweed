import { afterEach, describe, expect, test } from "bun:test";

import {
  COOLDOWN_POOLS_KEY,
  createCooldownPicker,
  resetCooldownPoolStoreForTests,
} from "./cooldownPicker";

const memory = new Map<string, string>();

const localStorageStub = {
  getItem(key: string): string | null {
    return memory.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
  },
  removeItem(key: string): void {
    memory.delete(key);
  },
  clear(): void {
    memory.clear();
  },
};

function installStorage(): void {
  memory.clear();
  resetCooldownPoolStoreForTests();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageStub,
  });
}

afterEach(() => {
  memory.clear();
  resetCooldownPoolStoreForTests();
});

describe("createCooldownPicker", () => {
  test("keeps a selected item out of the next 70% of pool picks", () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    // floor(10 * 0.7) = 7 sit-outs
    const pick = createCooldownPicker(items, -1, () => 0);
    const selected = Array.from({ length: 30 }, () => pick());

    selected.forEach((item, index) => {
      const protectedWindow = selected.slice(Math.max(0, index - 7), index);
      expect(protectedWindow).not.toContain(item);
    });
  });

  test("returns the fallback for an empty collection", () => {
    const pick = createCooldownPicker<string>([], "fallback");
    expect(pick()).toBe("fallback");
  });

  test("supports a single-item collection", () => {
    const pick = createCooldownPicker(["only"], "fallback");
    expect(pick()).toBe("only");
    expect(pick()).toBe("only");
  });

  test("honors a half-pool cooldown fraction", () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    // floor(10 * 0.5) = 5 sit-outs
    const pick = createCooldownPicker(items, -1, () => 0, { cooldownFraction: 0.5 });
    const selected = Array.from({ length: 20 }, () => pick());

    selected.forEach((item, index) => {
      const protectedWindow = selected.slice(Math.max(0, index - 5), index);
      expect(protectedWindow).not.toContain(item);
    });
  });

  test("persists recent picks so a fresh picker keeps the sit-outs", () => {
    installStorage();
    const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    // Always take the first available slot so the sequence is deterministic.
    // floor(10 * 0.7) = 7 sit-outs
    const first = createCooldownPicker(items, "x", () => 0, {
      poolId: "test-pool",
      keyOf: (item) => item,
    });
    const drawn = [first(), first(), first(), first(), first(), first(), first()];
    expect(drawn).toEqual(["a", "b", "c", "d", "e", "f", "g"]);

    // Simulate an app reload: drop the in-memory store, keep localStorage.
    resetCooldownPoolStoreForTests();
    const second = createCooldownPicker(items, "x", () => 0, {
      poolId: "test-pool",
      keyOf: (item) => item,
    });
    // 70% of 10 is 7, so a–g must still be blocked and the next pick is h.
    expect(second()).toBe("h");

    const raw = memory.get(COOLDOWN_POOLS_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as {
      version: number;
      pools: Record<string, { recent: string[] }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.pools["test-pool"]?.recent).toEqual([
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
  });

  test("drops stored keys that no longer exist in the pool", () => {
    installStorage();
    const first = createCooldownPicker(["a", "b", "c", "d"], "x", () => 0, {
      poolId: "shrinking",
      keyOf: (item) => item,
    });
    first();
    first();
    expect(JSON.parse(memory.get(COOLDOWN_POOLS_KEY)!).pools.shrinking.recent).toEqual([
      "a",
      "b",
    ]);

    resetCooldownPoolStoreForTests();
    // "a" was removed from the authored list; only "b" should still sit out.
    const second = createCooldownPicker(["b", "c", "d", "e"], "x", () => 0, {
      poolId: "shrinking",
      keyOf: (item) => item,
    });
    // Available without b: c,d,e — first available under random=0 is c? 
    // indices: b=0 blocked, c=1, d=2, e=3 → available [1,2,3], pick index 1 → "c"
    expect(second()).toBe("c");
  });
});
