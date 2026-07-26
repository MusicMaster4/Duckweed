import { describe, expect, test, beforeEach } from "bun:test";

import {
  acceptFull,
  acceptPartialComponent,
  ghostSuffix,
  rankEntry,
  suggest,
} from "../src/lib/autosuggest.ts";
import * as history from "../src/lib/commandHistory.ts";

describe("autosuggest ranking", () => {
  const cwdA = "H:\\Python\\Slop\\warp-clone";
  const cwdB = "H:\\other\\project";

  test("prefix match wins over non-prefix (non-prefix excluded)", () => {
    const list = [
      { command: "git status", cwd: null, at: 1 },
      { command: "npm test", cwd: null, at: 2 },
      { command: "git commit -m 'x'", cwd: null, at: 3 },
    ];
    expect(suggest("git", list)).toBe("git commit -m 'x'");
    expect(suggest("npm", list)).toBe("npm test");
    expect(suggest("cargo", list)).toBeNull();
  });

  test("more recent wins when scores are otherwise equal", () => {
    const list = [
      { command: "echo old", cwd: null, at: 1 },
      { command: "echo mid", cwd: null, at: 2 },
      { command: "echo new", cwd: null, at: 3 },
    ];
    expect(suggest("echo ", list)).toBe("echo new");
  });

  test("same-cwd preferred over other-cwd when metadata present", () => {
    const list = [
      { command: "bun test scripts/bar", cwd: cwdA, at: 50 },
      { command: "bun test scripts/foo", cwd: cwdB, at: 100 },
    ];
    // cwdA match is older but same-cwd bonus beats pure recency.
    expect(suggest("bun test", list, { cwd: cwdA })).toBe("bun test scripts/bar");
    // Without cwd preference, newest (`at`) wins.
    expect(suggest("bun test", list, { cwd: null })).toBe("bun test scripts/foo");
  });

  test("rankEntry scores same-cwd higher even when other is newer", () => {
    const same = rankEntry({ command: "a", cwd: cwdA, at: 1 }, cwdA);
    const other = rankEntry({ command: "a", cwd: cwdB, at: 9_999_999 }, cwdA);
    expect(same).toBeGreaterThan(other);
  });

  test("exact buffer match is not suggested (needs strict extension)", () => {
    const list = [{ command: "ls", cwd: null, at: 1 }];
    expect(suggest("ls", list)).toBeNull();
  });

  test("empty buffer yields no suggestion", () => {
    const list = [{ command: "pwd", cwd: null, at: 1 }];
    expect(suggest("", list)).toBeNull();
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

describe("shared command history store", () => {
  beforeEach(() => {
    history.clear();
  });

  test("record feeds list used by suggest across calls", () => {
    history.record("cargo build", "H:\\a");
    history.record("cargo test", "H:\\b");
    const suggestion = suggest("cargo ", history.list(), { cwd: "H:\\b" });
    expect(suggestion).toBe("cargo test");
  });

  test("consecutive duplicate collapses and bumps recency", () => {
    history.record("ls", null, 1);
    history.record("ls", "H:\\here", 2);
    expect(history.list()).toHaveLength(1);
    expect(history.list()[0].cwd).toBe("H:\\here");
    expect(history.list()[0].at).toBe(2);
  });

  test("commands() is oldest-first strings for ↑ walk", () => {
    history.record("one", null, 1);
    history.record("two", null, 2);
    expect(history.commands()).toEqual(["one", "two"]);
  });
});
