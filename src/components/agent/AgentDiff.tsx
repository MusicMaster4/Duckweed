import { useMemo, useState } from "react";

import type { AgentFileChange } from "../../lib/agents/types";

/** One rendered row of a change. */
interface Row {
  kind: "ctx" | "add" | "del" | "meta";
  text: string;
}

/** Rows past this are folded behind a "show the rest" control. */
const COLLAPSE_AFTER = 24;

/**
 * Split a unified patch into rows.
 *
 * Codex hands over a patch it already computed, so there is nothing to diff —
 * only the file headers to drop, since the path is already in the row above.
 */
function rowsFromPatch(patch: string): Row[] {
  return patch
    .split("\n")
    .filter((line, index, all) => !(index === all.length - 1 && line === ""))
    .filter((line) => !line.startsWith("+++") && !line.startsWith("---") && !line.startsWith("diff "))
    .map((line) => {
      if (line.startsWith("@@")) return { kind: "meta" as const, text: line };
      if (line.startsWith("+")) return { kind: "add" as const, text: line.slice(1) };
      if (line.startsWith("-")) return { kind: "del" as const, text: line.slice(1) };
      return { kind: "ctx" as const, text: line.startsWith(" ") ? line.slice(1) : line };
    });
}

/**
 * Diff two versions of a fragment.
 *
 * The shared head and tail are matched off and everything between is shown as
 * replaced. That is exactly the shape of the edits agents send — one
 * old_string swapped for one new_string — and it avoids running a real LCS in
 * the render path while an agent streams edits.
 */
function rowsFromTexts(before: string | null, after: string | null): Row[] {
  if (before === null) {
    return (after ?? "").split("\n").map((text) => ({ kind: "add" as const, text }));
  }
  if (after === null) {
    return before.split("\n").map((text) => ({ kind: "del" as const, text }));
  }

  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const rows: Row[] = [];
  for (const text of oldLines.slice(0, head)) rows.push({ kind: "ctx", text });
  for (const text of oldLines.slice(head, oldLines.length - tail)) rows.push({ kind: "del", text });
  for (const text of newLines.slice(head, newLines.length - tail)) rows.push({ kind: "add", text });
  for (const text of oldLines.slice(oldLines.length - tail)) rows.push({ kind: "ctx", text });
  return rows;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function dirname(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

/** One file's change, as the agent proposed or applied it. */
export function AgentDiff({ change }: { change: AgentFileChange }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(
    () => (change.diff ? rowsFromPatch(change.diff) : rowsFromTexts(change.before, change.after)),
    [change.diff, change.before, change.after],
  );

  const folded = !expanded && rows.length > COLLAPSE_AFTER;
  const visible = folded ? rows.slice(0, COLLAPSE_AFTER) : rows;
  const directory = dirname(change.path);

  return (
    <div className="agent-diff">
      <div className="agent-diff-head">
        <span className="agent-diff-path" title={change.path}>
          {directory && <span className="agent-diff-dir">{directory}/</span>}
          {basename(change.path)}
        </span>
        {change.insertions > 0 && <span className="agent-diff-add">+{change.insertions}</span>}
        {change.deletions > 0 && <span className="agent-diff-del">−{change.deletions}</span>}
      </div>
      <div className="agent-diff-body">
        {visible.map((row, index) => (
          <div key={index} className={`agent-diff-line is-${row.kind}`}>
            <span className="agent-diff-mark" aria-hidden="true">
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
            </span>
            <span className="agent-diff-text">{row.text || " "}</span>
          </div>
        ))}
      </div>
      {folded && (
        <button type="button" className="agent-diff-more" onClick={() => setExpanded(true)}>
          Show {rows.length - COLLAPSE_AFTER} more lines
        </button>
      )}
    </div>
  );
}
