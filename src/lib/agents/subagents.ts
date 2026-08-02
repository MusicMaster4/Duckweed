import type {
  AgentFileChange,
  AgentItem,
  AgentSessionState,
  SubagentMeta,
  ToolItem,
  ToolStatus,
} from "./types";

export const COMPLETED_SUBAGENT_FLEET_TTL_MS = 30_000;

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

export interface SubagentStatusCounts {
  pending: number;
  running: number;
  done: number;
  error: number;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  pending: "Queued",
  running: "Running",
  done: "Completed",
  error: "Failed",
};

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

/**
 * Delegated work belonging to the latest user turn.
 *
 * Completed children remain visible until the next user message. Historical
 * task rows stay in the transcript but do not crowd the active fleet.
 */
export function subagentsForTurn(items: AgentItem[]): SubagentSummary[] {
  let turnStart = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "user" && !item.sameTurn) {
      turnStart = index;
      break;
    }
  }

  return items
    .filter(
      (item, index): item is ToolItem =>
        item.kind === "tool" &&
        item.tool === "task" &&
        (index > turnStart || item.status === "running" || item.status === "pending"),
    )
    .map(summaryFor);
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

/** A compact, truthful summary for the fleet header. */
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
 * Keep completed children nearby while the parent is still synthesizing their
 * work. The fleet can retire once the whole turn is quiet; its task rows remain
 * available in the transcript.
 */
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
