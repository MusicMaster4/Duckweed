import { useEffect, useLayoutEffect, useRef, useState } from "react";

import * as bus from "../lib/bus";
import * as terminals from "../lib/terminals";
import type { DropZone, LeafNode } from "../lib/types";
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
  onActivate: () => void;
  onSplit: (zone: "right" | "bottom") => void;
  onClose: () => void;
  onToggleZoom: () => void;
  onDragHandle: (e: React.PointerEvent) => void;
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
  onActivate,
  onSplit,
  onClose,
  onToggleZoom,
  onDragHandle,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState(() => terminals.getMeta(node.term));
  const [searching, setSearching] = useState(false);

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

  useEffect(() => terminals.subscribe(() => setMeta(terminals.getMeta(node.term))), [node.term]);

  useEffect(
    () =>
      bus.on("pane:search", (payload) => {
        if (payload.leafId === node.id) setSearching(true);
      }),
    [node.id],
  );

  const title = meta?.title || meta?.shellLabel || "shell";
  const cwdLabel = meta?.cwd ? basename(meta.cwd) : "";

  return (
    <div
      className={[
        "pane",
        active ? "is-active" : "",
        isSource ? "is-source" : "",
        meta?.exited ? "is-exited" : "",
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
        <span className="pane-spacer" />
        <span className="pane-dims">
          {meta?.cols ?? 0}×{meta?.rows ?? 0}
        </span>
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
      />

      {searching && <SearchBar termId={node.term} onClose={() => setSearching(false)} />}

      {dropZone && <div className={`drop-hint drop-${dropZone}`} />}
    </div>
  );
}
