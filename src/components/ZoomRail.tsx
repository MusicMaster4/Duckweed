import { memo, useEffect, useRef, useState, type CSSProperties } from "react";

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
  onExit: () => void;
}

function basename(path: string): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
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
  onExit,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = groupZoomRail(entries);
  // A lone tab needs no heading — its name is already in the strip above.
  const showTabNames = groups.length > 1;

  /** Arrow keys walk the whole list, tab groups included. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null;
    const list = listRef.current;
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLButtonElement>(".zoom-rail-item")];
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
                onSelect={onSelect}
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
  onSelect: (entry: ZoomRailEntry) => void;
}

const ZoomRailItem = memo(function ZoomRailItem({
  entry,
  selected,
  working,
  unread,
  order,
  onSelect,
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

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      // The row shows state as motion and colour only; the status word lives
      // here so it is still announced rather than printed on the card.
      aria-label={`${title}${status ? `, ${status.label}` : ""}`}
      className={[
        "zoom-rail-item",
        selected ? "is-selected" : "",
        entry.tabColor ? "is-colored" : "",
        unread ? "is-unread" : "",
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
      onClick={() => onSelect(entry)}
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
    </button>
  );
});
