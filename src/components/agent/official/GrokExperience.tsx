import { useEffect, useMemo, useRef, useState } from "react";

import { SubagentBoardForActivities } from "../subagents/SubagentBoard";
import {
  ActivityHistory,
  activeAssistantId,
  activityClusterHiddenByComment,
  activityGroups,
  continuedAssistantIds,
  MessageItem,
  PlanTracker,
  ProviderEmpty,
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
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
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
  const continuedIds = useMemo(() => continuedAssistantIds(items), [items]);
  const liveAssistantId = useMemo(
    () => activeAssistantId(items, status === "working"),
    [items, status],
  );
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
  const hasLiveActivity = items
    .slice(latestUserIndex + 1)
    .some((item) => item.kind === "thinking" || item.kind === "tool");
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  const needsEmptyLiveTrace = status === "working" && !hasLiveActivity;
  const liveUserId =
    latestUserIndex >= 0 ? items[latestUserIndex]?.id : "session-start";

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
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            const group = groupByActivity.get(item.id);
            if (!group || item.id !== group.firstId) return null;
            if (activityClusterHiddenByComment(group, status === "working", liveGroup)) {
              return (
                <SubagentBoardForActivities
                  key={`grok-roster-${group.firstId}`}
                  activities={group.activities}
                />
              );
            }
            return (
              <ActivityHistory
                key={`grok-activity-${group.firstId}`}
                activities={group.activities}
                variant="grok"
                working={status === "working" && group === liveGroup}
                showLatestThinking={group === groups[groups.length - 1]}
                clusterId={`${termId}:${group.firstId}`}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="grok" />;
          }
          if (
            item.kind === "assistant" &&
            answerIds.has(item.id) &&
            status !== "working"
          ) {
            return (
              <div className="official-answer-layer grok-answer-layer" key={item.id}>
                <div className="official-answer-divider grok-answer-divider" aria-hidden="true">
                  <span>Answer</span>
                </div>
                <MessageItem
                  item={item}
                  variant="grok"
                  showStreaming={item.id === liveAssistantId}
                />
              </div>
            );
          }
          return (
            <MessageItem
              key={item.id}
              item={item}
              variant="grok"
              className={
                item.kind === "assistant" && continuedIds.has(item.id)
                  ? "is-interim-update"
                  : item.kind === "assistant" &&
                      status === "working" &&
                      liveGroup?.answerId === item.id
                    ? "is-interim-update"
                  : undefined
              }
              showStreaming={
                item.kind === "assistant" ? item.id === liveAssistantId : undefined
              }
            />
          );
        })}
        {needsEmptyLiveTrace && (
          <ActivityHistory
            activities={[]}
            variant="grok"
            working
            clusterId={`${termId}:live:${liveUserId}`}
          />
        )}
      </div>
    </div>
  );
}
