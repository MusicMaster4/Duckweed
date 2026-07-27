import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentItem, ThinkingItem, ToolItem } from "../../../lib/agents/types";
import {
  activityGroups,
  AssistantMarkdown,
  Chevron,
  MessageItem,
  PlanTracker,
  ProviderEmpty,
  ToolActivity,
  ToolIcon,
  traceSummary,
  type ExperienceProps,
} from "./OfficialShared";

const GROK_DOTS = [
  [18.4, 5.6, 0],
  [12, 5.6, 1],
  [5.6, 5.6, 2],
  [5.6, 12, 3],
  [5.6, 18.4, 4],
  [12, 18.4, 5],
  [18.4, 18.4, 6],
  [18.4, 12, 7],
  [12, 12, 8],
] as const;

const GROK_SOURCE_FRAMES = 80;
const GROK_CYCLE_MS = (40 / 30) * 1000;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

/**
 * The published Lottie is a 40-frame composition whose nested dot layer is
 * time-stretched by .507. The nested sequence therefore traverses roughly 80
 * source frames during one 1.333s loop. Keeping those global key times makes
 * the animation complete one lap, arrive at the center, rest, and only then
 * begin the next lap.
 */
export function GrokDotMatrix({ active = true }: { active?: boolean }) {
  const reducedMotion = useReducedMotion();
  const animate = active && !reducedMotion;
  const animationPhase = useRef({ active: false, offsetMs: 0 });
  if (animationPhase.current.active !== animate) {
    animationPhase.current.active = animate;
    if (animate) animationPhase.current.offsetMs = -(Date.now() % GROK_CYCLE_MS);
  }

  return (
    <svg
      key={animate ? "grok-matrix-active" : "grok-matrix-settled"}
      className={`grok-dot-matrix${animate ? " is-active" : " is-settled"}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {GROK_DOTS.map(([cx, cy, phase]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="1.6"
          opacity={0.2}
        >
          {animate && (
            <animate
              attributeName="opacity"
              begin={`${animationPhase.current.offsetMs}ms`}
              dur={`${GROK_CYCLE_MS}ms`}
              repeatCount="indefinite"
              calcMode="spline"
              values={
                phase === 0
                  ? "0.2;1;1;0.2;0.2"
                  : phase === 8
                    ? "0.2;0.2;1;1;1"
                    : "0.2;0.2;1;1;0.2;0.2"
              }
              keyTimes={
                phase === 0
                  ? "0;0.15625;0.25;0.5;1"
                  : phase === 8
                    ? "0;0.5;0.65625;0.75;1"
                    : [
                        0,
                        (phase * 5) / GROK_SOURCE_FRAMES,
                        (phase * 5 + 12.5) / GROK_SOURCE_FRAMES,
                        (phase * 5 + 20) / GROK_SOURCE_FRAMES,
                        (phase * 5 + 40) / GROK_SOURCE_FRAMES,
                        1,
                      ].join(";")
              }
              keySplines={
                phase === 0 || phase === 8
                  ? "0.45 0 0.1 1;0.45 0 0.1 1;0.45 0 0.1 1;0 0 1 1"
                  : "0 0 1 1;0.45 0 0.1 1;0.45 0 0.1 1;0.45 0 0.1 1;0 0 1 1"
              }
            />
          )}
        </circle>
      ))}
    </svg>
  );
}

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function useTraceTimer(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}

function GrokThinkingEvent({
  item,
  active,
  endedAt,
}: {
  item: ThinkingItem;
  active: boolean;
  endedAt: number | null;
}) {
  const [open, setOpen] = useState(active);
  const wasActive = useRef(active);
  const liveSeconds = useTraceTimer(item.at, active);
  const settledSeconds =
    endedAt === null ? liveSeconds : Math.max(0, Math.round((endedAt - item.at) / 1000));
  const expandable = item.text.trim().length > 0;

  useEffect(() => {
    if (wasActive.current && !active) setOpen(false);
    wasActive.current = active;
  }, [active]);

  return (
    <section
      className={`grok-thought${open ? " is-open" : ""}${
        active ? " is-streaming" : " is-settled"
      }`}
    >
      <button
        type="button"
        className="grok-thought-head"
        onClick={() => expandable && setOpen((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="grok-loader-slot">
          <GrokDotMatrix active={active} />
        </span>
        {expandable && (
          <span className="grok-hover-chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="m5 6 3 3 3-3" />
            </svg>
          </span>
        )}
        <span className="grok-thought-copy">
          <span className="grok-thought-meta">
            {active
              ? `Thinking · ${elapsedLabel(liveSeconds)}`
              : `Thought for ${elapsedLabel(settledSeconds)}`}
          </span>
          <span className="grok-thought-summary">{traceSummary(item.text)}</span>
        </span>
      </button>
      <div className="grok-thought-body" hidden={!open}>
        <AssistantMarkdown text={item.text} />
      </div>
    </section>
  );
}

function GrokPendingThought() {
  const startedAt = useRef(Date.now());
  const seconds = useTraceTimer(startedAt.current, true);
  return (
    <div className="grok-thought is-streaming is-pending" role="status">
      <span className="grok-loader-slot">
        <GrokDotMatrix active />
      </span>
      <span className="grok-thought-meta">Thinking · {elapsedLabel(seconds)}</span>
    </div>
  );
}

function GrokToolHistory({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const latest = tools[tools.length - 1];
  if (!latest) return null;
  const running = latest.status === "running" || latest.status === "pending";
  const status =
    latest.status === "error" ? "Failed" : running ? "Running" : "Completed";

  return (
    <section
      className={`grok-tool-history${open ? " is-open" : ""}${
        running ? " is-running" : ""
      }`}
    >
      <button
        type="button"
        className="grok-tool-history-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="official-tool-mark">
          <ToolIcon kind={latest.tool} />
          {running && <span className="official-tool-spinner" aria-hidden="true" />}
        </span>
        <span className="grok-tool-history-copy">
          <strong>{latest.title || latest.name}</strong>
          <span>
            {tools.length > 1 ? `${tools.length} tool calls · ${status}` : status}
          </span>
        </span>
        {latest.status === "done" && <span className="official-tool-done">✓</span>}
        {latest.status === "error" && <span className="official-tool-error">!</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="grok-tool-history-list" aria-label="Tool call history">
          {tools.map((tool) => (
            <ToolActivity key={tool.id} item={tool} variant="grok" compact />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Grok streams short progress prose through the same ACP message channel as
 * its final answer. In a turn that also performs work, only the first message
 * after the last activity is the answer; earlier message chunks are status
 * narration and would otherwise produce several fake replies.
 */
export function hiddenGrokProgressMessages(
  items: AgentItem[],
  working = false,
): Set<string> {
  const hidden = new Set<string>();

  const inspectTurn = (start: number, end: number) => {
    const turn = items.slice(start, end);
    let lastActivity = -1;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      if (turn[index].kind === "thinking" || turn[index].kind === "tool") {
        lastActivity = index;
        break;
      }
    }
    if (lastActivity < 0) return;
    const tools = turn.filter((item): item is ToolItem => item.kind === "tool");
    const canShowLiveAnswer =
      !working ||
      (tools.length > 0 &&
        tools.every((tool) => tool.status === "done" || tool.status === "error"));
    const answer = canShowLiveAnswer
      ? turn.findIndex(
          (item, index) => index > lastActivity && item.kind === "assistant",
        )
      : -1;
    turn.forEach((item, index) => {
      if (item.kind === "assistant" && index !== answer) hidden.add(item.id);
    });
  };

  let turnStart = 0;
  for (let index = 1; index < items.length; index += 1) {
    if (items[index].kind !== "user") continue;
    inspectTurn(turnStart, index);
    turnStart = index;
  }
  inspectTurn(turnStart, items.length);
  return hidden;
}

export function GrokExperience({
  items,
  termId,
  status,
  started,
  agent,
  label,
  program,
  cwd,
}: ExperienceProps) {
  const groups = useMemo(() => activityGroups(items), [items]);
  const answerIds = useMemo(
    () => new Set(groups.flatMap((group) => (group.answerId ? [group.answerId] : []))),
    [groups],
  );
  const hiddenProgressIds = useMemo(
    () => hiddenGrokProgressMessages(items, status === "working"),
    [items, status],
  );
  const toolGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          key: group.firstId,
          tools: group.activities.filter((item): item is ToolItem => item.kind === "tool"),
        }))
        .filter((group) => group.tools.length > 0),
    [groups],
  );
  const toolGroupByLatestId = useMemo(
    () =>
      new Map(
        toolGroups.map((group) => [
          group.tools[group.tools.length - 1].id,
          group,
        ]),
      ),
    [toolGroups],
  );
  const groupedToolIds = useMemo(
    () => new Set(toolGroups.flatMap((group) => group.tools.map((tool) => tool.id))),
    [toolGroups],
  );
  let latestUserIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind === "user") latestUserIndex = index;
  }
  const hasLiveActivity = items
    .slice(latestUserIndex + 1)
    .some((item) => item.kind === "thinking" || item.kind === "tool");
  const needsEmptyLiveTrace = status === "working" && !hasLiveActivity;

  if (!started && status !== "error") {
    return (
      <ProviderEmpty
        agent={agent}
        termId={termId}
        label={label}
        program={program}
        cwd={cwd}
        status={status}
      />
    );
  }

  return (
    <div className="agent-experience grok-experience">
      <div className="official-transcript">
        {items.map((item, index) => {
          if (item.kind === "thinking") {
            return (
              <GrokThinkingEvent
                key={item.id}
                item={item}
                active={status === "working" && item.streaming}
                endedAt={items[index + 1]?.at ?? null}
              />
            );
          }
          if (item.kind === "tool") {
            const group = toolGroupByLatestId.get(item.id);
            if (!group && groupedToolIds.has(item.id)) return null;
            return (
              <div key={group ? `grok-tools-${group.key}` : item.id} className="grok-tool-wrap">
                <GrokToolHistory tools={group?.tools ?? [item]} />
              </div>
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="grok" />;
          }
          if (item.kind === "assistant" && hiddenProgressIds.has(item.id)) return null;
          if (item.kind === "assistant" && answerIds.has(item.id)) {
            return (
              <div className="grok-answer-layer" key={item.id}>
                <div className="grok-answer-divider" aria-hidden="true">
                  <span>Answer</span>
                </div>
                <MessageItem item={item} variant="grok" />
              </div>
            );
          }
          return <MessageItem key={item.id} item={item} variant="grok" />;
        })}
        {needsEmptyLiveTrace && <GrokPendingThought />}
      </div>
    </div>
  );
}
