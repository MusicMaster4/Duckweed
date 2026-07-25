import { Fragment, useRef, useState } from "react";

import { resizeSplit } from "../lib/layout";
import type { DropZone, LayoutNode, LeafNode, SplitNode } from "../lib/types";
import type { DragState } from "../hooks/useDragPane";
import { TerminalPane } from "./TerminalPane";

/**
 * Space the divider takes out of the layout, in px. It is a hairline: the grab
 * area overhangs into the panes on both sides (see `.divider span`) instead of
 * pushing them apart, so splits read as one surface cut by a line.
 */
const DIVIDER = 1;

export interface PaneTreeShared {
  activeLeaf: string;
  drag: DragState | null;
  /** Resolves the shell/cwd a not-yet-created terminal should start with. */
  spawnFor: (term: string) => { cwd: string | null; shell: string | null };
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

export function PaneTree({ node, shared }: { node: LayoutNode; shared: PaneTreeShared }) {
  if (node.kind === "leaf") {
    return (
      <TerminalPane
        node={node}
        active={shared.activeLeaf === node.id}
        zoomed={shared.zoomedLeaf === node.id}
        dropZone={dropZoneFor(shared.drag, node.id)}
        isSource={shared.drag?.leafId === node.id}
        spawn={shared.spawnFor(node.term)}
        onActivate={() => shared.onActivate(node.id)}
        onSplit={(zone) => shared.onSplit(node.id, zone)}
        onClose={() => shared.onClose(node.id)}
        onToggleZoom={() => shared.onToggleZoom(node.id)}
        onDragHandle={(e) => shared.onStartDrag(e, node)}
      />
    );
  }
  return <SplitView node={node} shared={shared} />;
}

function SplitView({ node, shared }: { node: SplitNode; shared: PaneTreeShared }) {
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
}

interface DividerProps {
  dir: "row" | "col";
  index: number;
  containerRef: React.RefObject<HTMLDivElement>;
  sizes: number[];
  onResize: (sizes: number[]) => void;
}

function Divider({ dir, index, containerRef, sizes, onResize }: DividerProps) {
  const drag = useRef<{ origin: number; total: number; base: number[] } | null>(null);
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
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const position = dir === "row" ? e.clientX : e.clientY;
    onResize(resizeSplit(state.base, index, (position - state.origin) / state.total));
  };

  const stop = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("is-resizing");
    e.currentTarget.releasePointerCapture(e.pointerId);
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
