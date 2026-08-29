import { useState } from "react";

import {
  subagentElapsedLabel,
  subagentStatusLabel,
  type SubagentSummary,
} from "../../../lib/agents/subagents";
import type { AgentId, AgentItem } from "../../../lib/agents/types";
import { AgentDiff } from "../AgentDiff";
import {
  AssistantMarkdown,
  PlanTracker,
  ToolActivity,
  type OfficialVariant,
} from "../official/OfficialShared";

function nestedVariant(agent: AgentId): OfficialVariant | "cursor" | "opencode" {
  return agent === "codex" ? "chatgpt" : agent;
}

function NestedSubagentItem({
  agent,
  item,
}: {
  agent: AgentId;
  item: AgentItem;
}) {
  switch (item.kind) {
    case "assistant":
      return (
        <article className="agent-sub-nested-message is-assistant">
          <AssistantMarkdown text={item.text} />
        </article>
      );
    case "thinking":
      return (
        <article className="agent-sub-nested-message is-thinking">
          <span>Thinking</span>
          <AssistantMarkdown text={item.text} />
        </article>
      );
    case "tool":
      return (
        <ToolActivity
          item={item}
          variant={nestedVariant(agent)}
          compact
          expandSubagentLocally
        />
      );
    case "plan":
      return item.steps.length > 0 ? (
        <PlanTracker item={item} variant={nestedVariant(agent)} />
      ) : null;
    case "notice":
      return <p className={`agent-sub-nested-notice is-${item.tone}`}>{item.text}</p>;
    case "user":
      return <p className="agent-sub-nested-user">{item.text}</p>;
  }
}

export function SubagentFocus({
  agent,
  parentLabel,
  parentWorking,
  subagent,
  now,
  onBack,
  showBack = true,
  compact = false,
}: {
  agent: AgentId;
  parentLabel: string;
  parentWorking: boolean;
  subagent: SubagentSummary;
  now: number;
  onBack: () => void;
  showBack?: boolean;
  compact?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const status = subagentStatusLabel(subagent.status);
  const elapsed = subagentElapsedLabel(subagent.startedAt, now, subagent.status);
  const nested = subagent.items.length > 0;
  const waiting = subagent.status === "running" || subagent.status === "pending";

  return (
    <div
      className={`agent-sub-focus agent-sub--${agent} is-${subagent.status}${compact ? " is-compact" : ""}`}
      aria-label={`Subagent: ${subagent.label}`}
    >
      <header className="agent-sub-focus-head">
        {showBack && (
          <button
            type="button"
            className="agent-sub-back"
            onClick={onBack}
            aria-label="Back to parent"
          >
            <span aria-hidden="true">←</span>
            <span>{parentLabel}</span>
          </button>
        )}
        <strong className="agent-sub-focus-title">{subagent.label}</strong>
        <span className={`agent-sub-focus-status is-${subagent.status}`}>
          {status}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
        {parentWorking && (
          <span className="agent-sub-parent-live">Parent still working</span>
        )}
      </header>

      {subagent.prompt && (
        <section className="agent-sub-focus-prompt">
          <button
            type="button"
            className="agent-sub-focus-prompt-toggle"
            aria-expanded={promptOpen}
            onClick={() => setPromptOpen((open) => !open)}
          >
            Prompt
          </button>
          {promptOpen ? (
            <p>{subagent.prompt}</p>
          ) : (
            <p className="is-truncated">{subagent.prompt}</p>
          )}
        </section>
      )}

      {(subagent.role || subagent.model || subagent.threadId) && (
        <section className="agent-sub-focus-details">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            Details
          </button>
          {detailsOpen && (
            <dl>
              {subagent.role && (
                <div>
                  <dt>Role</dt>
                  <dd>{subagent.role}</dd>
                </div>
              )}
              {subagent.model && (
                <div>
                  <dt>Model</dt>
                  <dd>{subagent.model}</dd>
                </div>
              )}
              {subagent.threadId && (
                <div>
                  <dt>Thread</dt>
                  <dd>{subagent.threadId}</dd>
                </div>
              )}
            </dl>
          )}
        </section>
      )}

      {nested ? (
        <div className="agent-sub-nested-timeline" aria-live="polite">
          {subagent.items.map((item) => (
            <NestedSubagentItem
              key={`${item.kind}-${item.id}`}
              agent={agent}
              item={item}
            />
          ))}
        </div>
      ) : (
        <div className="agent-sub-focus-empty">
          {subagent.output ? (
            <article className="agent-sub-reported-result">
              <span>Reported result</span>
              <AssistantMarkdown text={subagent.output} />
            </article>
          ) : (
            <p className="agent-sub-empty-output">
              {waiting
                ? "Waiting for the first message from this subagent."
                : "This provider did not expose a child transcript."}
            </p>
          )}
        </div>
      )}

      {subagent.changes.length > 0 && (
        <section className="agent-sub-changes" aria-label="Changes">
          {subagent.changes.map((change, index) => (
            <AgentDiff key={`${change.path}-${index}`} change={change} />
          ))}
        </section>
      )}
    </div>
  );
}
