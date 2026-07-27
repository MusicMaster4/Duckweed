import { useMemo, useState } from "react";

import claudeWritingMark from "../../../assets/claude-writing.svg";
import type { ThinkingItem, ToolItem } from "../../../lib/agents/types";
import {
  activityItems,
  Chevron,
  MessageItem,
  PlanTracker,
  ProviderEmpty,
  ToolActivity,
  traceLines,
  traceSummary,
  type ExperienceProps,
} from "./OfficialShared";

export function ClaudeSpark({ active = true }: { active?: boolean }) {
  return (
    <span className={`claude-spark${active ? " is-active" : ""}`} aria-hidden="true">
      <img src={claudeWritingMark} alt="" draggable={false} />
    </span>
  );
}

function ThinkingStep({ item }: { item: ThinkingItem }) {
  const lines = traceLines(item.text);
  return (
    <div className={`claude-trace-step${item.streaming ? " is-streaming" : ""}`}>
      <span className="claude-trace-node" aria-hidden="true">
        <svg viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="4.2" />
          <path d="M7 4.8v2.5l1.7 1" />
        </svg>
      </span>
      <div>
        {lines.length ? lines.map((line, index) => <p key={index}>{line}</p>) : <p>Thinking</p>}
      </div>
    </div>
  );
}

function ClaudeTrace({
  activities,
  working,
}: {
  activities: Array<ThinkingItem | ToolItem>;
  working: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thoughts = activities.filter((item): item is ThinkingItem => item.kind === "thinking");
  const tools = activities.filter((item): item is ToolItem => item.kind === "tool");
  const latestThought = thoughts[thoughts.length - 1];
  const latestTool = tools[tools.length - 1];
  const summary = latestThought ? traceSummary(latestThought.text) : "Thinking";
  const streaming = working || latestThought?.streaming;

  return (
    <section className={`claude-trace${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="claude-trace-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="claude-spark-slot">
          <ClaudeSpark active={Boolean(streaming)} />
        </span>
        <span className={streaming ? "claude-shimmer" : ""}>{summary}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="claude-trace-timeline">
          {activities.map((item) =>
            item.kind === "thinking" ? (
              <ThinkingStep key={item.id} item={item} />
            ) : (
              <div className="claude-trace-tool" key={item.id}>
                <span className="claude-trace-node is-tool" aria-hidden="true" />
                <ToolActivity item={item} variant="claude" />
              </div>
            ),
          )}
          {!activities.length && (
            <div className="claude-trace-step is-streaming">
              <span className="claude-trace-node" aria-hidden="true" />
              <p>Thinking</p>
            </div>
          )}
        </div>
      )}
      {!open && latestTool && (
        <div className="claude-latest-tool">
          <ToolActivity item={latestTool} variant="claude" compact />
        </div>
      )}
    </section>
  );
}

export function ClaudeExperience({ items, status, started, label, mark, cwd }: ExperienceProps) {
  const activities = useMemo(() => activityItems(items), [items]);
  const firstActivityId = activities[0]?.id ?? null;
  const shouldShowTrace = activities.length > 0 || status === "working";
  let traceRendered = false;

  if (!started && status !== "error") {
    return (
      <ProviderEmpty
        label={label}
        mark={mark}
        cwd={cwd}
        status={status}
        loader={
          <span className="claude-starting">
            <ClaudeSpark />
            <span className="claude-shimmer">Starting up…</span>
          </span>
        }
      />
    );
  }

  return (
    <div className="agent-experience claude-experience">
      <div className="official-transcript">
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            if (traceRendered || item.id !== firstActivityId) return null;
            traceRendered = true;
            return (
              <ClaudeTrace
                key="claude-trace"
                activities={activities}
                working={status === "working"}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="claude" />;
          }
          return <MessageItem key={item.id} item={item} variant="claude" />;
        })}
        {shouldShowTrace && !traceRendered && (
          <ClaudeTrace activities={activities} working={status === "working"} />
        )}
      </div>
    </div>
  );
}
