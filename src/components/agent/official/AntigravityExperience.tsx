import { useMemo } from "react";

import type { AgentItem } from "../../../lib/agents/types";
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
  StillWorking,
  type ExperienceProps,
} from "./OfficialShared";

const ANTIGRAVITY_ASSISTANT_THINKING_LIMIT = 300;
const ANTIGRAVITY_MILESTONE_MIN_CHARS = 450;
const ANTIGRAVITY_MILESTONE_MAX_CHARS = 2_400;
const ANTIGRAVITY_BOILERPLATE_LEAD =
  /^I['’]m thinking through how to approach this\.?(?:\s*\r?\n)+\s*/i;

type AssistantItem = Extract<AgentItem, { kind: "assistant" }>;
type ThinkingItem = Extract<AgentItem, { kind: "thinking" }>;

const promotedThinkingCache = new WeakMap<ThinkingItem, AssistantItem>();

function countCodePointsUpTo(text: string, limit: number): number {
  let count = 0;
  for (const _character of text) {
    count += 1;
    if (count > limit) return count;
  }
  return count;
}

function cleanAntigravityMilestoneText(text: string): string {
  return text.trim().replace(ANTIGRAVITY_BOILERPLATE_LEAD, "").trim();
}

function thinkingAsAssistant(item: ThinkingItem, cleanedText: string): AssistantItem {
  const cached = promotedThinkingCache.get(item);
  if (cached && cached.text === cleanedText) return cached;
  const assistant: AssistantItem = {
    ...item,
    kind: "assistant",
    text: cleanedText,
    streaming: false,
  };
  promotedThinkingCache.set(item, assistant);
  return assistant;
}

/**
 * Project Antigravity's ACP transcript into highlighted milestones and folded
 * thinking traces.
 *
 * Antigravity streams almost all mid-turn narration as `agent_thought_chunk`:
 * brief single-paragraph step updates (<= 450 chars) and deep internal reasoning
 * walls (> 2400 chars) stay inside Thinking, while settled mid-turn milestones
 * followed by further tool work stay pinned as highlighted interim updates.
 * Direct assistant commentary follows Codex's 300-character threshold.
 */
export function antigravityTranscriptItems(
  items: AgentItem[],
  working: boolean,
): AgentItem[] {
  const originalThinkingIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "thinking") originalThinkingIds.add(item.id);
  }
  const base = shortAssistantUpdatesAsThinking(
    items,
    working,
    ANTIGRAVITY_ASSISTANT_THINKING_LIMIT,
  );
  const promoted = [...base];
  let turnStart = 0;

  const promoteTurn = (start: number, end: number) => {
    let lastToolIndex = -1;
    for (let index = end - 1; index >= start; index -= 1) {
      if (base[index].kind === "tool") {
        lastToolIndex = index;
        break;
      }
    }
    if (lastToolIndex <= start) return;

    for (let index = start; index < lastToolIndex; index += 1) {
      const item = base[index];
      if (
        item.kind !== "thinking" ||
        item.streaming ||
        !originalThinkingIds.has(item.id)
      ) {
        continue;
      }
      const cleaned = cleanAntigravityMilestoneText(item.text);
      if (!cleaned) continue;
      const length = countCodePointsUpTo(cleaned, ANTIGRAVITY_MILESTONE_MAX_CHARS);
      if (
        length > ANTIGRAVITY_MILESTONE_MIN_CHARS &&
        length <= ANTIGRAVITY_MILESTONE_MAX_CHARS
      ) {
        promoted[index] = thinkingAsAssistant(item, cleaned);
      }
    }
  };

  for (let index = 1; index < base.length; index += 1) {
    if (base[index].kind !== "user") continue;
    promoteTurn(turnStart, index);
    turnStart = index;
  }
  promoteTurn(turnStart, base.length);
  return promoted;
}

/**
 * Antigravity CLI transcript experience.
 *
 * Groups reasoning traces and tool calls into collapsible activity clusters
 * while pinning substantive mid-turn milestones and framing final answers cleanly.
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
  const transcriptItems = useMemo(
    () => antigravityTranscriptItems(items, status === "working"),
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
  for (let index = transcriptItems.length - 1; index >= 0; index -= 1) {
    if (transcriptItems[index]?.kind === "user") {
      latestUserIndex = index;
      break;
    }
  }
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  let latestLiveContent: (typeof transcriptItems)[number] | undefined;
  for (let index = transcriptItems.length - 1; index > latestUserIndex; index -= 1) {
    const item = transcriptItems[index];
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
    <div className="agent-experience antigravity-experience">
      <div className="official-transcript">
        {transcriptItems.map((item) => {
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
