import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listDir } from "../lib/ipc";
import type { DirEntry, ProjectInfo } from "../lib/types";
import { AsciiAmbient } from "./AsciiAmbient";

interface Props {
  /** Folder of the visible tab — the tree's root, and all it ever shows. */
  project: ProjectInfo | null;
  /** Send a path to the focused shell's input, for a file that was opened. */
  onInsertPath: (path: string) => void;
  /** Take the focused shell to a folder. */
  onOpenFolder: (path: string) => void;
  onBrowseProject: () => void;
  /**
   * Open a file in the popup editor. Lives above this panel so tab switches
   * and hiding the tools rail cannot silently discard a dirty buffer.
   */
  onOpenFile: (path: string) => void;
}

/** A level that has been asked for: its entries, or why they never arrived. */
type Load = { entries: DirEntry[] } | { error: string };

type Row =
  | { kind: "entry"; key: string; depth: number; entry: DirEntry }
  | { kind: "note"; key: string; depth: number; text: string; error?: boolean };

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={`tree-chevron ${open ? "is-open" : ""}`}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="tree-icon is-folder">
    {open ? (
      <path d="M2 13V4.5A1 1 0 0 1 3 3.5h3l1.4 1.6h4.2a1 1 0 0 1 1 1V7M2 13l1.7-4.6a1 1 0 0 1 .95-.65h9.4a.6.6 0 0 1 .56.8L13 13z" />
    ) : (
      <path d="M2 12.5v-8a1 1 0 0 1 1-1h3l1.4 1.6h5.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    )}
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="tree-icon">
    <path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z" />
    <path d="M9 2v3.5h3.5" />
  </svg>
);

/**
 * The folder of the visible tab, one level at a time.
 *
 * Lazy on purpose: a level is read when it is opened and kept until the panel is
 * refreshed, so `node_modules` costs nothing until someone actually asks for it.
 * Ignored entries are listed but dimmed — the same call the editors make, and it
 * beats hiding files the shell can plainly see.
 */
export function ProjectExplorer({
  project,
  onInsertPath,
  onOpenFolder,
  onBrowseProject,
  onOpenFile,
}: Props) {
  const root = project?.path ?? null;

  const [cache, setCache] = useState<Record<string, Load>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  /** Levels being read right now, so the fetch effect never asks twice. */
  const inflight = useRef(new Set<string>());

  // A different project is a different tree; nothing about the old one survives.
  // The popup editor is lifted out of this tree so a tab switch cannot wipe a
  // dirty draft — only the explorer's expand/cache state resets here.
  useEffect(() => {
    inflight.current.clear();
    setCache({});
    setSelected(null);
    setExpanded(root ? new Set([root]) : new Set());
  }, [root]);

  useEffect(() => {
    if (!root) return;
    for (const path of expanded) {
      if (cache[path] || inflight.current.has(path)) continue;
      inflight.current.add(path);
      listDir(path)
        .then((entries) => {
          // The tab may have changed folders while the read was in flight.
          if (!inflight.current.delete(path)) return;
          setCache((prev) => ({ ...prev, [path]: { entries } }));
        })
        .catch((error: unknown) => {
          if (!inflight.current.delete(path)) return;
          setCache((prev) => ({ ...prev, [path]: { error: String(error) } }));
        });
    }
  }, [cache, expanded, root]);

  /** Drop every level that was read; the effect above pulls the open ones back. */
  const refresh = useCallback(() => {
    inflight.current.clear();
    setCache({});
  }, []);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    if (!root) return [];
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const load = cache[dir];
      if (!load) {
        out.push({ kind: "note", key: `${dir}:loading`, depth, text: "reading…" });
        return;
      }
      if ("error" in load) {
        out.push({ kind: "note", key: `${dir}:error`, depth, text: load.error, error: true });
        return;
      }
      if (load.entries.length === 0) {
        out.push({ kind: "note", key: `${dir}:empty`, depth, text: "empty" });
        return;
      }
      for (const entry of load.entries) {
        out.push({ kind: "entry", key: entry.path, depth, entry });
        if (entry.is_dir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(root, 1);
    return out;
  }, [cache, expanded, root]);

  if (!project || !root) {
    return (
      <div className="tools-empty tools-empty-ambient">
        <AsciiAmbient surfaceId="project-no-folder" scene="network" />
        <p>This tab has no folder yet.</p>
        <button type="button" className="tools-btn" onClick={onBrowseProject}>
          Open a folder…
        </button>
      </div>
    );
  }

  const rootOpen = expanded.has(root);

  return (
    <>
      <div className="tools-section-head">
        <span className="tools-section-title">Project explorer</span>
        <button type="button" className="tools-btn" title="Re-read the folder" onClick={refresh}>
          refresh
        </button>
      </div>

      <div className="tree" role="tree">
        <button
          type="button"
          className={`tree-row is-dir is-root ${selected === root ? "is-selected" : ""}`}
          style={{ paddingLeft: 6 }}
          title={root}
          onClick={() => {
            setSelected(root);
            toggle(root);
          }}
          onDoubleClick={() => onOpenFolder(root)}
        >
          <Chevron open={rootOpen} />
          <FolderIcon open={rootOpen} />
          <span className="tree-name">{project.name}</span>
        </button>

        {rootOpen &&
          rows.map((row) =>
            row.kind === "note" ? (
              <div
                key={row.key}
                className={`tree-note ${row.error ? "is-error" : ""}`}
                style={{ paddingLeft: 6 + row.depth * 13 }}
              >
                {row.text}
              </div>
            ) : (
              <button
                key={row.key}
                type="button"
                className={[
                  "tree-row",
                  row.entry.is_dir ? "is-dir" : "is-file",
                  row.entry.ignored ? "is-ignored" : "",
                  selected === row.entry.path ? "is-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: 6 + row.depth * 13 }}
                title={
                  row.entry.is_dir
                    ? `${row.entry.path}\nDouble-click to cd here`
                    : `${row.entry.path}\nClick to open · double-click to put the path in the prompt`
                }
                onClick={() => {
                  setSelected(row.entry.path);
                  if (row.entry.is_dir) {
                    toggle(row.entry.path);
                  } else {
                    onOpenFile(row.entry.path);
                  }
                }}
                onDoubleClick={() =>
                  row.entry.is_dir ? onOpenFolder(row.entry.path) : onInsertPath(row.entry.path)
                }
              >
                {row.entry.is_dir ? (
                  <>
                    <Chevron open={expanded.has(row.entry.path)} />
                    <FolderIcon open={expanded.has(row.entry.path)} />
                  </>
                ) : (
                  <>
                    <span className="tree-chevron" aria-hidden="true" />
                    <FileIcon />
                  </>
                )}
                <span className="tree-name">{row.entry.name}</span>
              </button>
            ),
          )}
      </div>
    </>
  );
}
