import { formatWorkDuration } from "../agentWorkDuration";
import type {
  AgentFileChange,
  AgentItem,
  AgentSessionState,
  SubagentMeta,
  ToolItem,
  ToolStatus,
} from "./types";

export interface SubagentSummary {
  id: string;
  callId: string;
  label: string;
  role: string | null;
  model: string | null;
  threadId: string | null;
  parentCallId: string | null;
  prompt: string | null;
  activity: string;
  status: ToolStatus;
  output: string;
  changes: AgentFileChange[];
  items: AgentItem[];
  startedAt: number;
  item: ToolItem;
}

export interface SubagentRoster {
  /** Timeline item id of the first task in this turn. The board renders here. */
  anchorItemId: string;
  subagents: SubagentSummary[];
}

export interface SubagentStatusCounts {
  pending: number;
  running: number;
  done: number;
  error: number;
}

export interface VisibleRosterRows {
  rows: SubagentSummary[];
  hiddenCompleted: number;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  pending: "Queued",
  running: "Running",
  done: "Completed",
  error: "Failed",
};

/** Collapse extra completed workers once a roster grows past this many rows. */
export const ROSTER_COLLAPSE_AFTER = 6;

export function subagentStatusLabel(status: ToolStatus): string {
  return STATUS_LABEL[status];
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function lastOutputLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

function compact(text: string, limit = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function firstSentence(text: string, limit = 120): string {
  const line = text.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? "";
  const sentence = line.split(/(?<=[.!?])\s+/)[0] ?? line;
  return compact(sentence, limit);
}

function summaryFor(item: ToolItem): SubagentSummary {
  const meta: SubagentMeta = item.subagent ?? {};
  const role = clean(meta.role);
  const prompt = clean(meta.prompt);
  const label = clean(meta.label) ?? role ?? prompt ?? clean(item.title) ?? "Subagent";
  const activity =
    clean(meta.activity) ??
    lastOutputLine(item.output) ??
    (item.status === "pending"
      ? "Waiting to start"
      : item.status === "running"
        ? "Starting…"
        : item.status === "error"
          ? "Delegated work failed"
          : "Delegated work completed");

  return {
    id: clean(meta.threadId) ?? item.callId,
    callId: item.callId,
    label: compact(label, 80),
    role,
    model: clean(meta.model),
    threadId: clean(meta.threadId),
    parentCallId: clean(meta.parentCallId),
    prompt,
    activity: compact(activity),
    status: item.status,
    output: item.output,
    changes: item.changes,
    items: meta.items ?? [],
    startedAt: item.at,
    item,
  };
}

function currentTurnStart(items: AgentItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "user" && !item.sameTurn) return index;
  }
  return -1;
}

/**
 * Delegated work belonging to the latest user turn.
 *
 * Completed children remain visible until the next user message. Historical
 * task rows stay on their turn's transcript roster instead of crowding the
 * live pin.
 */
export function subagentsForTurn(items: AgentItem[]): SubagentSummary[] {
  const turnStart = currentTurnStart(items);

  return items
    .filter(
      (item, index): item is ToolItem =>
        item.kind === "tool" &&
        item.tool === "task" &&
        (index > turnStart || item.status === "running" || item.status === "pending"),
    )
    .map(summaryFor);
}

/**
 * One roster per user turn that spawned delegated work. Each roster stays a
 * transcript object after the children finish; it is never TTL-retired.
 */
export function subagentRosters(items: AgentItem[]): SubagentRoster[] {
  const ranges: Array<{ start: number; end: number }> = [];
  let turnStart = 0;
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "user" && !item.sameTurn) {
      ranges.push({ start: turnStart, end: index });
      turnStart = index;
    }
  }
  ranges.push({ start: turnStart, end: items.length });

  const rosters: SubagentRoster[] = [];
  for (const range of ranges) {
    const tasks: ToolItem[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      const item = items[index];
      if (item.kind === "tool" && item.tool === "task") tasks.push(item);
    }
    if (!tasks.length) continue;
    rosters.push({
      anchorItemId: tasks[0].id,
      subagents: tasks.map(summaryFor),
    });
  }
  return rosters;
}

export function absorbedSubagentCallIds(rosters: SubagentRoster[]): Set<string> {
  const ids = new Set<string>();
  for (const roster of rosters) {
    for (const subagent of roster.subagents) ids.add(subagent.callId);
  }
  return ids;
}

export function rosterAnchorItemIds(rosters: SubagentRoster[]): Set<string> {
  return new Set(rosters.map((roster) => roster.anchorItemId));
}

export function rosterForAnchor(
  rosters: SubagentRoster[],
  itemId: string,
): SubagentRoster | null {
  return rosters.find((roster) => roster.anchorItemId === itemId) ?? null;
}

export function isAbsorbedSubagentTool(
  item: AgentItem,
  absorbedCallIds: Set<string>,
): item is ToolItem {
  return item.kind === "tool" && item.tool === "task" && absorbedCallIds.has(item.callId);
}

export function subagentForCallId(
  items: AgentItem[],
  callId: string,
): SubagentSummary | null {
  const item = items.find(
    (candidate): candidate is ToolItem =>
      candidate.kind === "tool" &&
      candidate.tool === "task" &&
      candidate.callId === callId,
  );
  return item ? summaryFor(item) : null;
}

