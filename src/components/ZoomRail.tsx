import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import * as agentSessions from "../lib/agents/session";
import type { AgentSessionState } from "../lib/agents/types";
import * as terminals from "../lib/terminals";
import {
  groupZoomRail,
  nearestZoomRailSlot,
  previewZoomRailOrder,
  stepRailIndex,
  zoomRailShimmers,
  zoomRailStatus,
  type ZoomRailEntry,
} from "../lib/zoomRail";
import { AgentProviderIcon } from "./agent/AgentProviderIcon";
import { Tooltip } from "./Tooltip";

interface Props {
  entries: readonly ZoomRailEntry[];
  /** Pane currently filling the window. */
  zoomedLeaf: string | null;
  /** Terminals with an agent turn still in flight — same set the tab strip uses. */
  workingTerms: ReadonlySet<string>;
  /** Finished background work nobody has looked at yet. */
  unreadTerms: ReadonlySet<string>;
  onSelect: (entry: ZoomRailEntry) => void;
  /** Drop `entry` into the slot `target` holds, inside their shared tab. */
  onReorder: (entry: ZoomRailEntry, target: ZoomRailEntry) => void;
  onTogglePin: (entry: ZoomRailEntry) => void;
  onExit: () => void;
}

/** A drag in progress: what is being carried, and the card it would land on. */
interface RailDrag {
  leafId: string;
  tabId: string;
  pinned: boolean;
  pointerId: number;
  /** Fixed visual slot centers, captured before the preview starts moving. */
  slotCenters: number[];
  /** The committed slot currently occupied by the preview placeholder. */
  targetLeafId: string;
}

function basename(path: string): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Cards a dragged terminal may land on: its own tab, and its own half of the
 * list. Pinned terminals hold the top of the tab, so mixing the two sections
 * would silently undo a pin the moment something was dropped past it.
 */
function dropTargets(entries: readonly ZoomRailEntry[], drag: RailDrag): ZoomRailEntry[] {
  return entries.filter(
    (entry) => entry.tabId === drag.tabId && entry.pinned === drag.pinned,
  );
}

/**
 * Cards travel to their new slot instead of appearing in it. Every reorder in
 * this list — a drop, a pin, a pane closing — moves rows the user was reading,
 * so each one is measured before and after the change and played back as a
 * short slide from where it used to be (FLIP).
 */
function useRailGlide(listRef: React.RefObject<HTMLDivElement>, orderKey: string): void {
  const previous = useRef(new Map<string, number>());
  const generation = useRef(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLElement>(".zoom-rail-item")];
    const next = new Map<string, number>();
    const moving: HTMLElement[] = [];
    const glide = ++generation.current;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const item of items) {
      // Terminal identity, not layout-leaf identity. A drop changes which leaf
      // owns a terminal, but the same card is already sitting in its final
      // visual position and must not animate a second time.
      const id = item.dataset.termId;
      if (!id) continue;
      // `offsetTop`, not the client rect: the rect includes the very transform
      // this hook applies, so measuring it would feed each glide back into the
      // next one and the rows would drift.
      const top = item.offsetTop;
      next.set(id, top);
      const was = previous.current.get(id);
      // New rows have their own entrance; rows that did not move need nothing,
      // beyond dropping an offset left behind by a glide that never started.
      if (still || was === undefined || Math.abs(was - top) < 1) {
        if (item.style.transform) {
          item.style.transition = "";
          item.style.transform = "";
        }
        continue;
      }
      item.classList.remove("is-gliding");
      item.style.transition = "none";
      item.style.transform = `translateY(${was - top}px)`;
      moving.push(item);
    }

    previous.current = next;
    if (moving.length > 0) {
      // Commit every inverse transform before releasing the rows. Without this
      // layout read, Chromium can merge both writes into one paint and flash
      // the card at its destination instead of animating from its old slot.
      void list.offsetHeight;
      for (const item of moving) {
        item.classList.add("is-gliding");
        item.style.transition = "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        item.style.transform = "translateY(0)";
        const finish = (event?: TransitionEvent) => {
          if (event && event.propertyName !== "transform") return;
          // A later reorder owns the element now. Its cleanup will remove its
          // own styles when it settles.
          if (generation.current !== glide) return;
          item.classList.remove("is-gliding");
          item.style.transition = "";
          item.style.transform = "";
          item.removeEventListener("transitionend", finish);
        };
        item.addEventListener("transitionend", finish);
        // Hidden elements do not reliably emit transitionend.
        window.setTimeout(() => finish(), 240);
      }
    }
  }, [listRef, orderKey]);
}

