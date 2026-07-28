import { useMemo } from "react";

import {
  ActivityHistory,
  activeAssistantId,
  activityGroups,
  continuedAssistantIds,
  MessageItem,
  PlanTracker,
  ProviderEmpty,
  type ExperienceProps,
} from "./OfficialShared";

export function ChatGPTExperience(props: ExperienceProps) {
  const { items, termId, status, started, agent, label, program, cwd } = props;
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
  const hasActivityAfterPrompt = items.slice(latestUserIndex + 1).some((item) => {
    if (item.kind === "user") return false;
    if (item.kind === "assistant") return Boolean(item.text.trim());
    return item.kind === "thinking" || item.kind === "tool" || item.kind === "plan";
  });
  const needsEmptyLiveTrace =
    status === "working" && latestUserIndex >= 0 && !hasActivityAfterPrompt;

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
    <div className="agent-experience chatgpt-experience">
      <div className="official-transcript">
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            const group = groupByActivity.get(item.id);
            if (
              !group ||
              item.id !== group.firstId ||
              group.replacedByCommentId ||
              (status === "working" && group === liveGroup && group.answerId)
            ) {
              return null;
            }
            return (
              <ActivityHistory
                key={`chatgpt-activity-${group.firstId}`}
                activities={group.activities}
                variant="chatgpt"
                working={status === "working" && group === liveGroup}
                showLatestThinking={group === groups[groups.length - 1]}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="chatgpt" />;
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
                <MessageItem item={item} variant="chatgpt" />
              </div>
            );
          }
          const messageClassName =
            [
              item.kind === "assistant" && continuedIds.has(item.id)
                ? "is-interim-update"
                : item.kind === "assistant" &&
                    status === "working" &&
                    liveGroup?.answerId === item.id
                  ? "is-interim-update"
                : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined;
          return (
            <MessageItem
              key={item.id}
              item={item}
              variant="chatgpt"
              className={messageClassName}
              showStreaming={
                item.kind === "assistant" ? item.id === liveAssistantId : undefined
              }
            />
          );
        })}
        {needsEmptyLiveTrace && (
          <ActivityHistory activities={[]} variant="chatgpt" working />
        )}
      </div>
    </div>
  );
}
