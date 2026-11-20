import { useMemo } from "react";

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
  StillWorking,
  type ExperienceProps,
} from "./OfficialShared";

/**
 * Antigravity CLI transcript experience.
 *
 * Groups reasoning traces and tool calls into collapsible activity clusters
 * while keeping interim updates visible and framing final answers cleanly.
 */
export function AntigravityExperience({
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
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user") {
      latestUserIndex = index;
      break;
    }
  }
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  let latestLiveContent: (typeof items)[number] | undefined;
  for (let index = items.length - 1; index > latestUserIndex; index -= 1) {
    const item = items[index];
    if (
      item.kind === "assistant" ||
      item.kind === "thinking" ||
      item.kind === "tool" ||
      (item.kind === "notice" && item.tone === "error")
    ) {
      latestLiveContent = item;
      break;
    }
  }
  const needsStillWorking =
    status === "working" && latestLiveContent?.kind === "assistant";
  const needsEmptyLiveTrace =
    status === "working" && !liveGroup && !needsStillWorking;
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
    <div className="agent-experience antigravity-experience">
      <div className="official-transcript">
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            const group = groupByActivity.get(item.id);
            if (!group || item.id !== group.firstId) return null;
            if (activityClusterHiddenByComment(group, status === "working", liveGroup)) {
              return (
                <SubagentBoardForActivities
                  key={`antigravity-roster-${group.firstId}`}
                  activities={group.activities}
                />
              );
            }
            return (
              <ActivityHistory
                key={`antigravity-activity-${group.firstId}`}
                activities={group.activities}
                variant="antigravity"
                working={status === "working" && group === liveGroup}
                showLatestThinking={group === groups[groups.length - 1]}
                clusterId={`${termId}:${group.firstId}`}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="antigravity" />;
          }
          if (
            item.kind === "assistant" &&
            answerIds.has(item.id) &&
            !continuedIds.has(item.id) &&
            status !== "working"
          ) {
            return (
              <div className="official-answer-layer" key={item.id}>
                <div className="official-answer-divider" aria-hidden="true">
                  <span>Answer</span>
                </div>
                <MessageItem
                  item={item}
                  variant="antigravity"
                  showStreaming={item.id === liveAssistantId}
                />
              </div>
            );
          }
          return (
            <MessageItem
              key={item.id}
              item={item}
              variant="antigravity"
              className={
                item.kind === "assistant" &&
                (continuedIds.has(item.id) ||
                  (status === "working" && liveGroup?.answerId === item.id))
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
            variant="antigravity"
            working
            clusterId={`${termId}:live:${liveUserId}`}
          />
        )}
        {needsStillWorking && (
          <StillWorking
            variant="antigravity"
            clusterId={`${termId}:still:${liveUserId}`}
          />
        )}
      </div>
    </div>
  );
}
