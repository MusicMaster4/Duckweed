import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import * as bus from "../lib/bus";
import { edgeRadius } from "../lib/layout";
import * as terminals from "../lib/terminals";
import type { DropZone, LeafNode, ProjectInfo } from "../lib/types";
import { AgentSurface } from "./agent/AgentSurface";
import { CommandInput } from "./CommandInput";
import { PaneWelcome } from "./PaneWelcome";
import { SearchBar } from "./SearchBar";

/** Brief "Copied" chip shown at the cursor after right-click copy. */
type CopyToast = { x: number; y: number; id: number };
type TitleMenu = { x: number; y: number };

interface Props {
  node: LeafNode;
  active: boolean;
  zoomed: boolean;
  /** Highlight shown while a pane is being dragged over this one. */
  dropZone: DropZone | null;
  /** This pane is the one being dragged. */
  isSource: boolean;
  spawn: { cwd: string | null; shell: string | null; command: string | null };
  highlight: boolean;
  /** Bitmask of the sides sitting on the rounded outer frame — see PaneTree. */
  edges: number;
  completionFlash: number;
  /** Background completion not reviewed yet — drives the pane outline, not a header dot. */
  unread: boolean;
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

export const TerminalPane = memo(function TerminalPane({
  node,
  active,
  zoomed,
  dropZone,
  isSource,
  spawn,
  highlight,
  edges,
  completionFlash,
  unread,
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
  const copyToastTimer = useRef<number | null>(null);
  const [meta, setMeta] = useState(() => terminals.getMeta(node.term));
  const [searching, setSearching] = useState(false);
  const [inputMode, setInputMode] = useState(terminals.getInputMode);
  const [copyToast, setCopyToast] = useState<CopyToast | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleMenu, setTitleMenu] = useState<TitleMenu | null>(null);

  useEffect(
    () => () => {
      if (copyToastTimer.current != null) window.clearTimeout(copyToastTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!titleMenu) return;
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTitleMenu(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [titleMenu]);

  const showCopyToast = (x: number, y: number) => {
    if (copyToastTimer.current != null) window.clearTimeout(copyToastTimer.current);
    setCopyToast({ x, y, id: Date.now() });
    copyToastTimer.current = window.setTimeout(() => {
      setCopyToast(null);
      copyToastTimer.current = null;
    }, 700);
  };

  // Attach before paint so the terminal never flashes an empty frame when the
  // layout changes and React remounts this pane.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    terminals.attach(node.term, body, {
      cwd: spawn.cwd,
      shell: spawn.shell,
      command: spawn.command,
    });
    setMeta(terminals.getMeta(node.term));
    return () => terminals.detach(node.term);
    // `spawn` only matters for the very first attach, which creates the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.term]);

  useEffect(
    () =>
      terminals.subscribeSession(node.term, () => {
        setMeta(terminals.getMeta(node.term));
      }),
    [node.term],
  );

  useEffect(
    () =>
      terminals.subscribeSettings(() => {
        setInputMode(terminals.getInputMode());
      }),
    [],
  );

  useEffect(
    () =>
      bus.on("pane:search", (payload) => {
        if (payload.leafId === node.id) setSearching(true);
      }),
    [node.id],
  );

  // The grid owns the keyboard when the app is set to raw input, while a child
  // process is running, or once the shell is gone.
  const busy = meta?.busy ?? false;
  const agentUi = meta?.agentUi ?? null;
  const effectiveRaw = inputMode === "raw" || busy || !!meta?.exited;

  useEffect(() => {
    terminals.setEditorMode(node.term, !effectiveRaw);
  }, [node.term, effectiveRaw]);

  // Hand keyboard to the grid while a child is running; reclaim the editor
  // after. An agent surface has its own composer and focuses itself.
  useEffect(() => {
    if (!active || meta?.exited || agentUi) return;
    const id = window.setTimeout(
      () => (effectiveRaw ? terminals.focusTerminal(node.term) : terminals.focus(node.term)),
      0,
    );
    return () => window.clearTimeout(id);
  }, [effectiveRaw, active, meta?.exited, agentUi, node.term]);

  const title = meta?.title || meta?.shellLabel || "shell";
  const cwdLabel = meta?.cwd ? basename(meta.cwd) : "";

  /**
   * A running CLI owns the pane: the composer is unmounted so the program gets
   * every row, and nothing below it competes for the keyboard. An exited shell
   * keeps the bar — it is the only thing left saying what happened. No project
   * yet means no composer either: pick a folder before any command runs.
   */
  const showComposer = inputMode === "editor" && !busy && !!project && !agentUi;
  /** Nothing has been run — hide the shell's lone prompt behind the empty state. */
  const blank = !!meta && !meta.ran && !effectiveRaw;
  /**
   * The header doubles as the active-pane marker, so it stays visible in both
   * input modes — in a split there is nothing else saying which terminal has
   * the keyboard. The one exception is the open-a-folder gate: that tab has no
   * shell worth labelling, so the empty state gets the pane to itself.
   */
  const showHeader = inputMode === "raw" || !!project;

  return (
    <div
      className={[
        "pane",
        active ? "is-active" : "",
        isSource ? "is-source" : "",
        meta?.exited ? "is-exited" : "",
        effectiveRaw ? "is-raw" : "is-editor",
        blank ? "is-blank" : "",
        unread ? "is-unread" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      // Only the corners that meet the rounded outer frame get a radius; the
      // ones against a divider stay square so the outline meets it flush.
      style={{ "--pane-radius": edgeRadius(edges) } as React.CSSProperties}
      data-pane-id={node.id}
      onPointerDownCapture={onActivate}
    >
      {completionFlash !== 0 && (
        <span
          key={completionFlash}
          className={[
            "pane-completion-flash",
            completionFlash < 0 ? "is-restored" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        />
      )}
      {showHeader && (
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
          {editingTitle ? (
            <input
              className="pane-title-rename"
              autoFocus
              defaultValue={title}
              aria-label="Terminal name"
              onPointerDown={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                terminals.rename(node.term, e.currentTarget.value);
                setEditingTitle(false);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditingTitle(false);
              }}
            />
          ) : (
            <span
              className="pane-title"
              title="Double-click or right-click to rename this terminal"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingTitle(true);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTitleMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {title}
            </span>
          )}
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
            <svg viewBox="0 0 12 12" aria-hidden="true">
              {zoomed ? (
                <>
                  <path d="M4.25 3.75V2.25h5.5v5.5h-1.5" />
                  <rect x="2.25" y="4.25" width="5.5" height="5.5" rx=".45" />
                </>
              ) : (
                <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1.2" />
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
      )}

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
        onClick={() => {
          // A press focuses the grid so a drag can select; a click that
          // selected nothing was the user asking to type, so the composer
          // takes the keyboard back rather than making them click it too.
          if (blank || busy || meta?.exited || agentUi) return;
          if (terminals.selection(node.term)) return;
          terminals.focus(node.term);
        }}
        onContextMenu={(e) => {
          // Terminal convention: right-click copies a selection, else pastes.
          e.preventDefault();
          const selected = terminals.selection(node.term);
          if (selected) {
            void navigator.clipboard.writeText(selected);
            showCopyToast(e.clientX, e.clientY);
            return;
          }
          void navigator.clipboard.readText().then((text) => {
            if (text) terminals.paste(node.term, text);
          });
        }}
      >
        {blank && (
          <PaneWelcome
            termId={node.term}
            active={active}
            project={project}
            recents={recents}
            onBrowse={onBrowseProject}
            onPickRecent={onPickProject}
          />
        )}
      </div>

      {agentUi && (
        <AgentSurface
          termId={node.term}
          active={active && !searching}
          onClose={() => terminals.closeAgentUi(node.term)}
        />
      )}

      {showComposer && (
        <CommandInput
          termId={node.term}
          active={active && !searching}
          exited={!!meta?.exited}
          highlight={highlight}
        />
      )}

      {searching && <SearchBar termId={node.term} onClose={() => setSearching(false)} />}

      {dropZone && <div className={`drop-hint drop-${dropZone}`} />}

      {copyToast &&
        createPortal(
          <div
            key={copyToast.id}
            className="copy-toast"
            style={{ left: copyToast.x, top: copyToast.y }}
            role="status"
            aria-live="polite"
          >
            Copied
          </div>,
          document.body,
        )}

      {titleMenu &&
        createPortal(
          <>
            <div className="menu-backdrop" onPointerDown={() => setTitleMenu(null)} />
            <div
              className="menu pane-title-menu"
              role="menu"
              style={{
                left: Math.max(8, Math.min(titleMenu.x, window.innerWidth - 170)),
                top: Math.max(8, Math.min(titleMenu.y, window.innerHeight - 48)),
              }}
            >
              <button
                type="button"
                className="menu-item menu-item-row"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setTitleMenu(null);
                  setEditingTitle(true);
                }}
              >
                Rename terminal
              </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
});
