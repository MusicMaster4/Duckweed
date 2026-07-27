import { useMemo, useState } from "react";

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

const SPARK_PATH =
  "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";

const SPARK_FRAMES = [
  "translate(0 0)",
  "translate(50 150) rotate(8) scale(.96) translate(-50 -50)",
  "translate(50 250) rotate(-7) scale(1.03) translate(-50 -50)",
  "translate(50 350) rotate(13) scale(.93) translate(-50 -50)",
  "translate(50 450) rotate(-11) scale(1.04) translate(-50 -50)",
  "translate(50 550) rotate(6) scale(.97) translate(-50 -50)",
  "translate(50 650) rotate(-4) scale(1.02) translate(-50 -50)",
  "translate(50 750) rotate(10) scale(.95) translate(-50 -50)",
];

export function ClaudeSpark({ active = true }: { active?: boolean }) {
  return (
    <span className={`claude-spark${active ? " is-active" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 100 800">
        {SPARK_FRAMES.map((transform, index) => (
          <g key={index} transform={transform}>
            <path d={SPARK_PATH} />
          </g>
        ))}
      </svg>
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
