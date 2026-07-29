import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gitDiff, gitFileDiff } from "../lib/ipc";
import type { Diff, DiffHunk, FileDiff, ProjectInfo } from "../lib/types";
import { AsciiAmbient } from "./AsciiAmbient";

interface Props {
  /** The tab's repo — every path in the panel is relative to its root. */
  project: ProjectInfo;
  onClose: () => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; diff: Diff }
  | { kind: "error"; message: string };

/** What the header of a file says it is. */
const STATUS_LABEL: Record<FileDiff["status"], string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "new file",
};

const Chevron = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="diff-chevron">
    <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="6" y="6" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M10 6V3.5A1.5 1.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v5A1.5 1.5 0 0 0 3.5 10H6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

const CompareIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3 5.5h7l-2-2M13 10.5H6l2 2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Past this many changed lines a file opens folded. Every line is a row of its
 * own in the DOM, and a generated lockfile in the diff should not decide how
 * long the panel takes to appear.
 */
const FOLD_OVER_LINES = 2000;

/** Lines of a hunk that still exist in the file as it is now. */
function newSpan(hunk: DiffHunk): number {
  return hunk.lines.reduce((n, line) => (line.kind === "del" ? n : n + 1), 0);
}

function lineCount(file: FileDiff): number {
  return file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0);
}

type Row = { kind: "gap"; lines: number; key: string } | { kind: "hunk"; hunk: DiffHunk; key: string };

/**
 * The hunks of a file, with the untouched runs between them turned into a row
 * of their own. A patch carries three lines of context; everything past that is
 * a gap the viewer reports the size of and can go and fetch.
 */
function rowsFor(file: FileDiff): Row[] {
  const rows: Row[] = [];
  /** Last line of the current file already accounted for. */
  let covered = 0;
  file.hunks.forEach((hunk, i) => {
    const gap = hunk.new_start - covered - 1;
    if (gap > 0) rows.push({ kind: "gap", lines: gap, key: `gap-${i}` });
    rows.push({ kind: "hunk", hunk, key: `hunk-${i}` });
    covered = hunk.new_start + newSpan(hunk) - 1;
  });
  const tail = file.new_lines - Math.max(covered, 0);
  if (tail > 0) rows.push({ kind: "gap", lines: tail, key: "gap-tail" });
  return rows;
}

/** The file rebuilt as a patch, which is what a copy button should hand over. */
function asPatch(file: FileDiff): string {
  const head = `--- a/${file.old_path ?? file.path}\n+++ b/${file.path}\n`;
  const body = file.hunks
    .map((hunk) => {
      const sign = { add: "+", del: "-", ctx: " " } as const;
      const lines = hunk.lines.map((line) => `${sign[line.kind]}${line.text}`).join("\n");
      return `@@ -${hunk.old_start} +${hunk.new_start} @@\n${lines}`;
    })
    .join("\n");
  return `${head}${body}\n`;
}

