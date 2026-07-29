import { useEffect, useState } from "react";

import {
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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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
        <ToolActivity item={item} variant={nestedVariant(agent)} compact />
      );
    case "plan":
      return (
        <PlanTracker item={item} variant={nestedVariant(agent)} />
      );
    case "notice":
      return <p className={`agent-sub-nested-notice is-${item.tone}`}>{item.text}</p>;
    case "user":
      return <p className="agent-sub-nested-user">{item.text}</p>;
  }
}

export function SubagentInspector({
  agent,
  subagent,
  onClose,
  onShowInTimeline,
}: {
  agent: AgentId;
  subagent: SubagentSummary;
  onClose: () => void;
  onShowInTimeline: (callId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const status = subagentStatusLabel(subagent.status);

  useEffect(() => {
    setCopied(false);
  }, [subagent.callId]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const summary = [
    subagent.label,
    subagent.prompt ? `Prompt: ${subagent.prompt}` : "",
    subagent.output || subagent.activity,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <aside
      className={`agent-sub-inspector agent-sub--${agent} is-${subagent.status}`}
      aria-label={`Subagent inspector: ${subagent.label}`}
    >
      <header className="agent-sub-inspector-head">
        <span className="agent-sub-status-dot" aria-hidden="true" />
        <span className="agent-sub-inspector-title">
          <span>Subagent</span>
          <strong>{subagent.label}</strong>
        </span>
        <span className={`agent-sub-inspector-status is-${subagent.status}`}>
          {status}
        </span>
        <button
          type="button"
          className="agent-sub-inspector-close"
          onClick={onClose}
          aria-label="Close subagent inspector"
          title="Close inspector (Esc)"
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="m3.5 3.5 7 7m0-7-7 7" />
          </svg>
        </button>
      </header>

      <div className="agent-sub-inspector-scroll">
        {(subagent.role || subagent.model || subagent.threadId) && (
          <dl className="agent-sub-facts">
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
                <dd title={subagent.threadId}>{subagent.threadId}</dd>
              </div>
            )}
          </dl>
        )}

        {subagent.prompt && (
          <section className="agent-sub-inspector-section">
            <h3>Prompt</h3>
            <p>{subagent.prompt}</p>
          </section>
        )}

        <section className="agent-sub-inspector-section">
          <h3>Activity</h3>
          <div className="agent-sub-activity">
            <span className="agent-sub-status-dot" aria-hidden="true" />
            <span>{subagent.activity}</span>
          </div>
        </section>

        {subagent.items.length > 0 && (
          <section className="agent-sub-inspector-section">
            <h3>Nested activity</h3>
            <div className="agent-sub-nested-timeline">
              {subagent.items.map((item) => (
                <NestedSubagentItem
                  key={`${item.kind}-${item.id}`}
                  agent={agent}
                  item={item}
                />
              ))}
            </div>
          </section>
        )}

        <section className="agent-sub-inspector-section">
          <h3>{subagent.output ? "Output" : "Report"}</h3>
          {subagent.output ? (
            <pre className="agent-sub-output">{subagent.output}</pre>
          ) : (
            <p className="agent-sub-empty-output">
              {subagent.status === "running" || subagent.status === "pending"
                ? "Waiting for the first progress update."
                : "No additional output was reported."}
            </p>
          )}
        </section>

        {subagent.changes.length > 0 && (
          <section className="agent-sub-inspector-section">
            <h3>Changes</h3>
            <div className="agent-sub-changes">
              {subagent.changes.map((change, index) => (
                <AgentDiff key={`${change.path}-${index}`} change={change} />
              ))}
            </div>
          </section>
        )}

        {subagent.items.length === 0 && (
          <p className="agent-sub-fidelity">
            This agent only reports a summary for delegated work.
          </p>
        )}
      </div>

      <footer className="agent-sub-inspector-actions">
        <button
          type="button"
          onClick={() => {
            void copyText(summary).then(setCopied);
          }}
        >
          {copied ? "Copied" : "Copy summary"}
        </button>
        <button
          type="button"
          onClick={() => onShowInTimeline(subagent.callId)}
        >
          Show in timeline
        </button>
        <button type="button" onClick={onClose}>
          Collapse
        </button>
      </footer>
    </aside>
  );
}
