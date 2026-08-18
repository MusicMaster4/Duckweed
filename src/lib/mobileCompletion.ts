import type { AgentId, AgentSessionState } from "./agents/types";

export interface AgentCompletionDetails {
  agent: AgentId;
  label: string;
  response: string | null;
  needsAttention: boolean;
  durationMs: number | null;
}

export const MOBILE_COMPLETION_DELAY_MS = 10_000;
export const SELECTED_TERMINAL_IDLE_MS = 60_000;

export interface DelayedMobileCompletionState {
  /** Whether the completion created a visible unread mark on desktop. */
  unreadAtCompletion: boolean;
  /** Whether that mark still exists when the grace period ends. */
  unreadNow: boolean;
  /** Last deliberate keyboard or pointer interaction in this terminal. */
  lastInteractionAt: number | null;
  now: number;
}

/**
 * Background completions notify only while their unread mark survives the
 * grace period. A completion in the already-selected terminal has no mark to
 * clear, so recent human interaction is the evidence that it was actually
 * seen rather than merely open on an unattended desktop.
 */
export function shouldSendDelayedMobileCompletion(
  state: DelayedMobileCompletionState,
): boolean {
  if (state.unreadAtCompletion) return state.unreadNow;
  if (state.lastInteractionAt === null) return true;
  return state.now - state.lastInteractionAt >= SELECTED_TERMINAL_IDLE_MS;
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
