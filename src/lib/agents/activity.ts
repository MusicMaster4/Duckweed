import { hasActiveSubagents } from "./subagents";
import type { AgentItem, AgentStatus } from "./types";

/**
 * True while closing an agent would interrupt an unfinished turn or active
 * subagent work.
 *
 * An idle agent with no active subagents is still open, but it has handed
 * control back to the user, so closing it does not need a warning.
 */
export function agentHasUnfinishedWork(
  status: AgentStatus,
  items?: readonly AgentItem[],
): boolean {
  if (status === "starting" || status === "working" || status === "waiting") {
    return true;
  }
  return status === "idle" && hasActiveSubagents(items);
}
