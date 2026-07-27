import { useMemo, useState } from "react";

import claudeWritingMark from "../../../assets/claude-writing.svg";
import type { ThinkingItem, ToolItem } from "../../../lib/agents/types";
import {
  activityGroups,
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
  const summary = latestThought ? traceSummary(latestThought.text) : "Thinking";
  const streaming = working || latestThought?.streaming;

  // A completed turn has no live "Thinking" state. Preserve every command in
  // the transcript as normal expandable activity rows instead.
  if (!working) {
    if (!tools.length) return null;
    return (
      <div className="claude-completed-tools">
        {tools.map((item) => (
          <ToolActivity key={item.id} item={item} variant="claude" />
        ))}
      </div>
    );
  }

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
          {thoughts.map((item) => (
            <ThinkingStep key={item.id} item={item} />
          ))}
          {!thoughts.length && (
            <div className="claude-trace-step is-streaming">
              <span className="claude-trace-node" aria-hidden="true" />
              <p>Thinking</p>
            </div>
          )}
        </div>
      )}
      {tools.length > 0 && (
        <div className="claude-live-tools">
          {tools.map((item) => (
            <ToolActivity key={item.id} item={item} variant="claude" />
          ))}
        </div>
      )}
    </section>
  );
}

export function ClaudeExperience({
  items,
  status,
  started,
  agent,
  label,
  program,
  cwd,
}: ExperienceProps) {
  const groups = useMemo(() => activityGroups(items), [items]);
  const groupByActivity = useMemo(
    () =>
      new Map(
        groups.flatMap((group) =>
          group.activities.map((activity) => [activity.id, group] as const),
        ),
      ),
    [groups],
  );
  let latestUserIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind === "user") latestUserIndex = index;
  }
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  const needsEmptyLiveTrace = status === "working" && !liveGroup;

  if (!started && status !== "error") {
    return (
      <ProviderEmpty
        agent={agent}
        label={label}
        program={program}
        cwd={cwd}
        status={status}
      />
    );
  }

  return (
    <div className="agent-experience claude-experience">
      <div className="official-transcript">
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            const group = groupByActivity.get(item.id);
            if (!group || item.id !== group.firstId) return null;
            return (
              <ClaudeTrace
                key={`claude-trace-${group.firstId}`}
                activities={group.activities}
                working={status === "working" && group === liveGroup}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="claude" />;
          }
          return <MessageItem key={item.id} item={item} variant="claude" />;
        })}
        {needsEmptyLiveTrace && (
          <ClaudeTrace activities={[]} working />
        )}
      </div>
    </div>
  );
}
