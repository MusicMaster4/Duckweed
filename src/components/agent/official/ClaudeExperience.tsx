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

/** Claude's text blocks are user-visible progress, even when they are brief. */
function interimAssistantIds(items: ExperienceProps["items"], working: boolean): Set<string> {
  const ids = continuedAssistantIds(items);
  let turnStart = 0;
  const markTurn = (end: number, active: boolean) => {
    const assistants = items.slice(turnStart, end).filter((item) => item.kind === "assistant");
    for (const item of assistants.slice(0, active ? undefined : -1)) ids.add(item.id);
  };
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind !== "user") continue;
    markTurn(index, false);
    turnStart = index;
  }
  markTurn(items.length, working);
  return ids;
}

function compactUpdate(text: string): boolean {
  let length = 0;
  for (const _character of text) {
    if (++length > 110) return false;
  }
  return true;
}

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
  const transcriptItems = items;
  const groups = useMemo(() => activityGroups(transcriptItems), [transcriptItems]);
  const answerIds = useMemo(
    () => new Set(groups.flatMap((group) => (group.answerId ? [group.answerId] : []))),
    [groups],
  );
  const continuedIds = useMemo(
    () => interimAssistantIds(transcriptItems, status === "working" || status === "waiting"),
    [transcriptItems, status],
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
  let latestLiveContent: (typeof transcriptItems)[number] | undefined;
  for (let index = transcriptItems.length - 1; index > latestUserIndex; index -= 1) {
    const item = transcriptItems[index];
    if (item.kind === "assistant" || item.kind === "thinking" || item.kind === "tool") {
      latestLiveContent = item;
      break;
    }
  }
  const needsStillWorking = status === "working" && latestLiveContent?.kind === "assistant";
  const needsEmptyLiveTrace = status === "working" && !liveGroup && !needsStillWorking;
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
            !continuedIds.has(item.id) &&
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
                  ? compactUpdate(item.text)
                    ? "is-compact-update"
                    : "is-interim-update"
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
        {needsStillWorking && (
          <StillWorking
            variant="claude"
            clusterId={`${termId}:still:${liveUserId}`}
          />
        )}
      </div>
    </div>
  );
}
