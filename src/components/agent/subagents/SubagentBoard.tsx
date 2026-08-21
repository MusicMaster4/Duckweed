import type { ReactNode } from "react";

import {
  rosterForAnchor,
  subagentElapsedLabel,
  subagentFleetStatusLabel,
  subagentPeekTools,
  subagentPinLabel,
  subagentResultLine,
  subagentRoleMark,
  subagentStatusLabel,
  visibleRosterRows,
  type SubagentRoster,
  type SubagentSummary,
} from "../../../lib/agents/subagents";
import type { AgentId, AgentItem } from "../../../lib/agents/types";
import { useSubagentUi } from "./SubagentUiContext";

function PeekPreview({ subagent }: { subagent: SubagentSummary }) {
  const tools = subagentPeekTools(subagent);
  return (
    <div className="agent-sub-peek">
      {subagent.prompt && <p className="agent-sub-peek-prompt">{subagent.prompt}</p>}
      {tools.length > 0 ? (
        <ul className="agent-sub-peek-tools">
          {tools.map((tool) => (
            <li key={tool.id}>{tool.title || tool.name}</li>
          ))}
        </ul>
      ) : (
        <p className="agent-sub-peek-activity">{subagent.activity}</p>
      )}
    </div>
  );
}

function RosterRow({
  subagent,
  now,
  peeked,
  onPeek,
  onOpen,
}: {
  subagent: SubagentSummary;
  now: number;
  peeked: boolean;
  onPeek: (callId: string) => void;
  onOpen: (callId: string) => void;
}) {
  const status = subagentStatusLabel(subagent.status);
  const elapsed = subagentElapsedLabel(subagent.startedAt, now, subagent.status);
  const mark =
    subagent.status === "done"
      ? "✓"
      : subagent.status === "error"
        ? "×"
        : subagentRoleMark(subagent);

  return (
    <li className={`agent-sub-row is-${subagent.status}${peeked ? " is-peeked" : ""}`}>
      <button
        type="button"
        className="agent-sub-row-main"
        onClick={() => onPeek(subagent.callId)}
        onDoubleClick={() => onOpen(subagent.callId)}
        aria-expanded={peeked}
        aria-label={`${status}: ${subagent.label}. ${subagentResultLine(subagent)}`}
      >
        <span className="agent-sub-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="agent-sub-row-copy">
          <span className="agent-sub-row-heading">
            <strong>{subagent.label}</strong>
            <span className={`agent-sub-row-status is-${subagent.status}`}>{status}</span>
            {elapsed && <span className="agent-sub-row-elapsed">{elapsed}</span>}
          </span>
          <span className="agent-sub-row-activity">{subagentResultLine(subagent)}</span>
        </span>
      </button>
      {peeked && (
        <div className="agent-sub-row-peek">
          <PeekPreview subagent={subagent} />
          <button
            type="button"
            className="agent-sub-open"
            onClick={() => onOpen(subagent.callId)}
          >
            Open
          </button>
        </div>
      )}
    </li>
  );
}

export function SubagentBoard({
  agent,
  roster,
  now,
  peekedCallId,
  onPeek,
  onOpen,
}: {
  agent: AgentId;
  roster: SubagentRoster;
  now: number;
  peekedCallId: string | null;
  onPeek: (callId: string) => void;
  onOpen: (callId: string) => void;
}) {
  const { rows, hiddenCompleted } = visibleRosterRows(roster.subagents);
  const many = roster.subagents.length > 1;
  const allDone = roster.subagents.every(
    (subagent) => subagent.status === "done" || subagent.status === "error",
  );

  return (
    <section
      className={`agent-sub-board agent-sub--${agent}${allDone ? " is-complete" : ""}`}
      data-subagent-roster={roster.anchorItemId}
      aria-label="Subagents"
    >
      {many && (
        <header className="agent-sub-board-head">
          <strong>Subagents</strong>
          <span>{subagentFleetStatusLabel(roster.subagents)}</span>
        </header>
      )}
      <ul className="agent-sub-board-list">
        {rows.map((subagent) => (
          <RosterRow
            key={subagent.callId}
            subagent={subagent}
            now={now}
            peeked={peekedCallId === subagent.callId}
            onPeek={onPeek}
            onOpen={onOpen}
          />
        ))}
      </ul>
      {hiddenCompleted > 0 && (
        <p className="agent-sub-board-more">
          {hiddenCompleted} completed
        </p>
      )}
    </section>
  );
}

/** Renders the roster whose first task lives in this activity cluster. */
export function SubagentBoardAnchor({ itemId }: { itemId: string }) {
  const {
    agent,
    now,
    rosters,
    peekedCallId,
    peekSubagent,
    openSubagent,
    closePeek,
  } = useSubagentUi();
  const roster = rosterForAnchor(rosters, itemId);
  if (!agent || !roster) return null;

  return (
    <SubagentBoard
      agent={agent}
      roster={roster}
      now={now}
      peekedCallId={peekedCallId}
      onPeek={(callId) => {
        if (peekedCallId === callId) closePeek();
        else peekSubagent(callId);
      }}
      onOpen={openSubagent}
    />
  );
}

/** Roster for a skipped thinking/tool cluster that still owns delegated work. */
export function SubagentBoardForActivities({
  activities,
  wrap,
}: {
  activities: AgentItem[];
  wrap?: (board: ReactNode) => ReactNode;
}) {
  const { rosterAnchorIds } = useSubagentUi();
  const rosterAnchorId = activities.find(
    (item) => item.kind === "tool" && rosterAnchorIds.has(item.id),
  )?.id;
  if (!rosterAnchorId) return null;
  const board = <SubagentBoardAnchor itemId={rosterAnchorId} />;
  return wrap ? wrap(board) : board;
}

export function SubagentPin({
  agent,
  subagents,
  onPeek,
}: {
  agent: AgentId;
  subagents: SubagentSummary[];
  onPeek: (callId: string) => void;
}) {
  if (!subagents.length) return null;
  const live =
    subagents.find((subagent) => subagent.status === "running") ??
    subagents.find((subagent) => subagent.status === "pending") ??
    subagents[0];
  const label = subagentPinLabel(subagents);

  return (
    <button
      type="button"
      className={`agent-sub-pin agent-sub--${agent}`}
      onClick={() => onPeek(live.callId)}
      aria-label={`Subagents: ${label}`}
    >
      <span className={`agent-sub-mark is-${live.status}`} aria-hidden="true">
        {live.status === "done" ? "✓" : live.status === "error" ? "×" : subagentRoleMark(live)}
      </span>
      <span className="agent-sub-pin-copy">{label}</span>
    </button>
  );
}
