import { useEffect, useLayoutEffect, useRef, useState } from "react";

import * as bus from "../lib/bus";
import * as terminals from "../lib/terminals";
import type { DropZone, LeafNode, ProjectInfo } from "../lib/types";
import { CommandInput } from "./CommandInput";
import { PaneWelcome } from "./PaneWelcome";
import { SearchBar } from "./SearchBar";

interface Props {
  node: LeafNode;
  active: boolean;
  zoomed: boolean;
  /** Highlight shown while a pane is being dragged over this one. */
  dropZone: DropZone | null;
  /** This pane is the one being dragged. */
  isSource: boolean;
  spawn: { cwd: string | null; shell: string | null };
  /** Folder of the tab this pane belongs to — the empty state offers to set it. */
  project: ProjectInfo | null;
  recents: string[];
  onActivate: () => void;
  onSplit: (zone: "right" | "bottom") => void;
  onClose: () => void;
  onToggleZoom: () => void;
  onDragHandle: (e: React.PointerEvent) => void;
  onBrowseProject: () => void;
  onPickProject: (path: string) => void;
}

function basename(path: string): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function TerminalPane({
  node,
  active,
  zoomed,
  dropZone,
  isSource,
  spawn,
  project,
  recents,
  onActivate,
  onSplit,
  onClose,
  onToggleZoom,
  onDragHandle,
  onBrowseProject,
  onPickProject,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState(() => terminals.getMeta(node.term));
  const [searching, setSearching] = useState(false);
  const [inputMode, setInputMode] = useState(terminals.getInputMode);
  const [busy, setBusy] = useState(false);

  // Attach before paint so the terminal never flashes an empty frame when the
  // layout changes and React remounts this pane.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    terminals.attach(node.term, body, { cwd: spawn.cwd, shell: spawn.shell });
    setMeta(terminals.getMeta(node.term));
    return () => terminals.detach(node.term);
    // `spawn` only matters for the very first attach, which creates the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.term]);

  useEffect(
    () =>
      terminals.subscribe(() => {
        setMeta(terminals.getMeta(node.term));
        setInputMode(terminals.getInputMode());
      }),
    [node.term],
  );

  useEffect(
    () =>
      bus.on("pane:search", (payload) => {
        if (payload.leafId === node.id) setSearching(true);
      }),
    [node.id],
  );

  // Poll for child processes — when something is running (vim, servers, …),
  // hand the keyboard to the raw grid like Warp does for interactive programs.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const running = await terminals.hasRunningProcess(node.term);
      if (!cancelled) setBusy(running);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [node.term]);

  // The grid owns the keyboard when the app is set to raw input, while a child
  // process is running, or once the shell is gone.
  const effectiveRaw = inputMode === "raw" || busy || !!meta?.exited;

  useEffect(() => {
    terminals.setEditorMode(node.term, !effectiveRaw);
  }, [node.term, effectiveRaw]);

  // Hand keyboard to the grid while a child is running; reclaim the editor after.
  useEffect(() => {
    if (!active || meta?.exited) return;
    const id = window.setTimeout(
      () => (effectiveRaw ? terminals.focusTerminal(node.term) : terminals.focus(node.term)),
      0,
    );
    return () => window.clearTimeout(id);
  }, [effectiveRaw, active, meta?.exited, node.term]);

  const title = meta?.title || meta?.shellLabel || "shell";
  const cwdLabel = meta?.cwd ? basename(meta.cwd) : "";

  /**
   * A running CLI owns the pane: the composer is unmounted so the program gets
   * every row, and nothing below it competes for the keyboard. An exited shell
   * keeps the bar — it is the only thing left saying what happened. No project
   * yet means no composer either: pick a folder before any command runs.
   */
  const showComposer = inputMode === "editor" && !busy && !!project;
  /** Nothing has been run — hide the shell's lone prompt behind the empty state. */
  const blank = !!meta && !meta.ran && !effectiveRaw;

  return (
    <div
      className={[
        "pane",
        active ? "is-active" : "",
        isSource ? "is-source" : "",
        meta?.exited ? "is-exited" : "",
        effectiveRaw ? "is-raw" : "is-editor",
        blank ? "is-blank" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-pane-id={node.id}
      onPointerDownCapture={() => {
        if (!active) onActivate();
      }}
    >
      <div
        className="pane-header"
        onPointerDown={onDragHandle}
        onDoubleClick={onToggleZoom}
        title="Drag to move this terminal"
      >
        <span className="pane-grip" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="pane-title">{title}</span>
        {cwdLabel && <span className="pane-cwd">{cwdLabel}</span>}
        {meta?.exited && <span className="pane-badge">exited</span>}
        {busy && !meta?.exited && <span className="pane-badge pane-badge-busy">running</span>}
        <span className="pane-spacer" />
        <button
          type="button"
          className="pane-btn"
          title="Split right (Ctrl+Shift+D)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onSplit("right")}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
            <line x1="7" y1="2" x2="7" y2="12" />
          </svg>
        </button>
        <button
          type="button"
          className="pane-btn"
          title="Split down (Ctrl+Shift+E)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onSplit("bottom")}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
            <line x1="1.5" y1="7" x2="12.5" y2="7" />
          </svg>
        </button>
        <button
          type="button"
          className="pane-btn"
          title={zoomed ? "Restore (Ctrl+Shift+Z)" : "Zoom pane (Ctrl+Shift+Z)"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleZoom}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            {zoomed ? (
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
            ) : (
              <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
            )}
          </svg>
        </button>
        <button
          type="button"
          className="pane-btn pane-btn-danger"
          title="Close pane (Ctrl+Shift+W)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <line x1="3.5" y1="3.5" x2="10.5" y2="10.5" />
            <line x1="10.5" y1="3.5" x2="3.5" y2="10.5" />
          </svg>
        </button>
      </div>

      <div
        className="pane-body"
        ref={bodyRef}
        onPointerDown={() => {
          // Unclaimed tabs have no composer — clicks stay on the empty state.
          if (blank && !project) return;
          // Nothing has been run, so there is no output to select — a click on
          // the empty state means "let me type", not "let me grab the grid".
          if (blank) {
            terminals.focus(node.term);
            return;
          }
          // Clicking the grid: allow selection; if the user wants raw typing,
          // switch modes. Selecting text still works in editor mode.
          if (!meta?.exited && !busy) {
            // Soft raw: focus terminal for selection without permanently
            // leaving editor mode unless they start typing there.
            terminals.focusTerminal(node.term);
          }
        }}
        onContextMenu={(e) => {
          // Terminal convention: right-click copies a selection, else pastes.
          e.preventDefault();
          const selected = terminals.selection(node.term);
          if (selected) {
            void navigator.clipboard.writeText(selected);
            return;
          }
          void navigator.clipboard.readText().then((text) => {
            if (text) terminals.paste(node.term, text);
          });
        }}
      >
        {blank && (
          <PaneWelcome
            active={active}
            project={project}
            recents={recents}
            onBrowse={onBrowseProject}
            onPickRecent={onPickProject}
          />
        )}
      </div>

      {showComposer && (
        <CommandInput
          termId={node.term}
          active={active && !searching}
          exited={!!meta?.exited}
        />
      )}

      {searching && <SearchBar termId={node.term} onClose={() => setSearching(false)} />}

      {dropZone && <div className={`drop-hint drop-${dropZone}`} />}
    </div>
  );
}
