import { Fragment, memo, useRef, useState } from "react";

import { resizeSplit } from "../lib/layout";
import type { DropZone, LayoutNode, LeafNode, ProjectInfo, SplitNode } from "../lib/types";
import type { DragState } from "../hooks/useDragPane";
import { TerminalPane } from "./TerminalPane";

/**
 * Space the divider takes out of the layout, in px. Must match `.divider`
 * flex basis in styles.css. The grab area overhangs into the panes on both
 * sides (see `.divider span`) instead of pushing them apart.
 */
const DIVIDER = 3;

export interface PaneTreeShared {
  activeLeaf: string;
  drag: DragState | null;
  /** Resolves the shell/cwd a not-yet-created terminal should start with. */
  spawnFor: (term: string) => { cwd: string | null; shell: string | null };
  highlight: boolean;
  /** Terminals whose most recent completion has not been reviewed yet. */
  unreadTerms: ReadonlySet<string>;
  /** Folder of the tab being rendered; the empty pane offers to pick one. */
  project: ProjectInfo | null;
  recents: string[];
  onBrowseProject: () => void;
  onPickProject: (path: string) => void;
  zoomedLeaf: string | null;
  onActivate: (leafId: string) => void;
  onSplit: (leafId: string, zone: "right" | "bottom") => void;
  onClose: (leafId: string) => void;
  onToggleZoom: (leafId: string) => void;
  onStartDrag: (e: React.PointerEvent, node: LeafNode) => void;
  onResize: (splitId: string, sizes: number[]) => void;
}

function dropZoneFor(drag: DragState | null, leafId: string): DropZone | null {
  if (!drag?.target || drag.target.kind !== "pane") return null;
  if (drag.target.paneId !== leafId) return null;
  if (drag.leafId === leafId && drag.target.zone === "center") return null;
  return drag.target.zone;
}

export const PaneTree = memo(function PaneTree({ node, shared }: { node: LayoutNode; shared: PaneTreeShared }) {
  if (node.kind === "leaf") {
    return (
      <TerminalPane
        // Stable across layout reshapes so React can reconcile the same pane
        // when a lone leaf becomes a child of a split (draft lives on the
        // session either way; this just avoids extra detach/attach churn).
        key={node.id}
        node={node}
        active={shared.activeLeaf === node.id}
        zoomed={shared.zoomedLeaf === node.id}
        dropZone={dropZoneFor(shared.drag, node.id)}
        isSource={shared.drag?.leafId === node.id}
        spawn={shared.spawnFor(node.term)}
        highlight={shared.highlight}
        unread={shared.unreadTerms.has(node.term)}
        project={shared.project}
        recents={shared.recents}
        onBrowseProject={shared.onBrowseProject}
        onPickProject={shared.onPickProject}
        onActivate={() => shared.onActivate(node.id)}
        onSplit={(zone) => shared.onSplit(node.id, zone)}
        onClose={() => shared.onClose(node.id)}
        onToggleZoom={() => shared.onToggleZoom(node.id)}
        onDragHandle={(e) => shared.onStartDrag(e, node)}
      />
    );
  }
  return <SplitView node={node} shared={shared} />;
});

const SplitView = memo(function SplitView({ node, shared }: { node: SplitNode; shared: PaneTreeShared }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const count = node.children.length;

  // Cells are sized by an explicit basis with grow/shrink disabled, so a pane's
  // width never depends on what the terminal inside it is printing. Each cell
  // gives up its share of the dividers so the children always total exactly 100%.
  const gapShare = ((count - 1) * DIVIDER) / count;

  return (
    <div className={`split split-${node.dir}`} ref={containerRef} data-split-id={node.id}>
      {node.children.map((child, index) => {
        const fraction = node.sizes[index] ?? 1 / count;
        const basis = `calc(${(fraction * 100).toFixed(4)}% - ${gapShare.toFixed(3)}px)`;
        return (
          <Fragment key={child.id}>
            {index > 0 && (
              <Divider
                dir={node.dir}
                index={index - 1}
                containerRef={containerRef}
                sizes={node.sizes}
                onResize={(sizes) => shared.onResize(node.id, sizes)}
              />
            )}
            <div className="split-cell" style={{ flexBasis: basis }}>
              <PaneTree node={child} shared={shared} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
});

interface DividerProps {
  dir: "row" | "col";
  index: number;
  containerRef: React.RefObject<HTMLDivElement>;
  sizes: number[];
  onResize: (sizes: number[]) => void;
}

function Divider({ dir, index, containerRef, sizes, onResize }: DividerProps) {
  const drag = useRef<{ origin: number; total: number; base: number[]; next: number[] } | null>(null);
  const previewFrame = useRef(0);
  // Keeps the line lit for the whole drag, including once the pointer has run
  // past the divider and is no longer hovering it.
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    setDragging(true);
    drag.current = {
      origin: dir === "row" ? e.clientX : e.clientY,
      // Fractions are of the container box, dividers included — see gapShare.
      total: Math.max(1, dir === "row" ? container.clientWidth : container.clientHeight),
      base: [...sizes],
      next: [...sizes],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const position = dir === "row" ? e.clientX : e.clientY;
    state.next = resizeSplit(state.base, index, (position - state.origin) / state.total);
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = requestAnimationFrame(() => preview(state.next));
  };

  const stop = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    cancelAnimationFrame(previewFrame.current);
    preview(state.next);
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("is-resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Persist once. ResizeObserver has already kept both visible terminals fit
    // while the lightweight DOM preview followed the pointer.
    onResize(state.next);
  };

  const preview = (next: number[]) => {
    const container = containerRef.current;
    if (!container) return;
    const cells = Array.from(container.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.classList.contains("split-cell"),
    );
    const gapShare = ((next.length - 1) * DIVIDER) / next.length;
    for (const at of [index, index + 1]) {
      const cell = cells[at];
      if (!cell) continue;
      cell.style.flexBasis = `calc(${((next[at] ?? 0) * 100).toFixed(4)}% - ${gapShare.toFixed(3)}px)`;
    }
  };

  return (
    <div
      className={`divider divider-${dir}${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => {
        // Even out the two neighbours.
        const base = [...sizes];
        const sum = base[index] + base[index + 1];
        base[index] = sum / 2;
        base[index + 1] = sum / 2;
        onResize(base);
      }}
    >
      <span />
    </div>
  );
}
