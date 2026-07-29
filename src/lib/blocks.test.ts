import { describe, expect, test } from "bun:test";

import {
  BlockTracker,
  type CommandBlock,
  foldOrphanPrompts,
  logicalLineEnd,
  logicalLineStart,
  looksLikePrompt,
  resolveBlockEnd,
  wrappedCommandEnd,
} from "./blocks";

describe("looksLikePrompt", () => {
  test("matches classic PowerShell idle prompts", () => {
    expect(looksLikePrompt("PS H:\\Python\\Slop\\duckweed>")).toBe(true);
    expect(looksLikePrompt("PS C:\\Users\\me>")).toBe(true);
    expect(looksLikePrompt("PS /home/me>")).toBe(true);
    expect(looksLikePrompt("PS>")).toBe(true);
  });

  test("matches conda-prefixed PowerShell prompts", () => {
    expect(looksLikePrompt("(base) PS H:\\Python\\Slop\\duckweed>")).toBe(true);
  });

  test("matches PowerShell ^C chrome", () => {
    expect(looksLikePrompt("PS H:\\path> ^C")).toBe(true);
  });

  test("matches simple bash/zsh prompts", () => {
    expect(looksLikePrompt("user@host:~/projects$")).toBe(true);
    expect(looksLikePrompt("~/code %")).toBe(true);
  });

  test("does not treat empty as a prompt (blanks are handled separately)", () => {
    expect(looksLikePrompt("")).toBe(false);
    expect(looksLikePrompt("   ")).toBe(false);
  });

  test("does not swallow ordinary command output", () => {
    expect(looksLikePrompt("✓ done")).toBe(false);
    expect(looksLikePrompt("21 files changed, 1498 insertions(+), 72 deletions(-)")).toBe(false);
    expect(looksLikePrompt("git push 2.2s")).toBe(false);
    expect(looksLikePrompt("message feat: add tools panel")).toBe(false);
    // Diff / log lines that merely end with `>` must not count as chrome.
    expect(looksLikePrompt("compare with origin/main >")).toBe(false);
  });

  test("does not mistake a PowerShell command echo for an idle prompt", () => {
    expect(looksLikePrompt("PS H:\\Python\\Slop\\duckweed> gg c")).toBe(false);
  });
});

describe("foldOrphanPrompts", () => {
  /** Build a getLine from a sparse map of absolute buffer lines. */
  function lines(map: Record<number, string>) {
    return (y: number) => map[y] ?? "";
  }

  test("does not move when the row above is real output", () => {
    const getLine = lines({
      4: "cargo build finished",
      5: "PS H:\\proj> next",
    });
    expect(foldOrphanPrompts(getLine, 5, 0)).toBe(5);
  });

  test("folds consecutive idle prompts above the command", () => {
    const getLine = lines({
      2: "done",
      3: "PS H:\\proj>",
      4: "PS H:\\proj> ^C",
      5: "PS H:\\proj> next",
    });
    // minLine 3 = first line after previous chunk end (2).
    expect(foldOrphanPrompts(getLine, 5, 3)).toBe(3);
  });

  test("never walks into the previous chunk even if lines look like prompts", () => {
    // Previous chunk ends at line 4 (minLine = 5). Line 4 looks like a prompt
    // but is still owned by the previous block — folding must stop at 5.
    const getLine = lines({
      3: "output mid-chunk",
      4: "PS H:\\proj>",
      5: "PS H:\\proj>",
      6: "PS H:\\proj> next",
    });
    expect(foldOrphanPrompts(getLine, 6, 5)).toBe(5);
    // Without the clamp this would climb to 4 and put the hairline mid-chunk.
    expect(foldOrphanPrompts(getLine, 6, 0)).toBe(4);
  });

  test("stops at buffer start", () => {
    const getLine = lines({
      0: "PS H:\\proj>",
      1: "PS H:\\proj> first",
    });
    expect(foldOrphanPrompts(getLine, 1, 0)).toBe(0);
    expect(foldOrphanPrompts(getLine, 1, -1)).toBe(0);
  });

  test("leaves the command row alone when minLine equals commandStart", () => {
    const getLine = lines({
      4: "PS H:\\proj>",
      5: "PS H:\\proj> next",
    });
    expect(foldOrphanPrompts(getLine, 5, 5)).toBe(5);
  });

  test("folds a wrapped idle prompt as one logical line", () => {
    const getLine = lines({
      2: "PS H:\\a-very-long-",
      3: "project-path>",
      4: "PS H:\\proj> next",
    });
    const isWrapped = (y: number) => y === 3;
    expect(foldOrphanPrompts(getLine, 4, 2, isWrapped)).toBe(2);
  });
});

