import type { AgentId, AgentSessionState } from "./agents/types";

export interface AgentCompletionDetails {
  agent: AgentId;
  label: string;
  response: string | null;
  needsAttention: boolean;
  durationMs: number | null;
}

export const MOBILE_COMPLETION_DELAY_MS = 30_000;

export interface DelayedMobileCompletionState {
  /** Whether the completion created a visible unread mark on desktop. */
  unreadAtCompletion: boolean;
  /** Whether that mark still exists when the grace period ends. */
  unreadNow: boolean;
}

export function mobileCompletionDelay(): number {
  return MOBILE_COMPLETION_DELAY_MS;
}

/**
 * Completion notifications are reserved for work the user has not reviewed.
 * The desktop unread mark is the single source of truth: it must be created by
 * the completion and still be present when the grace period ends.
 */
export function shouldSendDelayedMobileCompletion(
  state: DelayedMobileCompletionState,
): boolean {
  return state.unreadAtCompletion && state.unreadNow;
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
