import { activeSubagentCount } from "./agents/subagents";
import type { AgentSessionState } from "./agents/types";

const STATUS_LABEL: Record<AgentSessionState["status"], string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  waiting: "Needs you",
  exited: "Ended",
  error: "Failed",
};

export function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return `${seconds}s`;

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 1) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes}m`;
}

export function workStatusLabel(
  session: Pick<
    AgentSessionState,
    "status" | "workStartedAt" | "lastWorkedForMs"
  > & { items?: AgentSessionState["items"] },
  now: number,
): string {
  if (session.status === "working" && session.workStartedAt !== null) {
    return `Working for ${formatWorkDuration(now - session.workStartedAt)}`;
  }
  if (session.status === "idle") {
    const activeSubagents = activeSubagentCount(session.items);
    if (activeSubagents > 0) {
      const label = `${activeSubagents} ${activeSubagents === 1 ? "subagent" : "subagents"} working`;
      return session.workStartedAt !== null
        ? `${label} · ${formatWorkDuration(now - session.workStartedAt)}`
        : label;
    }
    if (session.lastWorkedForMs !== null) {
      return `Worked for ${formatWorkDuration(session.lastWorkedForMs)}`;
    }
  }
  return STATUS_LABEL[session.status];
}
