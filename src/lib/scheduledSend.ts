/** A working agent that can be selected as a completion trigger. */
export interface AgentTarget {
  termId: string;
  label: string;
  detail: string;
}

/** One pending message waiting for another terminal to finish its turn. */
export interface ScheduledSend {
  targetTermId: string;
  targetLabel: string;
  /** The target finished; delivery may still be waiting for the source to restore. */
  triggered?: boolean;
}

/** A local time to submit the terminal's current draft. */
export interface TimedSend {
  at: number;
}

export type SubmitDelivery = "default" | "alternate";

/** Keep overdue entries until their restored destination accepts the draft. */
export function deliverDueSends(
  sends: ReadonlyMap<string, TimedSend>,
  now: number,
  deliver: (termId: string) => boolean,
): Map<string, TimedSend> {
  const remaining = new Map(sends);
  for (const [termId, send] of sends) {
    if (send.at <= now && deliver(termId)) remaining.delete(termId);
  }
  return remaining;
}
