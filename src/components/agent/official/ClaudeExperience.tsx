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
  shortAssistantUpdatesAsThinking,
  type ExperienceProps,
} from "./OfficialShared";

export function ClaudeExperience({
  items,
  termId,
  status,
  started,
  agent,
  label,
  program,
  cwd,
}: ExperienceProps) {
  const transcriptItems = useMemo(
    () => shortAssistantUpdatesAsThinking(items, status === "working", 110),
    [items, status],
  );
  const groups = useMemo(() => activityGroups(transcriptItems), [transcriptItems]);
  const answerIds = useMemo(
    () => new Set(groups.flatMap((group) => (group.answerId ? [group.answerId] : []))),
    [groups],
  );
  const continuedIds = useMemo(
    () => continuedAssistantIds(transcriptItems),
    [transcriptItems],
  );
  const liveAssistantId = useMemo(
    () => activeAssistantId(transcriptItems, status === "working"),
    [transcriptItems, status],
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
  for (let index = 0; index < transcriptItems.length; index += 1) {
    if (transcriptItems[index].kind === "user") latestUserIndex = index;
  }
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  const needsEmptyLiveTrace = status === "working" && !liveGroup;
  const liveUserId =
    latestUserIndex >= 0 ? transcriptItems[latestUserIndex]?.id : "session-start";

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
    <div className="agent-experience claude-experience">
      <div className="official-transcript">
        {transcriptItems.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            const group = groupByActivity.get(item.id);
            if (!group || item.id !== group.firstId) return null;
            if (activityClusterHiddenByComment(group, status === "working", liveGroup)) {
              return (
                <SubagentBoardForActivities
                  key={`claude-roster-${group.firstId}`}
                  activities={group.activities}
                />
              );
            }
            return (
              <ActivityHistory
                key={`claude-activity-${group.firstId}`}
                activities={group.activities}
                variant="claude"
                working={status === "working" && group === liveGroup}
                showLatestThinking={group === groups[groups.length - 1]}
                clusterId={`${termId}:${group.firstId}`}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="claude" />;
          }
          if (
            item.kind === "assistant" &&
            answerIds.has(item.id) &&
            status !== "working"
          ) {
            return (
              <div className="official-answer-layer" key={item.id}>
                <div className="official-answer-divider" aria-hidden="true">
                  <span>Answer</span>
                </div>
                <MessageItem item={item} variant="claude" />
              </div>
            );
          }
          return (
            <MessageItem
              key={item.id}
              item={item}
              variant="claude"
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
            variant="claude"
            working
            clusterId={`${termId}:live:${liveUserId}`}
          />
        )}
      </div>
    </div>
  );
}
