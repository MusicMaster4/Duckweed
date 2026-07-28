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
  const groups = useMemo(() => activityGroups(items), [items]);
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
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  const needsEmptyLiveTrace = status === "working" && !liveGroup;

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
        {items.map((item) => {
          if (item.kind === "thinking" || item.kind === "tool") {
            const group = groupByActivity.get(item.id);
            if (
              !group ||
              item.id !== group.firstId ||
              group.replacedByCommentId
            ) {
              return null;
            }
            return (
              <ActivityHistory
                key={`claude-activity-${group.firstId}`}
                activities={group.activities}
                variant="claude"
                working={status === "working" && group === liveGroup}
                showLatestThinking={group === groups[groups.length - 1]}
              />
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="claude" />;
          }
          return (
            <MessageItem
              key={item.id}
              item={item}
              variant="claude"
              className={
                item.kind === "assistant" && continuedIds.has(item.id)
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
          <ActivityHistory activities={[]} variant="claude" working />
        )}
      </div>
    </div>
  );
}
