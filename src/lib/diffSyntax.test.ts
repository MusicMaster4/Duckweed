import { expect, test } from "bun:test";
import { highlightDiffHunk } from "./diffSyntax";
import type { DiffHunk } from "./types";

test("preserves diff text and multiline comments independently for both revisions", () => {
  const hunk: DiffHunk = {
    old_start: 1, new_start: 1,
    lines: [
      { kind: "del", old: 1, new: null, text: "/* removed comment" },
      { kind: "del", old: 2, new: null, text: "still a comment */" },
      { kind: "add", old: null, new: 1, text: 'const value = "hello";' },
      { kind: "ctx", old: 3, new: 2, text: "" },
      { kind: "ctx", old: 4, new: 3, text: "/* shared comment" },
      { kind: "ctx", old: 5, new: 4, text: "continued */" },
    ],
  };
  const rows = highlightDiffHunk(hunk, "arrival sprites.ts");
  expect(rows.map((tokens) => tokens.map((token) => token.text).join("")))
    .toEqual(hunk.lines.map((line) => line.text));
  expect(rows[1].every((token) => token.kind === "comment")).toBe(true);
  expect(rows[2].some((token) => token.kind === "keyword" && token.text === "const")).toBe(true);
  expect(rows[2].some((token) => token.kind === "string")).toBe(true);
  expect(rows[5].every((token) => token.kind === "comment")).toBe(true);
});

test("unknown extensions remain plain text", () => {
  const hunk: DiffHunk = {
    old_start: 0, new_start: 1,
    lines: [{ kind: "add", old: null, new: 1, text: "<hello> & world" }],
  };
  expect(highlightDiffHunk(hunk, "notes.txt")[0]).toEqual([
    { kind: "plain", text: "<hello> & world" },
  ]);
});