describe("logical terminal lines", () => {
  const wrapped = (y: number) => y === 4 || y === 5;

  test("finds the durable first row from a wrapped continuation", () => {
    expect(logicalLineStart(wrapped, 5)).toBe(3);
    expect(logicalLineStart(wrapped, 4)).toBe(3);
    expect(logicalLineStart(wrapped, 3)).toBe(3);
  });

  test("finds every continuation row after the logical start", () => {
    expect(logicalLineEnd(wrapped, 3, 8)).toBe(5);
    expect(logicalLineEnd(wrapped, 6, 8)).toBe(6);
  });

  test("respects a previous-block floor", () => {
    expect(logicalLineStart(wrapped, 5, 4)).toBe(4);
  });
});

describe("BlockTracker reflow boundaries", () => {
  type Row = { text: string; isWrapped?: boolean };

  function fakeTerm(rows: Record<number, Row>, cursorLine: number) {
    return {
      buffer: {
        active: {
          baseY: 0,
          cursorY: cursorLine,
          length: cursorLine + 1,
          getLine(y: number) {
            const row = rows[y];
            if (!row) return undefined;
            return {
              isWrapped: row.isWrapped ?? false,
              translateToString: () => row.text,
            };
          },
        },
      },
    };
  }

  function marker(line: number) {
    return { line, isDisposed: false };
  }

  test("uses the next logical start instead of a reflow-unsafe end marker", () => {
    const rows: Record<number, Row> = {
      2: { text: "PS H:\\proj> first" },
      3: { text: "output 1" },
      4: { text: "output 2" },
      5: { text: "output 3" },
      6: { text: "output 4" },
      7: { text: "output 5" },
      8: { text: "output 6" },
      9: { text: "PS H:\\proj>" },
      10: { text: "PS H:\\proj> second" },
    };
    const first = { id: 1, command: "first", start: marker(2) };
    const second = { id: 2, command: "second", start: marker(10) };
    const tracker = Object.create(BlockTracker.prototype) as BlockTracker;
    Object.assign(tracker as object, {
      term: fakeTerm(rows, 10),
      blocks: [first, second],
    });

    expect(tracker.range(first as unknown as CommandBlock)).toEqual({ start: 2, end: 8 });

    // A narrower terminal inserts physical rows inside the first output. The
    // next command marker moves with those insertions, so the boundary follows.
    second.start.line = 14;
    rows[12] = { text: "last wrapped output", isWrapped: true };
    rows[13] = { text: "PS H:\\proj>" };
    rows[14] = { text: "PS H:\\proj> second" };
    expect(tracker.range(first as unknown as CommandBlock)).toEqual({ start: 2, end: 12 });

    // Growing wider removes the inserted rows. No disposed end marker is
    // consulted, so the block contracts to the new semantic boundary.
    second.start.line = 8;
    rows[6] = { text: "last joined output" };
    rows[7] = { text: "PS H:\\proj>" };
    rows[8] = { text: "PS H:\\proj> second" };
    expect(tracker.range(first as unknown as CommandBlock)).toEqual({ start: 2, end: 6 });
  });

  test("copy skips every physical row of a wrapped command echo", () => {
    const rows: Record<number, Row> = {
      0: { text: "PS H:\\a-very-long-project> long " },
      1: { text: "command", isWrapped: true },
      2: { text: "result" },
      3: { text: "PS H:\\a-very-long-project>" },
    };
    const block = { id: 1, command: "long command", start: marker(0) };
    const tracker = Object.create(BlockTracker.prototype) as BlockTracker;
    Object.assign(tracker as object, {
      term: fakeTerm(rows, 3),
      blocks: [block],
      selectedId: 1,
    });

    expect(tracker.copyText()).toBe("long command\nresult");
  });
});

describe("resolveBlockEnd", () => {
  test("uses the next block start after a narrower reflow inserts rows", () => {
    // The old end marker stayed at 8, but the wrapped output now reaches 11.
    expect(resolveBlockEnd(4, 12, 8, () => 30)).toBe(11);
  });

  test("uses the next block start after a wider reflow disposes the end marker", () => {
    expect(resolveBlockEnd(4, 9, null, () => 30)).toBe(8);
  });

  test("keeps marker and live fallbacks for the final block", () => {
    expect(resolveBlockEnd(4, null, 8, () => 30)).toBe(8);
    expect(resolveBlockEnd(4, null, null, () => 12)).toBe(12);
  });
});

describe("wrappedCommandEnd", () => {
  test("covers every continuation row created by terminal reflow", () => {
    const wrapped = new Set([6, 7]);
    expect(wrappedCommandEnd((y) => wrapped.has(y), 5, 12)).toBe(7);
  });

  test("stops before output and never passes the block boundary", () => {
    expect(wrappedCommandEnd((y) => y === 6, 5, 5)).toBe(5);
    expect(wrappedCommandEnd((y) => y === 6, 5, 9)).toBe(6);
  });
});