/**
 * The other side of fullscreen: one pane owns the window, and this rail keeps
 * every other terminal one click away. It mirrors the left tool dock — it
 * shares the row with the workspace instead of covering it, so the zoomed
 * terminal never loses rows to a floating overlay.
 *
 * Rows read like T3 Code's thread cards: where the terminal is, what it is
 * called, and what it last did, with the live status pinned to the top right.
 */
export const ZoomRail = memo(function ZoomRail({
  entries,
  zoomedLeaf,
  workingTerms,
  unreadTerms,
  onSelect,
  onReorder,
  onTogglePin,
  onExit,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<RailDrag | null>(null);
  const dragRef = useRef<RailDrag | null>(null);
  const order = drag
    ? previewZoomRailOrder(entries, drag.leafId, drag.targetLeafId)
    : entries;
  const groups = groupZoomRail(order);
  // A lone tab needs no heading — its name is already in the strip above.
  const showTabNames = groups.length > 1;

  useRailGlide(listRef, order.map((entry) => entry.termId).join("\u001f"));

  /**
   * Which card the pointer is asking for. Measuring the live rectangles keeps
   * the gesture honest while rows are gliding, and the midpoint rule means a
   * card only changes places once the pointer is really past its neighbour.
   */
  const resolveTarget = (drag: RailDrag, clientY: number): RailDrag => {
    const candidates = dropTargets(entries, drag);
    if (drag.slotCenters.length !== candidates.length || candidates.length === 0) return drag;

    // These centers were captured before any card moved. The FLIP animation can
    // therefore never push the pointer back into an earlier slot on the way
    // down, which used to make downward drops appear to ignore the release.
    const targetIndex = nearestZoomRailSlot(drag.slotCenters, clientY);
    return { ...drag, targetLeafId: candidates[targetIndex]?.leafId ?? drag.targetLeafId };
  };

  // Held stable per entry list so a card only re-renders when its own terminal
  // changes, not on every pointer move of a drag.
  const onItemDragMove = useCallback(
    (clientY: number) => {
      const current = dragRef.current;
      if (!current) return;
      // Pointer-up is a native window event and can happen before React flushes
      // a queued state update. Keep the authoritative drag ref synchronous so
      // release always commits the slot currently shown on screen.
      const next = resolveTarget(current, clientY);
      dragRef.current = next;
      setDrag(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries],
  );

  const onItemDragStart = useCallback((next: RailDrag) => {
    const candidates = dropTargets(entries, next);
    const ids = new Set(candidates.map((entry) => entry.leafId));
    const slotCenters = listRef.current
      ? [...listRef.current.querySelectorAll<HTMLElement>(".zoom-rail-item")]
          .filter((element) => ids.has(element.dataset.leafId ?? ""))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, center: rect.top + rect.height / 2 };
          })
          .sort((a, b) => a.top - b.top)
          .map((slot) => slot.center)
      : [];
    const started = { ...next, slotCenters };
    dragRef.current = started;
    setDrag(started);
  }, [entries]);

  const finishDrag = useCallback((commit: boolean) => {
    const current = dragRef.current;
    if (!current) return;
    // Clear synchronously so window and React pointer-up handlers cannot commit
    // the same gesture twice.
    dragRef.current = null;
    setDrag(null);
    if (!commit || current.targetLeafId === current.leafId) return;
    const moved = entries.find((entry) => entry.leafId === current.leafId);
    const target = entries.find((entry) => entry.leafId === current.targetLeafId);
    if (moved && target) onReorder(moved, target);
  }, [entries, onReorder]);

  // The whole window is in the gesture while a card is being carried, the same
  // way it is while a pane is dragged across the grid.
  const carrying = drag !== null;
  useEffect(() => {
    if (!carrying) return;
    document.body.classList.add("is-dragging-rail");
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) {
        onItemDragMove(event.clientY);
      }
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) finishDrag(true);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) finishDrag(false);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finishDrag(false);
    };
    const blur = () => finishDrag(false);
    const visibilityChange = () => {
      if (document.visibilityState === "hidden") finishDrag(false);
    };
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", keyDown, true);
    document.addEventListener("visibilitychange", visibilityChange);
    return () => {
      document.body.classList.remove("is-dragging-rail");
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("visibilitychange", visibilityChange);
    };
  }, [carrying, finishDrag, onItemDragMove]);

  /** Arrow keys walk the whole list, tab groups included. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null;
    const list = listRef.current;
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLElement>(".zoom-rail-item")];
    if (items.length === 0) return;

    if (step === null) {
      if (event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      (event.key === "Home" ? items[0] : items[items.length - 1]).focus();
      return;
    }

    event.preventDefault();
    const from = items.findIndex((item) => item === document.activeElement);
    items[stepRailIndex(items.length, from, step)]?.focus();
  };

  return (
    <aside className="zoom-rail" aria-label="Open terminals">
      <header className="zoom-rail-head">
        <span className="zoom-rail-heading">
          <span className="zoom-rail-kicker">Fullscreen</span>
          <span className="zoom-rail-count">
            {entries.length} terminal{entries.length === 1 ? "" : "s"} open
          </span>
        </span>
        <Tooltip
          title="Leave fullscreen"
          detail="Every pane of this tab comes back to the grid."
          shortcut="Ctrl+Shift+Z"
        >
          <button
            type="button"
            className="zoom-rail-exit"
            aria-label="Leave fullscreen"
            onClick={onExit}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.5 9.5 2.75 13.25M6.5 13v-3h-3" />
              <path d="M9.5 6.5l3.75-3.75M9.5 3v3h3" />
            </svg>
          </button>
        </Tooltip>
      </header>

      <div
        className="zoom-rail-list"
        ref={listRef}
        role="listbox"
        aria-label="Open terminals"
        onKeyDown={onKeyDown}
      >
        {groups.map((group) => (
          <div
            className={`zoom-rail-group${group.current ? " is-current" : ""}`}
            key={group.tabId}
            role="group"
            aria-label={group.tabTitle}
          >
            {showTabNames && (
              <div className="zoom-rail-group-head">
                <span className="zoom-rail-group-name">{group.tabTitle}</span>
                <span className="zoom-rail-group-rule" aria-hidden="true" />
                {group.current && <span className="zoom-rail-group-note">on screen</span>}
              </div>
            )}
            {group.entries.map((entry) => (
              <ZoomRailItem
                // A terminal moves between layout leaves when it is reordered.
                // Keying by the session keeps its card, subscriptions, and
                // visual identity intact through the final drop.
                key={entry.termId}
                entry={entry}
                selected={entry.leafId === zoomedLeaf}
                working={workingTerms.has(entry.termId)}
                unread={unreadTerms.has(entry.termId)}
                dragging={drag?.leafId === entry.leafId}
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                onDragStart={onItemDragStart}
                onDragMove={onItemDragMove}
                onDragEnd={() => finishDrag(true)}
                onDragCancel={() => finishDrag(false)}
              />
            ))}
          </div>
        ))}
      </div>

      <footer className="zoom-rail-foot">
        <kbd>Ctrl</kbd>
        <kbd>Shift</kbd>
        <kbd>]</kbd>
        <span>next terminal</span>
      </footer>

    </aside>
  );
});

interface ItemProps {
  entry: ZoomRailEntry;
  selected: boolean;
  working: boolean;
  unread: boolean;
  /** This card is the one being carried; it stands in for where it will land. */
  dragging: boolean;
  onSelect: (entry: ZoomRailEntry) => void;
  onTogglePin: (entry: ZoomRailEntry) => void;
  onDragStart: (drag: RailDrag) => void;
  onDragMove: (clientY: number) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
}

