import type { SubagentSummary } from "../../../lib/agents/subagents";
import {
  runningSubagentCount,
  subagentStatusLabel,
} from "../../../lib/agents/subagents";
import type { AgentId } from "../../../lib/agents/types";

export function scrollFleetWithWheel(
  node: Pick<
    HTMLDivElement,
    "clientWidth" | "scrollLeft" | "scrollWidth"
  >,
  delta: number,
): boolean {
  if (!delta || node.scrollWidth <= node.clientWidth) return false;
  const maxScrollLeft = node.scrollWidth - node.clientWidth;
  const nextScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, node.scrollLeft + delta),
  );
  if (nextScrollLeft === node.scrollLeft) return false;
  node.scrollLeft = nextScrollLeft;
  return true;
}

export function SubagentFleet({
  agent,
  subagents,
  selectedCallId,
  onSelect,
}: {
  agent: AgentId;
  subagents: SubagentSummary[];
  selectedCallId: string | null;
  onSelect: (callId: string) => void;
}) {
  if (!subagents.length) return null;
  const active = runningSubagentCount(subagents);

  return (
    <section
      className={`agent-sub-fleet agent-sub--${agent}`}
      aria-label="Subagents"
      onWheel={(event) => {
        const list = event.currentTarget.querySelector<HTMLDivElement>(
          ".agent-sub-fleet-list",
        );
        if (!list) return;
        const unit =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? list.clientWidth
              : 1;
        const delta =
          (Math.abs(event.deltaY) >= Math.abs(event.deltaX)
            ? event.deltaY
            : event.deltaX) * unit;
        if (scrollFleetWithWheel(list, delta)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="agent-sub-fleet-head">
        <strong>Subagents</strong>
        <span>
          {active > 0
            ? `${active} ${active === 1 ? "subagent" : "subagents"} running`
            : `${subagents.length} completed`}
        </span>
      </div>
      <div
        className="agent-sub-fleet-list"
        role="list"
        aria-live="polite"
      >
        {subagents.map((subagent) => {
          const selected = selectedCallId === subagent.callId;
          const status = subagentStatusLabel(subagent.status);
          return (
            <button
              key={subagent.callId}
              type="button"
              role="listitem"
              className={`agent-sub-chip is-${subagent.status}${
                selected ? " is-selected" : ""
              }`}
              onClick={() => onSelect(subagent.callId)}
              aria-label={`${status}: ${subagent.label}. ${subagent.activity}`}
              aria-pressed={selected}
              title={`${subagent.label}\n${subagent.activity}`}
            >
              <span className="agent-sub-status-dot" aria-hidden="true" />
              <span className="agent-sub-chip-copy">
                <strong>{subagent.label}</strong>
                <span>{subagent.activity}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
