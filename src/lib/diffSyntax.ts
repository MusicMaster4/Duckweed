import { highlightCode, langFromPath, type CodeToken } from "./codeSyntax";
import type { DiffHunk } from "./types";

/** Tokenize each revision separately so removed code cannot affect added code. */
export function highlightDiffHunk(hunk: DiffHunk, path: string): CodeToken[][] {
  const result: CodeToken[][] = hunk.lines.map(() => []);
  for (const side of ["old", "new"] as const) {
    const indices = hunk.lines.flatMap((line, index) =>
      line.kind === (side === "old" ? "add" : "del") ? [] : [index],
    );
    const source = indices.map((index) => hunk.lines[index].text).join("\n");
    let row = 0;
    for (const token of highlightCode(source, langFromPath(path))) {
      const parts = token.text.split("\n");
      parts.forEach((text, part) => {
        if (part > 0) row++;
        const index = indices[row];
        if (text && index !== undefined && (side === "new" || hunk.lines[index].kind === "del")) {
          result[index].push({ text, kind: token.kind });
        }
      });
    }
  }
  return result;
}
