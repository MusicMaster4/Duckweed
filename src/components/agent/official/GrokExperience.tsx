import { useEffect, useMemo, useRef, useState } from "react";

import type { ThinkingItem, ToolItem } from "../../../lib/agents/types";
import {
  activityItems,
  MessageItem,
  PlanTracker,
  ProviderEmpty,
  ToolActivity,
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
          opacity={animate ? 0.2 : phase === 8 ? 1 : 0.2}
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
                    ? "0.2;0.2;1;1;0.2"
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

function GrokThinkingStep({ item, connected }: { item: ThinkingItem; connected: boolean }) {
  return (
    <div className={`grok-trace-step${connected ? " is-connected" : ""}`}>
      <span className="grok-trace-node" aria-hidden="true" />
      <p>{traceSummary(item.text)}</p>
    </div>
  );
}

function GrokTrace({
  activities,
  working,
}: {
  activities: Array<ThinkingItem | ToolItem>;
  working: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thoughts = activities.filter((item): item is ThinkingItem => item.kind === "thinking");
  const latestThought = thoughts[thoughts.length - 1];
  const seconds = useTraceTimer(activities[0]?.at ?? null, working);
  const expandable = activities.length > 0;
  const visibleCollapsed = working ? activities.slice(-2) : [];
  const title = working
    ? traceSummary(latestThought?.text ?? "Thinking")
    : `Thought for ${elapsedLabel(seconds)}`;

  return (
    <section className={`grok-trace${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="grok-trace-head"
        onClick={() => expandable && setOpen((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="grok-loader-slot">
          <GrokDotMatrix active={working} />
        </span>
        {expandable && (
          <span className="grok-hover-chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="m5 6 3 3 3-3" />
            </svg>
          </span>
        )}
        <span>
          {title}
          {working && <span className="grok-live-time"> • {elapsedLabel(seconds)}</span>}
        </span>
      </button>
      {open && (
        <div className="grok-trace-timeline">
          {activities.map((item, index) =>
            item.kind === "thinking" ? (
              <GrokThinkingStep
                key={item.id}
                item={item}
                connected={index < activities.length - 1}
              />
            ) : (
              <div
                key={item.id}
                className={`grok-trace-tool${index < activities.length - 1 ? " is-connected" : ""}`}
              >
                <span className="grok-trace-node" aria-hidden="true" />
                <ToolActivity item={item} variant="grok" />
              </div>
            ),
          )}
        </div>
      )}
      {!open && visibleCollapsed.length > 0 && (
        <div className="grok-collapsed-steps">
          {visibleCollapsed.map((item, index) =>
            item.kind === "thinking" ? (
              <GrokThinkingStep
                key={item.id}
                item={item}
                connected={index < visibleCollapsed.length - 1}
              />
            ) : (
              <ToolActivity key={item.id} item={item} variant="grok" compact />
            ),
          )}
        </div>
      )}
    </section>
  );
}

export function GrokExperience({ items, status, started, label, mark, cwd }: ExperienceProps) {
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
          <span className="grok-starting">
            <GrokDotMatrix />
            <span>Starting up…</span>
          </span>
        }
      />
    );
  }

  return (
    <div className="agent-experience grok-experience">
      <div className="official-transcript">
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            if (traceRendered || item.id !== firstActivityId) return null;
            traceRendered = true;
            return <GrokTrace key="grok-trace" activities={activities} working={status === "working"} />;
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="grok" />;
          }
          return <MessageItem key={item.id} item={item} variant="grok" />;
        })}
        {shouldShowTrace && !traceRendered && (
          <GrokTrace activities={activities} working={status === "working"} />
        )}
      </div>
    </div>
  );
}