/** Travel before a press counts as a drag rather than a click, in px. */
const DRAG_SLOP = 4;

const ZoomRailItem = memo(function ZoomRailItem({
  entry,
  selected,
  working,
  unread,
  dragging,
  onSelect,
  onTogglePin,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: ItemProps) {
  const [meta, setMeta] = useState(() => terminals.getMeta(entry.termId));
  const [agent, setAgent] = useState<AgentSessionState | null>(() =>
    agentSessions.get(entry.termId),
  );

  useEffect(() => {
    const read = () => setMeta(terminals.getMeta(entry.termId));
    read();
    return terminals.subscribeSession(entry.termId, read);
  }, [entry.termId]);

  useEffect(() => {
    const read = () => setAgent(agentSessions.get(entry.termId));
    read();
    return agentSessions.subscribe(entry.termId, read);
  }, [entry.termId]);

  const status = zoomRailStatus({
    exited: meta?.exited ?? false,
    busy: meta?.busy ?? false,
    agentStatus: agent?.status ?? null,
    working,
    unread,
  });
  const title = agent?.label || meta?.title || meta?.shellLabel || "shell";
  const folder = basename(agent?.cwd || meta?.cwd || "");
  // What this terminal last did, in one line: the agent's model when a session
  // owns the pane, otherwise the command it ran. A pane that has run nothing
  // has nothing worth repeating.
  const history = terminals.localHistory(entry.termId);
  const lastCommand = history.length > 0 ? history[history.length - 1] : "";
  const detail = agent?.model || lastCommand;
  // A press that travelled is a reorder, not a selection. The flag outlives the
  // pointer sequence just long enough for the click that follows it.
  const moved = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const activePointer = useRef<number | null>(null);
  const endedNormally = useRef(false);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".zoom-rail-pin")) return;
    moved.current = false;
    endedNormally.current = false;
    activePointer.current = event.pointerId;
    origin.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    if (!moved.current) {
      const travelled = Math.hypot(
        event.clientX - origin.current.x,
        event.clientY - origin.current.y,
      );
      if (travelled < DRAG_SLOP) return;
      moved.current = true;
      // Hand the gesture over to the window listeners before the first preview
      // lands. React re-inserts this card's DOM node whenever the preview puts
      // it in a *later* slot, and a re-inserted node loses its pointer capture
      // straight away — which is why a downward drag used to snap back after a
      // single step while an upward one, where React moves the other cards
      // instead, ran to the end.
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onDragStart({
        leafId: entry.leafId,
        tabId: entry.tabId,
        pinned: entry.pinned,
        pointerId: event.pointerId,
        slotCenters: [],
        targetLeafId: entry.leafId,
      });
    }
    onDragMove(event.clientY);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    endedNormally.current = true;
    activePointer.current = null;
    if (moved.current) onDragEnd();
  };

  return (
    <div
      role="option"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      // The row shows state as motion and colour only; the status word lives
      // here so it is still announced rather than printed on the card.
      aria-label={`${title}${status ? `, ${status.label}` : ""}${entry.pinned ? ", pinned" : ""}`}
      className={[
        "zoom-rail-item",
        selected ? "is-selected" : "",
        entry.tabColor ? "is-colored" : "",
        unread ? "is-unread" : "",
        entry.pinned ? "is-pinned" : "",
        dragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          ...(entry.tabColor ? { "--tab-color": entry.tabColor } : null),
        } as CSSProperties
      }
      data-leaf-id={entry.leafId}
      data-term-id={entry.termId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={(event) => {
        if (activePointer.current !== event.pointerId) return;
        endedNormally.current = true;
        activePointer.current = null;
        if (moved.current) onDragCancel();
      }}
      onLostPointerCapture={(event) => {
        if (activePointer.current !== event.pointerId || endedNormally.current) return;
        // A live drag no longer needs the capture: pointer moves, release and
        // cancellation all arrive on the window while it runs. Only a press
        // that never became a drag is dropped here.
        if (moved.current) return;
        activePointer.current = null;
      }}
      onClick={() => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onSelect(entry);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(entry);
      }}
    >
      {zoomRailShimmers(status) && <span className="zoom-rail-shimmer" aria-hidden="true" />}

      <span className="zoom-rail-line zoom-rail-line-head">
        <span className="zoom-rail-mark" aria-hidden="true">
          {agent ? (
            <AgentProviderIcon agent={agent.agent} program={agent.program} />
          ) : (
            <svg viewBox="0 0 16 16">
              <path d="M3.5 5.5 6 8l-2.5 2.5M7.75 11h4.75" />
            </svg>
          )}
        </span>
        <span className="zoom-rail-context">{folder || meta?.shellLabel || "no folder"}</span>
        <button
          type="button"
          className="zoom-rail-pin"
          aria-label={entry.pinned ? `Unpin ${title}` : `Pin ${title} to the top`}
          aria-pressed={entry.pinned}
          title={entry.pinned ? "Unpin this terminal" : "Keep this terminal at the top"}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(entry);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.6 1.8 14.2 6.4l-1.9.5-1 1-3.3-3.3 1-1zM8 4.6 11.4 8l-.8 2.6-2.4 1.4L4 8.2l1.4-2.4zM6.2 9.8 2.6 13.4" />
          </svg>
        </button>
      </span>

      <span className="zoom-rail-name">{title}</span>

      {/* A pane that has run nothing says nothing here. */}
      {detail && (
        <span className="zoom-rail-line zoom-rail-line-foot">
          <span className="zoom-rail-detail">{detail}</span>
        </span>
      )}
    </div>
  );
});
