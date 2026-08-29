import type { ReactNode } from "react";

import {
  subagentElapsedLabel,
  subagentFleetStatusLabel,
  subagentResultLine,
  subagentRoleMark,
  subagentStatusCounts,
  subagentStatusLabel,
  type SubagentSummary,
} from "../../../lib/agents/subagents";
import type { AgentId } from "../../../lib/agents/types";
import { SubagentFocus } from "./SubagentFocus";

function StatusMark({ subagent }: { subagent: SubagentSummary }) {
  return (
    <span className={`agent-sub-mark is-${subagent.status}`} aria-hidden="true">
      {subagent.status === "done"
        ? "✓"
        : subagent.status === "error"
          ? "×"
          : subagentRoleMark(subagent)}
    </span>
  );
}

export function SubagentNavigator({
  agent,
  parentLabel,
  parentWorking,
  subagents,
  now,
  selectedId,
  multiPane,
  paneIds,
  onSelectParent,
  onSelectSubagent,
  onToggleMultiPane,
  onClose,
}: {
  agent: AgentId;
  parentLabel: string;
  parentWorking: boolean;
  subagents: SubagentSummary[];
  now: number;
  selectedId: string;
  multiPane: boolean;
  paneIds: string[];
  onSelectParent: () => void;
  onSelectSubagent: (callId: string) => void;
  onToggleMultiPane: () => void;
  onClose: () => void;
}) {
  const counts = subagentStatusCounts(subagents);
  const active = counts.running + counts.pending;

  return (
    <aside
      className={`agent-sub-navigator agent-sub--${agent}`}
      aria-label="Subagents navigator"
    >
      <header className="agent-sub-navigator-head">
        <span className="agent-sub-navigator-heading">
          <strong>Agents</strong>
          <small>{subagentFleetStatusLabel(subagents)}</small>
        </span>
        <button
          type="button"
          className={`agent-sub-mode${multiPane ? " is-active" : ""}`}
          onClick={onToggleMultiPane}
          aria-pressed={multiPane}
          title="Show multiple conversations"
          aria-label="Toggle multi-pane workspace"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="5.5" height="11" rx="1" />
            <rect x="9" y="2.5" width="5.5" height="11" rx="1" />
          </svg>
        </button>
        <button
          type="button"
          className="agent-sub-navigator-close"
          onClick={onClose}
          aria-label="Close subagents navigator"
          title="Close Agents"
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2.5 4.5 7 9 11.5" />
          </svg>
        </button>
      </header>

      <button
        type="button"
        className={`agent-sub-nav-row is-parent${selectedId === "parent" ? " is-selected" : ""}`}
        onClick={onSelectParent}
        aria-current={selectedId === "parent" ? "page" : undefined}
      >
        <span className="agent-sub-parent-mark" aria-hidden="true">P</span>
        <span className="agent-sub-nav-copy">
          <strong>Parent thread</strong>
          <small>{parentWorking ? "Synthesizing delegated work" : parentLabel}</small>
        </span>
        <span className={`agent-sub-nav-dot${parentWorking ? " is-live" : ""}`} aria-hidden="true" />
      </button>

      <div className="agent-sub-nav-list" role="list">
        {subagents.map((subagent) => {
          const elapsed = subagentElapsedLabel(subagent.startedAt, now, subagent.status);
          const selected = selectedId === subagent.callId;
          const pinned = multiPane && paneIds.includes(subagent.callId);
          return (
            <button
              key={subagent.callId}
              type="button"
              role="listitem"
              className={`agent-sub-nav-row is-${subagent.status}${selected ? " is-selected" : ""}`}
              onClick={() => onSelectSubagent(subagent.callId)}
              aria-current={selected ? "page" : undefined}
              aria-label={`${subagentStatusLabel(subagent.status)}: ${subagent.label}. ${subagentResultLine(subagent)}`}
            >
              <StatusMark subagent={subagent} />
              <span className="agent-sub-nav-copy">
                <strong>{subagent.label}</strong>
                <small>{subagentResultLine(subagent)}</small>
              </span>
              <span className="agent-sub-nav-meta">
                {pinned && <span aria-label="Open in workspace">▥</span>}
                {elapsed ?? (subagent.status === "done" ? "Done" : subagentStatusLabel(subagent.status))}
              </span>
            </button>
          );
        })}
      </div>

      <footer className="agent-sub-navigator-foot">
        <span><i className={active ? "is-live" : ""} />{active ? `${active} working` : "All settled"}</span>
        <span>{subagents.length} total</span>
      </footer>
    </aside>
  );
}

