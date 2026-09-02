import type { AgentId, AgentSessionState } from "./agents/types";

export interface AgentCompletionDetails {
  agent: AgentId;
  label: string;
  response: string | null;
  needsAttention: boolean;
  durationMs: number | null;
}

export const MOBILE_COMPLETION_DELAY_MS = 30_000;
export const SELECTED_TERMINAL_IDLE_MS = 60_000;

export interface DelayedMobileCompletionState {
  /** Whether the completion created a visible unread mark on desktop. */
  unreadAtCompletion: boolean;
  /** Whether that mark still exists when the grace period ends. */
  unreadNow: boolean;
  /** Last interaction anywhere in the desktop app, including hover movement. */
  lastInteractionAt: number | null;
  /** Time when this completion was observed by the desktop. */
  completedAt: number;
}

export function mobileCompletionDelay(unreadAtCompletion: boolean): number {
  return unreadAtCompletion ? MOBILE_COMPLETION_DELAY_MS : SELECTED_TERMINAL_IDLE_MS;
}

/**
 * A mobile alert is useful only if the desktop stayed completely unattended
 * for the whole grace period. Background completions must also keep their
 * unread mark; selected terminals have no mark, so inactivity alone decides.
 */
export function shouldSendDelayedMobileCompletion(
  state: DelayedMobileCompletionState,
): boolean {
  if (
    state.lastInteractionAt !== null &&
    state.lastInteractionAt >= state.completedAt
  ) return false;
  if (state.unreadAtCompletion) return state.unreadNow;
  return true;
}

/** Select the final settled prose from the newest user turn for mobile history. */
export function completionDetailsFromState(
  state: AgentSessionState,
): AgentCompletionDetails {
  let userAt = -1;
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    if (state.items[index].kind === "user") {
      userAt = index;
      break;
    }
  }

  let response: string | null = null;
  for (let index = state.items.length - 1; index > userAt; index -= 1) {
    const item = state.items[index];
    if (item.kind !== "assistant") continue;
    const settled = item.text.trim();
    if (!settled) continue;
    response = settled;
    break;
  }

  return {
    agent: state.agent,
    label: state.label,
    response,
    needsAttention: state.status === "waiting",
    durationMs: state.lastWorkedForMs,
  };
}
