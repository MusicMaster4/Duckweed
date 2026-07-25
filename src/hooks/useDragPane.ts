import { useCallback, useEffect, useRef, useState } from "react";
import type { DropZone } from "../lib/types";

/** Where the pointer currently is: over another pane, or over a tab button. */
export type DragTarget =
  | { kind: "pane"; paneId: string; zone: DropZone }
  | { kind: "tab"; tabId: string }
  | { kind: "newTab" };

export interface DragState {
  leafId: string;
  term: string;
  label: string;
  x: number;
  y: number;
  target: DragTarget | null;
}

export interface DragSource {
  leafId: string;
  term: string;
  label: string;
}

/** Pointer travel before a header press turns into a drag. */
const THRESHOLD = 5;
/** Fraction of a pane's width/height that counts as an edge drop. */
const EDGE = 0.26;

function zoneFor(rect: DOMRect, x: number, y: number): DropZone {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const distances: [DropZone, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const [zone, distance] = distances[0];
  return distance > EDGE ? "center" : zone;
}

function hitTest(x: number, y: number): DragTarget | null {
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.dataset.newTab !== undefined) return { kind: "newTab" };
    if (el.dataset.tabId) return { kind: "tab", tabId: el.dataset.tabId };
    if (el.dataset.paneId) {
      return { kind: "pane", paneId: el.dataset.paneId, zone: zoneFor(el.getBoundingClientRect(), x, y) };
    }
  }
  return null;
}

export function useDragPane(onDrop: (drag: DragState) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pending = useRef<{ source: DragSource; x: number; y: number } | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const update = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const start = pending.current;
      if (start && !dragRef.current) {
        if (Math.abs(e.clientX - start.x) < THRESHOLD && Math.abs(e.clientY - start.y) < THRESHOLD) return;
        document.body.classList.add("is-dragging-pane");
      }
      if (!pending.current) return;
      e.preventDefault();
      const source = pending.current.source;
      update({
        ...source,
        x: e.clientX,
        y: e.clientY,
        target: hitTest(e.clientX, e.clientY),
      });
    };

    const finish = () => {
      const current = dragRef.current;
      pending.current = null;
      document.body.classList.remove("is-dragging-pane");
      update(null);
      if (current) dropRef.current(current);
    };

    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !pending.current) return;
      pending.current = null;
      document.body.classList.remove("is-dragging-pane");
      update(null);
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [update]);

  const startDrag = useCallback((e: React.PointerEvent, source: DragSource) => {
    if (e.button !== 0) return;
    pending.current = { source, x: e.clientX, y: e.clientY };
  }, []);

  return { drag, startDrag };
}
