import { beforeEach, describe, expect, test } from "bun:test";

import { suggest } from "./autosuggest";
import * as history from "./commandHistory";

describe("shared command history store", () => {
  beforeEach(() => {
    history.clear();
  });

  test("record feeds list used by suggest across calls", () => {
    history.record("cargo build", "H:\\a");
    history.record("cargo test", "H:\\b");
    expect(suggest("cargo ", history.list(), { cwd: "H:\\b" })).toBe("cargo test");
  });

  test("consecutive duplicate collapses and bumps recency", () => {
    history.record("ls", null, 1);
    history.record("ls", "H:\\here", 2);
    expect(history.list()).toHaveLength(1);
    expect(history.list()[0].cwd).toBe("H:\\here");
    expect(history.list()[0].at).toBe(2);
  });

  test("commands() is oldest-first strings for the up-arrow walk", () => {
    history.record("one", null, 1);
    history.record("two", null, 2);
    expect(history.commands()).toEqual(["one", "two"]);
  });

  test("subscribers see changes that can refresh visible ghost text", () => {
    let changes = 0;
    const unsubscribe = history.subscribe(() => changes++);
    history.record("bun run app", null, 1);
    history.replaceAll([{ command: "git status", cwd: null, at: 2 }]);
    unsubscribe();
    history.record("ignored by listener", null, 3);
    expect(changes).toBe(2);
  });
});
