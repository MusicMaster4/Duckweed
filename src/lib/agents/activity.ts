import type { AgentStatus } from "./types";

/**
 * True while closing an agent would interrupt an unfinished turn.
 *
 * An idle agent is still open, but it has already handed control back to the
 * user, so closing it does not need a warning.
 */
export function agentHasUnfinishedWork(status: AgentStatus): boolean {
  return status === "starting" || status === "working" || status === "waiting";
}