export function runningSubagentCount(subagents: SubagentSummary[]): number {
  return subagents.reduce(
    (count, subagent) =>
      count + (subagent.status === "running" || subagent.status === "pending" ? 1 : 0),
    0,
  );
}

export function subagentStatusCounts(
  subagents: SubagentSummary[],
): SubagentStatusCounts {
  const counts: SubagentStatusCounts = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
  };
  for (const subagent of subagents) counts[subagent.status] += 1;
  return counts;
}

/** A compact, truthful summary for the roster header. */
export function subagentFleetStatusLabel(
  subagents: SubagentSummary[],
): string {
  const counts = subagentStatusCounts(subagents);
  return [
    counts.running ? `${counts.running} running` : "",
    counts.pending ? `${counts.pending} queued` : "",
    counts.done ? `${counts.done} completed` : "",
    counts.error ? `${counts.error} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Presence (the one-line pin) is only needed while children are still working
 * or the parent is still synthesizing. The transcript roster itself stays.
 */
export function subagentPresenceNeeded(
  subagents: SubagentSummary[],
  status: AgentSessionState["status"] | undefined,
): boolean {
  if (subagents.length === 0) return false;
  if (status === "working" || status === "waiting") return true;
  return subagents.some(
    (subagent) => subagent.status === "running" || subagent.status === "pending",
  );
}

export function subagentPinShouldShow(
  rosterInView: boolean,
  subagents: SubagentSummary[],
  status: AgentSessionState["status"] | undefined,
): boolean {
  return !rosterInView && subagentPresenceNeeded(subagents, status);
}

/**
 * A roster that is not mounted is not in view. Callers must not treat a
 * missing DOM node as visible, or the pin hides while workers vanish.
 */
export function subagentRosterNodeInView(
  node: Element | null,
  intersecting: boolean,
): boolean {
  return node !== null && intersecting;
}

export function subagentPinLabel(subagents: SubagentSummary[]): string {
  const live =
    subagents.find((subagent) => subagent.status === "running") ??
    subagents.find((subagent) => subagent.status === "pending") ??
    subagents[0];
  const counts = subagentStatusCounts(subagents);
  const head = [
    counts.running ? `${counts.running} running` : "",
    counts.pending && !counts.running ? `${counts.pending} queued` : "",
    !counts.running && !counts.pending && counts.error
      ? `${counts.error} failed`
      : "",
    !counts.running && !counts.pending && !counts.error && counts.done
      ? `${counts.done} completed`
      : "",
  ].filter(Boolean)[0];
  if (!live) return head ?? "";
  if (!head) return `${live.label} · ${live.activity}`;
  return `${head} · ${live.label} · ${live.activity}`;
}

export function subagentRoleMark(subagent: SubagentSummary): string {
  const source = subagent.role ?? subagent.label;
  const character = Array.from(source)[0];
  return character ? character.toUpperCase() : "S";
}

export function subagentElapsedLabel(
  startedAt: number,
  now: number,
  status: ToolStatus,
): string | null {
  if (status !== "running" && status !== "pending") return null;
  return formatWorkDuration(Math.max(0, now - startedAt));
}

/** Glance row copy: live activity while working, first result sentence when done. */
export function subagentResultLine(subagent: SubagentSummary): string {
  if (subagent.status === "running" || subagent.status === "pending") {
    return subagent.activity;
  }
  const source = subagent.output.trim() || subagent.activity;
  return firstSentence(source);
}

export function subagentPeekTools(subagent: SubagentSummary): ToolItem[] {
  return subagent.items
    .filter((item): item is ToolItem => item.kind === "tool")
    .slice(-3);
}

export function visibleRosterRows(subagents: SubagentSummary[]): VisibleRosterRows {
  if (subagents.length <= ROSTER_COLLAPSE_AFTER) {
    return { rows: subagents, hiddenCompleted: 0 };
  }
  const active = subagents.filter(
    (subagent) => subagent.status !== "done",
  );
  const done = subagents.filter((subagent) => subagent.status === "done");
  const room = Math.max(0, ROSTER_COLLAPSE_AFTER - active.length);
  const shownDone = done.slice(0, room);
  return {
    rows: [...active, ...shownDone],
    hiddenCompleted: done.length - shownDone.length,
  };
}

/**
 * True when every child is terminal and the parent is idle. Used only to hide
 * the off-screen pin, never to remove the transcript roster.
 */
export function subagentComposerCopy(
  label: string,
  canMessage: boolean,
): { placeholder: string; ariaLabel: string; disabled: boolean } {
  if (canMessage) {
    return {
      placeholder: "Ask a follow-up or redirect this subagent...",
      ariaLabel: `Message ${label}`,
      disabled: false,
    };
  }
  return {
    placeholder: "This subagent only reports a summary",
    ariaLabel: "This subagent only reports a summary",
    disabled: true,
  };
}

export function subagentFleetIsComplete(
  subagents: SubagentSummary[],
  status: AgentSessionState["status"] | undefined,
): boolean {
  return (
    subagents.length > 0 &&
    status === "idle" &&
    subagents.every(
      (subagent) => subagent.status === "done" || subagent.status === "error",
    )
  );
}