function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? ["", path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** `2 files · +99 −12`, the same three numbers the status-bar chip shows. */
function StatChip({ files, insertions, deletions }: { files?: number; insertions: number; deletions: number }) {
  return (
    <span className="diff-chip">
      {files !== undefined && (
        <>
          <span className="diff-chip-files">{files}</span>
          <span className="diff-chip-dot">•</span>
        </>
      )}
      <span className="diff-chip-add">+{insertions}</span>
      <span className="diff-chip-del">−{deletions}</span>
    </span>
  );
}

/**
 * Everything not committed yet, file by file.
 *
 * Warp puts this behind the diff chip in its bottom bar, and the shape is worth
 * copying: a chip you can read without stopping, and one click to the detail.
 * The panel is read-only — committing is the shell's job, and the shell is
 * right there.
 */
export function ChangesPanel({ project, onClose }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  /** Files whose body is folded away. */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  /** Files showing every line, not just the hunks. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Full-context copies, fetched once per file and kept for the toggle back. */
  const [full, setFull] = useState<Record<string, FileDiff>>({});
  const [copied, setCopied] = useState<string | null>(null);
  /** Files already sized up once, so a refresh cannot re-fold what was opened. */
  const judged = useRef(new Set<string>());

  const reload = useCallback(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    gitDiff(project.path)
      .then((diff) => {
        if (cancelled) return;
        setLoad({ kind: "ready", diff });
        // The file on disk moved on; anything already fetched is stale.
        setFull({});
        setExpanded(new Set());
        setClosed((prev) => {
          const next = new Set(prev);
          for (const file of diff.files) {
            if (judged.current.has(file.path)) continue;
            judged.current.add(file.path);
            if (lineCount(file) > FOLD_OVER_LINES) next.add(file.path);
          }
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ kind: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const files = load.kind === "ready" ? load.diff.files : [];

  /** What is actually drawn for a file: the patch, or its full-context twin. */
  const shown = useCallback(
    (file: FileDiff) => (expanded.has(file.path) ? full[file.path] ?? file : file),
    [expanded, full],
  );

  const toggleFile = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const showAll = useCallback(
    (path: string) => {
      setExpanded((prev) => new Set(prev).add(path));
      if (full[path]) return;
      gitFileDiff(project.path, path)
        .then((file) => setFull((prev) => ({ ...prev, [path]: file })))
        .catch(() => {
          // Nothing to fall back to but the hunks we already have.
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        });
    },
    [full, project.path],
  );

  const hideUnchanged = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });

  const copy = (file: FileDiff) => {
    void navigator.clipboard.writeText(asPatch(shown(file)));
    setCopied(file.path);
    window.setTimeout(() => setCopied((p) => (p === file.path ? null : p)), 1200);
  };

  const allClosed = files.length > 0 && files.every((f) => closed.has(f.path));
  const stats = load.kind === "ready" ? load.diff.stats : null;

  const body = useMemo(
    () =>
      files.map((file) => {
        const view = shown(file);
        const isClosed = closed.has(file.path);
        const isExpanded = expanded.has(file.path);
        const [dir, name] = splitPath(file.path);
        const rows = isClosed ? [] : rowsFor(view);

        return (
          <section key={file.path} className={`diff-file ${isClosed ? "is-closed" : ""}`}>
            <header className="diff-file-head">
              <button
                type="button"
                className="diff-file-toggle"
                title={isClosed ? "Show this file's changes" : "Hide this file's changes"}
                onClick={() => toggleFile(file.path)}
              >
                <Chevron />
                <span className="diff-file-path">
                  {dir && <span className="diff-file-dir">{dir}</span>}
                  <span className="diff-file-name">{name}</span>
                </span>
              </button>

              {file.old_path && <span className="diff-file-from">from {file.old_path}</span>}
              <span className={`diff-file-status is-${file.status}`}>{STATUS_LABEL[file.status]}</span>
              <span className="diff-spacer" />

              {isExpanded && !isClosed && (
                <button
                  type="button"
                  className="diff-file-action"
                  title="Collapse the unmodified lines again"
                  onClick={() => hideUnchanged(file.path)}
                >
                  collapse
                </button>
              )}
              <button
                type="button"
                className="diff-file-action"
                title="Copy this file's diff"
                onClick={() => copy(file)}
              >
                {copied === file.path ? "copied" : <CopyIcon />}
              </button>
              <StatChip insertions={file.insertions} deletions={file.deletions} />
            </header>

            {!isClosed && view.binary && (
              <div className="diff-empty">Binary file — nothing to show.</div>
            )}
            {!isClosed && !view.binary && rows.length === 0 && (
              <div className="diff-empty">No textual changes.</div>
            )}

            {/* One scroll container for the whole file, so a single long line
                does not give itself a scrollbar the other lines lack. */}
            {rows.length > 0 && (
              <div className="diff-body">
                {rows.map((row) =>
                  row.kind === "gap" ? (
                    <button
                      key={row.key}
                      type="button"
                      className="diff-gap"
                      title="Show these lines"
                      onClick={() => showAll(file.path)}
                    >
                      <span className="diff-gap-mark">⋯</span>
                      {row.lines} unmodified line{row.lines === 1 ? "" : "s"}
                    </button>
                  ) : (
                    <div key={row.key} className="diff-hunk">
                      {row.hunk.lines.map((line, i) => (
                        <div key={i} className={`diff-line is-${line.kind}`}>
                          <span className="diff-no">{line.new ?? ""}</span>
                          <code className="diff-text">{line.text || " "}</code>
                        </div>
                      ))}
                    </div>
                  ),
                )}
              </div>
            )}
          </section>
        );
      }),
    [closed, copied, expanded, files, shown, showAll],
  );

  return (
    <div className="changes-backdrop" onPointerDown={onClose}>
      <div className="changes" onPointerDown={(e) => e.stopPropagation()}>
        <header className="changes-head">
          <span className="changes-repo" title={project.path}>
            {project.path}
          </span>
          <span className="changes-branch">{project.branch ?? "detached"}</span>
          {stats && stats.files > 0 && (
            <StatChip files={stats.files} insertions={stats.insertions} deletions={stats.deletions} />
          )}
          <span className="diff-spacer" />
          <button type="button" className="changes-btn" title="Re-read the working tree" onClick={reload}>
            refresh
          </button>
          <button type="button" className="changes-btn" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="changes-sub">
          <CompareIcon />
          <span>Uncommitted changes</span>
          {files.length > 0 && (
            <button
              type="button"
              className="changes-btn"
              onClick={() => setClosed(allClosed ? new Set() : new Set(files.map((f) => f.path)))}
            >
              {allClosed ? "expand all" : "collapse all"}
            </button>
          )}
        </div>

        <div className="changes-body">
          {load.kind === "loading" && <div className="diff-empty">reading the working tree…</div>}
          {load.kind === "error" && <div className="menu-error">{load.message}</div>}
          {load.kind === "ready" && files.length === 0 && (
            <div className="diff-empty is-ambient">
              <AsciiAmbient surfaceId="changes-clean" scene="ripple" />
              <p>Nothing uncommitted — the working tree is clean.</p>
            </div>
          )}
          {body}
        </div>
      </div>
    </div>
  );
}
