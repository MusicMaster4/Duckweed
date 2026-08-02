import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import * as agentSessions from "../lib/agents/session";
import type { AgentSessionState } from "../lib/agents/types";
import * as terminals from "../lib/terminals";
import {
  groupZoomRail,
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
  /** Where the card would go, or null while the pointer is over an invalid drop. */
  overLeafId: string | null;
  /** Insertion side of `overLeafId`, so the line reads like a text caret. */
  after: boolean;
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
  const groups = groupZoomRail(entries);
  // A lone tab needs no heading — its name is already in the strip above.
  const showTabNames = groups.length > 1;

  /**
   * Which card the pointer is asking for. Measuring the live rectangles keeps
   * the gesture honest while rows are still fanning in, and the midpoint rule
   * makes the drop land where the caret is drawn.
   */
  const resolveTarget = (drag: RailDrag, clientY: number): RailDrag => {
    const list = listRef.current;
    if (!list) return drag;
    const candidates = dropTargets(entries, drag);
    const carried = candidates.findIndex((entry) => entry.leafId === drag.leafId);
    let over = -1;
    for (let index = 0; index < candidates.length; index += 1) {
      const element = list.querySelector<HTMLElement>(
        `[data-leaf-id="${candidates[index].leafId}"]`,
      );
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      // Above the first card and below the last one both clamp to the end the
      // pointer is nearest, so a drag never dies just past the list.
      if (over < 0 || clientY >= rect.top) over = index;
    }
    if (over < 0 || over === carried) return { ...drag, overLeafId: null, after: false };
    // Landing on a card means taking its slot: dragging down settles after it,
    // dragging up settles before it. The caret is drawn on that same side.
    return { ...drag, overLeafId: candidates[over].leafId, after: over > carried };
  };

  // Held stable per entry list so a card only re-renders when its own terminal
  // changes, not on every pointer move of a drag.
  const onItemDragMove = useCallback(
    (clientY: number) => {
      setDrag((current) => (current ? resolveTarget(current, clientY) : current));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries],
  );

  const onItemDragEnd = useCallback(() => {
    setDrag((current) => {
      if (current?.overLeafId) {
        const moved = entries.find((entry) => entry.leafId === current.leafId);
        const target = entries.find((entry) => entry.leafId === current.overLeafId);
        if (moved && target) onReorder(moved, target);
      }
      return null;
    });
  }, [entries, onReorder]);

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
        {groups.map((group, groupIndex) => (
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
            {group.entries.map((entry, index) => (
              <ZoomRailItem
                key={entry.leafId}
                entry={entry}
                selected={entry.leafId === zoomedLeaf}
                working={workingTerms.has(entry.termId)}
                unread={unreadTerms.has(entry.termId)}
                // Rows fan in one after another; the offset counts across groups
                // so a second tab's terminals do not restart the stagger.
                order={groupIndex + index}
                dragging={drag?.leafId === entry.leafId}
                dropSide={
                  drag?.overLeafId === entry.leafId ? (drag.after ? "after" : "before") : null
                }
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                onDragStart={setDrag}
                onDragMove={onItemDragMove}
                onDragEnd={onItemDragEnd}
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
  order: number;
  dragging: boolean;
  /** Which edge of this card the caret sits on while something is dragged. */
  dropSide: "before" | "after" | null;
  onSelect: (entry: ZoomRailEntry) => void;
  onTogglePin: (entry: ZoomRailEntry) => void;
  onDragStart: (drag: RailDrag) => void;
  onDragMove: (clientY: number) => void;
  onDragEnd: () => void;
}

/** Travel before a press counts as a drag rather than a click, in px. */
const DRAG_SLOP = 4;

const ZoomRailItem = memo(function ZoomRailItem({
  entry,
  selected,
  working,
  unread,
  order,
  dragging,
  dropSide,
  onSelect,
  onTogglePin,
  onDragStart,
  onDragMove,
  onDragEnd,
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
  const origin = useRef(0);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".zoom-rail-pin")) return;
    moved.current = false;
    origin.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!moved.current) {
      if (Math.abs(event.clientY - origin.current) < DRAG_SLOP) return;
      moved.current = true;
      onDragStart({
        leafId: entry.leafId,
        tabId: entry.tabId,
        pinned: entry.pinned,
        overLeafId: null,
        after: false,
      });
    }
    onDragMove(event.clientY);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
        dropSide ? `is-drop-${dropSide}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          "--rail-order": order,
          ...(entry.tabColor ? { "--tab-color": entry.tabColor } : null),
        } as CSSProperties
      }
      data-leaf-id={entry.leafId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
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

      <span className="zoom-rail-line zoom-rail-line-foot">
        {/* A pane that has run nothing says nothing here — the empty half of
            the line is quieter than a sentence explaining it. */}
        {detail && <span className="zoom-rail-detail">{detail}</span>}
        <span className="zoom-rail-seat" aria-hidden="true">
          {entry.position}
        </span>
      </span>
    </div>
  );
});
