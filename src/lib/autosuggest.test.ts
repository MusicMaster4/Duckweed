import { describe, expect, test } from "bun:test";

import { suggest } from "./autosuggest";
import type { HistoryEntry } from "./historyMerge";
import { DEMOTE_AFTER, SUPPRESS_AFTER } from "./suggestFeedback";

const entry = (command: string, at: number, cwd: string | null = null): HistoryEntry => ({
  command,
  cwd,
  at,
});

/** In-memory stand-in for the persisted feedback table. */
function table(rejects: Record<string, number>) {
  const count = (command: string) => rejects[command] ?? 0;
  return {
    suppressed: (command: string) => count(command) >= SUPPRESS_AFTER,
    demotion: (command: string) =>
      count(command) <= DEMOTE_AFTER ? 0 : (count(command) - DEMOTE_AFTER) * 60 * 60 * 1000,
  };
}

describe("suggest unlearning", () => {
  const history = [entry("git status", 1_000), entry("git stash pop", 2_000)];

  test("ranks by recency with no feedback", () => {
    expect(suggest("git st", history, table({}))).toBe("git stash pop");
  });

  test("a few rejects do not change anything", () => {
    expect(suggest("git st", history, table({ "git stash pop": DEMOTE_AFTER }))).toBe(
      "git stash pop",
    );
  });

  test("sustained rejects let the rival win", () => {
    expect(suggest("git st", history, table({ "git stash pop": DEMOTE_AFTER + 2 }))).toBe(
      "git status",
    );
  });

  test("suppressed commands stop being suggested at all", () => {
    const rejected = table({ "git stash pop": SUPPRESS_AFTER, "git status": SUPPRESS_AFTER });
    expect(suggest("git st", history, rejected)).toBeNull();
  });
});
