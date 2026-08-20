import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  COMMAND_HISTORY_KEY,
  DURABLE_KEYS,
  createDurableWriteQueue,
} from "./durableStorage";

/** Pull every `duckweed:…` string literal from the Rust allowlist block. */
function rustDurableKeys(source: string): string[] {
  const block = source.match(
    /const DURABLE_SETTING_KEYS: \[&str; \d+] = \[([\s\S]*?)\];/,
  );
  if (!block) return [];
  const keys = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (block[1].includes("COMMAND_HISTORY_KEY")) {
    keys.push(COMMAND_HISTORY_KEY);
  }
  return keys;
}

describe("durable settings keys", () => {
  test("frontend list includes ghost history and unlearning", () => {
    expect(DURABLE_KEYS).toContain(COMMAND_HISTORY_KEY);
    expect(DURABLE_KEYS).toContain("duckweed:suggest-feedback:v1");
  });

  test("Rust allowlist matches every frontend durable key", () => {
    const rustPath = join(import.meta.dir, "../../src-tauri/src/main.rs");
    const rust = readFileSync(rustPath, "utf8");
    const allowed = new Set(rustDurableKeys(rust));
    for (const key of DURABLE_KEYS) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("durable settings writes", () => {
  test("flush waits for queued writes and preserves their order", async () => {
    let releaseFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const queue = createDurableWriteQueue(() => {});

    queue.enqueue(async () => {
      events.push("first started");
      await firstCanFinish;
      events.push("first finished");
    });
    queue.enqueue(async () => {
      events.push("second finished");
    });

    let flushed = false;
    const flush = queue.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();

    expect(events).toEqual(["first started"]);
    expect(flushed).toBe(false);

    releaseFirst();
    await flush;
    expect(events).toEqual(["first started", "first finished", "second finished"]);
    expect(flushed).toBe(true);
  });
});
