import { describe, expect, test } from "bun:test";

import {
  acceptFull,
  acceptPartialComponent,
  ghostSuffix,
  rankEntry,
  suggest,
} from "./autosuggest";
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

describe("autosuggest ranking", () => {
  const cwdA = "H:\\Python\\Slop\\warp-clone";
  const cwdB = "H:\\other\\project";

  test("prefix match wins over non-prefix (non-prefix excluded)", () => {
    const list = [
      entry("git status", 1),
      entry("npm test", 2),
      entry("git commit -m 'x'", 3),
    ];
    expect(suggest("git", list)).toBe("git commit -m 'x'");
    expect(suggest("npm", list)).toBe("npm test");
    expect(suggest("cargo", list)).toBeNull();
  });

  test("more recent wins when scores are otherwise equal", () => {
    const list = [entry("echo old", 1), entry("echo mid", 2), entry("echo new", 3)];
    expect(suggest("echo ", list)).toBe("echo new");
  });

  test("same-cwd preferred over other-cwd when metadata present", () => {
    const list = [
      entry("bun test scripts/bar", 50, cwdA),
      entry("bun test scripts/foo", 100, cwdB),
    ];
    // cwdA match is older but same-cwd bonus beats pure recency.
    expect(suggest("bun test", list, { cwd: cwdA })).toBe("bun test scripts/bar");
    // Without cwd preference, newest (`at`) wins.
    expect(suggest("bun test", list, { cwd: null })).toBe("bun test scripts/foo");
  });

  test("rankEntry scores same-cwd higher even when other is newer", () => {
    const same = rankEntry(entry("a", 1, cwdA), cwdA);
    const other = rankEntry(entry("a", 9_999_999, cwdB), cwdA);
    expect(same).toBeGreaterThan(other);
  });

  test("exact buffer match is not suggested (needs strict extension)", () => {
    expect(suggest("ls", [entry("ls", 1)])).toBeNull();
  });

  test("empty buffer yields no suggestion", () => {
    expect(suggest("", [entry("pwd", 1)])).toBeNull();
  });
});

describe("ghost suffix and accept", () => {
  test("ghostSuffix is the unmatched tail", () => {
    expect(ghostSuffix("git st", "git status")).toBe("atus");
    expect(ghostSuffix("git status", "git status")).toBe("");
    expect(ghostSuffix("x", null)).toBe("");
  });

  test("acceptFull replaces buffer with suggestion", () => {
    expect(acceptFull("gi", "git status")).toBe("git status");
    expect(acceptFull("nope", "git status")).toBe("nope");
  });

  test("partial component accept leaves a correct remaining suffix", () => {
    // Word components (fish/Warp forward-word: space + next token).
    let buf = "git";
    const full = "git checkout main";
    buf = acceptPartialComponent(buf, full);
    expect(buf).toBe("git checkout");
    expect(ghostSuffix(buf, full)).toBe(" main");
    buf = acceptPartialComponent(buf, full);
    expect(buf).toBe("git checkout main");
    expect(ghostSuffix(buf, full)).toBe("");

    // From a trailing space, next accept takes the following word.
    buf = "git ";
    buf = acceptPartialComponent(buf, full);
    expect(buf).toBe("git checkout");
    expect(ghostSuffix(buf, full)).toBe(" main");

    // Path components include trailing separator when present.
    buf = "cd H:";
    const pathFull = "cd H:\\Python\\Slop\\warp-clone";
    buf = acceptPartialComponent(buf, pathFull);
    expect(buf).toBe("cd H:\\Python\\");
    expect(ghostSuffix(buf, pathFull)).toBe("Slop\\warp-clone");
    buf = acceptPartialComponent(buf, pathFull);
    expect(buf).toBe("cd H:\\Python\\Slop\\");
    expect(ghostSuffix(buf, pathFull)).toBe("warp-clone");
    buf = acceptPartialComponent(buf, pathFull);
    expect(buf).toBe(pathFull);
    expect(ghostSuffix(buf, pathFull)).toBe("");
  });
});

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