function PaneHeader({
  mark,
  title,
  detail,
  active,
  onActivate,
  onFocus,
  onClose,
}: {
  mark: string;
  title: string;
  detail: string;
  active: boolean;
  onActivate: () => void;
  onFocus: () => void;
  onClose?: () => void;
}) {
  return (
    <header className="agent-sub-pane-head" onClick={onActivate}>
      <span className="agent-sub-pane-mark" aria-hidden="true">{mark}</span>
      <button type="button" className="agent-sub-pane-title" onClick={onActivate}>
        <strong>{title}</strong>
        <small>{detail}</small>
      </button>
      <button
        type="button"
        className="agent-sub-pane-action"
        onClick={(event) => {
          event.stopPropagation();
          onFocus();
        }}
        aria-label={`Focus ${title}`}
        title="Focus this conversation"
      >
        ↗
      </button>
      {onClose && (
        <button
          type="button"
          className="agent-sub-pane-action"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          aria-label={`Close ${title} pane`}
          title="Close pane"
        >
          ×
        </button>
      )}
      {active && <span className="agent-sub-pane-active" aria-hidden="true" />}
    </header>
  );
}

export function SubagentMultiPane({
  agent,
  parentLabel,
  parentWorking,
  parent,
  subagents,
  now,
  activeId,
  onActivate,
  onFocus,
  onClosePane,
}: {
  agent: AgentId;
  parentLabel: string;
  parentWorking: boolean;
  parent: ReactNode;
  subagents: SubagentSummary[];
  now: number;
  activeId: string;
  onActivate: (id: string) => void;
  onFocus: (id: string) => void;
  onClosePane: (callId: string) => void;
}) {
  return (
    <section
      className={`agent-sub-workspace agent-sub--${agent}`}
      aria-label="Multi-pane subagent workspace"
    >
      <article className={`agent-sub-pane${activeId === "parent" ? " is-active" : ""}`}>
        <PaneHeader
          mark="P"
          title="Parent thread"
          detail={parentWorking ? "Working" : parentLabel}
          active={activeId === "parent"}
          onActivate={() => onActivate("parent")}
          onFocus={() => onFocus("parent")}
        />
        <div className="agent-sub-pane-scroll">{parent}</div>
      </article>

      {subagents.map((subagent) => (
        <article
          key={subagent.callId}
          className={`agent-sub-pane${activeId === subagent.callId ? " is-active" : ""}`}
        >
          <PaneHeader
            mark={subagentRoleMark(subagent)}
            title={subagent.label}
            detail={`${subagentStatusLabel(subagent.status)}${
              subagentElapsedLabel(subagent.startedAt, now, subagent.status)
                ? ` · ${subagentElapsedLabel(subagent.startedAt, now, subagent.status)}`
                : ""
            }`}
            active={activeId === subagent.callId}
            onActivate={() => onActivate(subagent.callId)}
            onFocus={() => onFocus(subagent.callId)}
            onClose={() => onClosePane(subagent.callId)}
          />
          <div className="agent-sub-pane-scroll">
            <SubagentFocus
              agent={agent}
              parentLabel={parentLabel}
              parentWorking={parentWorking}
              subagent={subagent}
              now={now}
              onBack={() => onFocus("parent")}
              showBack={false}
              compact
            />
          </div>
        </article>
      ))}
    </section>
  );
}
