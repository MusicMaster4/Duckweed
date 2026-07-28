import { describe, expect, test } from "bun:test";

import {
  MAX_HISTORY_ENTRIES,
  mergeHistory,
  mergeHistoryRaw,
  parseHistory,
} from "./historyMerge";

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
