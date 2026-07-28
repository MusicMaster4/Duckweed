import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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

export function shouldDockCodexPrompt(
  status: ExperienceProps["status"],
  hasUserPrompt: boolean,
  hasActivityAfterPrompt: boolean,
  pendingThinkingVisible: boolean,
): boolean {
  if (!hasUserPrompt || hasActivityAfterPrompt) return false;
  if (status === "starting") return true;
  return status === "working" && !pendingThinkingVisible;
}

export function ChatGPTExperience(props: ExperienceProps) {
  const { items, termId, status, started, agent, label, program, cwd } = props;
  const [pendingThinkingVisible, setPendingThinkingVisible] = useState(false);
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
  const latestUserRef = useRef<HTMLElement>(null);
  const dockedRectRef = useRef<DOMRect | null>(null);
  const wasDockedRef = useRef(false);
  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const latestUserId = latestUserIndex >= 0 ? items[latestUserIndex]?.id : null;
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  const hasActivityAfterPrompt = items.slice(latestUserIndex + 1).some((item) => {
    if (item.kind === "user") return false;
    if (item.kind === "assistant") return Boolean(item.text.trim());
    return item.kind === "thinking" || item.kind === "tool" || item.kind === "plan";
  });
  const waitingForActivity =
    status === "working" && latestUserIndex >= 0 && !hasActivityAfterPrompt;
  const promptDocked = shouldDockCodexPrompt(
    status,
    latestUserIndex >= 0,
    hasActivityAfterPrompt,
    pendingThinkingVisible,
  );

  useEffect(() => {
    setPendingThinkingVisible(false);
    if (!waitingForActivity || !latestUserId) return;
    const timer = window.setTimeout(() => setPendingThinkingVisible(true), 80);
    return () => window.clearTimeout(timer);
  }, [latestUserId, waitingForActivity]);

  useLayoutEffect(() => {
    const node = latestUserRef.current;
    if (!node) return;

    if (promptDocked) {
      dockedRectRef.current = node.getBoundingClientRect();
      wasDockedRef.current = true;
      return;
    }

    if (!wasDockedRef.current || !dockedRectRef.current) return;
    const previous = dockedRectRef.current;
    const current = node.getBoundingClientRect();
    const deltaY = previous.top - current.top;
    wasDockedRef.current = false;
    dockedRectRef.current = null;

    if (
      Math.abs(deltaY) < 1 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof node.animate !== "function"
    ) {
      return;
    }

    node.animate(
      [
        { transform: `translateY(${deltaY}px)`, offset: 0 },
        { transform: "translateY(0)", offset: 1 },
      ],
      {
        duration: 220,
        easing: "cubic-bezier(0.2, 0.82, 0.2, 1)",
      },
    );
  }, [promptDocked, latestUserId]);

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
    <div
      className={`agent-experience chatgpt-experience${
        promptDocked ? " is-prompt-docked" : ""
      }`}
    >
      <div className="official-transcript">
        {items.map((item, index) => {
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
              index === latestUserIndex && !promptDocked && status === "working"
                ? "chatgpt-latest-prompt"
                : "",
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
              elementRef={index === latestUserIndex ? latestUserRef : undefined}
              className={messageClassName}
              showStreaming={
                item.kind === "assistant" ? item.id === liveAssistantId : undefined
              }
            />
          );
        })}
        {waitingForActivity && pendingThinkingVisible && (
          <ActivityHistory activities={[]} variant="chatgpt" working />
        )}
      </div>
    </div>
  );
}
