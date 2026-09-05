import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { gitDiff, gitDiscardAll, gitFileDiff } from "../lib/ipc";
import { confirmCloseRunning, getConfirmClose } from "../lib/confirmClose";
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

const MoreIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="3" cy="8" r="1" />
    <circle cx="8" cy="8" r="1" />
    <circle cx="13" cy="8" r="1" />
  </svg>
);

const DiscardIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 4.5h10M6 4.5V3h4v1.5M5 6.5v6M8 6.5v6M11 6.5v6M4 4.5l.7 9h6.6l.7-9" />
  </svg>
);

/**
 * Past this many changed lines a file opens folded. Every line is a row of its
 * own in the DOM, and a generated lockfile in the diff should not decide how
 * long the panel takes to appear.
 */
const FOLD_OVER_LINES = 2000;

/** How many project diffs to keep for reopening the panel without a blank wait. */
const DIFF_CACHE_LIMIT = 8;

/**
 * Last full working-tree read per project path. A reopen (or tab switch with the
 * panel still open) paints the previous result immediately and revalidates.
 */
const diffCache = new Map<string, Diff>();

function rememberDiff(path: string, diff: Diff): void {
  if (diffCache.has(path)) diffCache.delete(path);
  diffCache.set(path, diff);
  while (diffCache.size > DIFF_CACHE_LIMIT) {
    const oldest = diffCache.keys().next().value;
    if (oldest === undefined) break;
    diffCache.delete(oldest);
  }
}

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
  const [load, setLoad] = useState<Load>(() => {
    const cached = diffCache.get(project.path);
    return cached ? { kind: "ready", diff: cached } : { kind: "loading" };
  });
  /** Files whose body is folded away. */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  /** Files showing every line, not just the hunks. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Full-context copies, fetched once per file and kept for the toggle back. */
  const [full, setFull] = useState<Record<string, FileDiff>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  /** Files already sized up once, so a refresh cannot re-fold what was opened. */
  const judged = useRef(new Set<string>());
  /** Monotonic token so an older gitDiff cannot overwrite a newer one. */
  const loadGen = useRef(0);

  const applyDiff = useCallback((diff: Diff, preserveUi: boolean) => {
    setLoad({ kind: "ready", diff });
    if (!preserveUi) {
      // Fresh tree: drop expanded full-file views that no longer match disk.
      setFull({});
      setExpanded(new Set());
    }
    setClosed((prev) => {
      const next = preserveUi ? new Set(prev) : new Set<string>();
      for (const file of diff.files) {
        if (judged.current.has(file.path)) {
          // Keep the user's fold choice for files already seen.
          if (prev.has(file.path)) next.add(file.path);
          continue;
        }
        judged.current.add(file.path);
        if (lineCount(file) > FOLD_OVER_LINES) next.add(file.path);
      }
      return next;
    });
  }, []);

  const reload = useCallback(() => {
    const path = project.path;
    const cached = diffCache.get(path);
    const gen = ++loadGen.current;
    // Stale-while-revalidate: keep the last good view up while git re-reads.
    if (cached) setLoad({ kind: "ready", diff: cached });
    else setLoad({ kind: "loading" });

    gitDiff(path)
      .then((diff) => {
        if (gen !== loadGen.current) return;
        rememberDiff(path, diff);
        applyDiff(diff, Boolean(cached));
      })
      .catch((error: unknown) => {
        if (gen !== loadGen.current) return;
        // Keep the cached panel up rather than replacing a useful view with an error.
        if (!cached) setLoad({ kind: "error", message: String(error) });
      });
  }, [applyDiff, project.path]);

  useEffect(() => {
    // Fold/expand choices are per project; a path change starts a fresh judgment.
    judged.current = new Set();
    setClosed(new Set());
    setExpanded(new Set());
    setFull({});
    reload();
  }, [reload]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("project:changed", (event) => {
      if (event.payload !== project.path) return;
      // Working tree moved. Leave the last paint up; reload revalidates and
      // replaces it once the new read lands.
      reload();
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [project.path, reload]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The app-level confirmation owns Escape while it is visible.
      if (getConfirmClose()) return;
      e.preventDefault();
      e.stopPropagation();
      if (actionsOpen) {
        setActionsOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actionsOpen, onClose]);

  useEffect(() => {
    if (!actionsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    return () => window.removeEventListener("pointerdown", closeOutside, true);
  }, [actionsOpen]);

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

  const discardAll = useCallback(async () => {
    setActionsOpen(false);
    const newFiles = files.filter(
      (file) => file.status === "added" || file.status === "untracked",
    ).length;
    const fileLabel = `${files.length} file${files.length === 1 ? "" : "s"}`;
    const newFileWarning = newFiles > 0
      ? ` ${newFiles} new file${newFiles === 1 ? "" : "s"} will be permanently deleted.`
      : "";
    const confirmed = await confirmCloseRunning({
      title: "Discard all changes?",
      message: `Discard changes in ${fileLabel}? Tracked files will be restored.${newFileWarning} This cannot be undone.`,
      confirmLabel: "Discard all",
    });
    if (!confirmed) return;

    setDiscarding(true);
    setDiscardError(null);
    try {
      await gitDiscardAll(project.path);
      diffCache.delete(project.path);
      judged.current = new Set();
      setClosed(new Set());
      setExpanded(new Set());
      setFull({});
      reload();
    } catch (error: unknown) {
      setDiscardError(String(error));
      // Reset or clean can fail after making partial progress. Re-read the
      // repository so the panel never keeps showing the pre-discard snapshot.
      diffCache.delete(project.path);
      reload();
    } finally {
      setDiscarding(false);
    }
  }, [files, project.path, reload]);

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
          <div className="changes-actions" ref={actionsRef}>
            <button
              type="button"
              className="changes-btn is-icon"
              title="Repository actions"
              aria-label="Repository actions"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((open) => !open)}
            >
              <MoreIcon />
            </button>
            {actionsOpen && (
              <div className="changes-actions-menu" role="menu">
                <button
                  type="button"
                  className="is-danger"
                  role="menuitem"
                  disabled={discarding || files.length === 0}
                  onClick={() => void discardAll()}
                >
                  <DiscardIcon />
                  <span>Discard all</span>
                </button>
              </div>
            )}
          </div>
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

        {discardError && (
          <div className="changes-error" role="alert">
            <span>{discardError}</span>
            <button type="button" onClick={() => setDiscardError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        {discarding && <div className="changes-progress">discarding changes...</div>}

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
