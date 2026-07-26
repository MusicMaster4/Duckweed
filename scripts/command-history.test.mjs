import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_HISTORY_ENTRIES,
  mergeHistory,
  mergeHistoryRaw,
  parseHistory,
} from "../src/lib/historyMerge.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("ghost-text history merging", () => {
  test("keeps commands a stale snapshot never saw", () => {
    const stored = [{ command: "cargo build", cwd: "/a", at: 1 }];
    const incoming = [{ command: "npm test", cwd: "/a", at: 2 }];
    expect(mergeHistory(stored, incoming).map((e) => e.command)).toEqual([
      "cargo build",
      "npm test",
    ]);
  });

  test("is idempotent and ordered oldest first", () => {
    const stored = [
      { command: "ls", cwd: "/a", at: 5 },
      { command: "pwd", cwd: "/a", at: 1 },
    ];
    const once = mergeHistory(stored, stored);
    expect(once.map((e) => e.command)).toEqual(["pwd", "ls"]);
    expect(mergeHistory(once, stored)).toEqual(once);
  });

  test("bumps recency for the same cwd but keeps other directories", () => {
    const merged = mergeHistory(
      [{ command: "ls", cwd: "/a", at: 1 }],
      [
        { command: "ls", cwd: "/a", at: 9 },
        { command: "ls", cwd: "/b", at: 4 },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].cwd).toBe("/b");
    expect(merged[1].at).toBe(9);
  });

  test("caps the list at the newest entries", () => {
    const many = Array.from({ length: MAX_HISTORY_ENTRIES + 20 }, (_, i) => ({
      command: `c${i}`,
      cwd: null,
      at: i,
    }));
    const merged = mergeHistory([], many);
    expect(merged).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(merged[0].command).toBe("c20");
  });

  test("raw merge tolerates a corrupt or missing stored copy", () => {
    const incoming = JSON.stringify([{ command: "ls", cwd: null, at: 1 }]);
    expect(parseHistory(mergeHistoryRaw("not json", incoming))).toHaveLength(1);
    expect(parseHistory(mergeHistoryRaw(null, incoming))).toHaveLength(1);
    expect(parseHistory(mergeHistoryRaw(undefined, undefined))).toEqual([]);
  });
});

describe("ghost-text history outlives app updates", () => {
  test("restore unions the native copy with WebView storage", () => {
    const durable = read("src/lib/durableStorage.ts");
    expect(durable).toContain("mergeHistoryRaw");
    expect(durable).toContain("COMMAND_HISTORY_KEY");
  });

  test("the native copy merges on save instead of being replaced", () => {
    const backend = read("src-tauri/src/main.rs");
    expect(backend).toContain("fn merge_history(");
    expect(backend).toContain("key == COMMAND_HISTORY_KEY && !replace.unwrap_or(false)");
  });

  test("history reads durable storage without importing it at bootstrap", () => {
    // historyMerge must stay side-effect free: durableStorage uses it before
    // commandHistory is imported and snapshots its initial state.
    const merge = read("src/lib/historyMerge.ts");
    expect(merge).not.toContain("localStorage.");
    expect(merge).not.toContain('from "./commandHistory"');
  });
});
