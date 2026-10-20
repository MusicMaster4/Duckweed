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

/** One independent message, or a legacy live draft, to submit at a local time. */
export interface TimedSend {
  at: number;
  id?: string;
  text?: string;
  images?: import("./agents/types").AgentImageAttachment[];
  source?: "terminal" | "custom";
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

/** Deliver in time order, retaining failures and blocking later sends to that terminal. */
export function deliverDueMessageQueues(
  queues: ReadonlyMap<string, TimedSend[]>,
  now: number,
  deliver: (termId: string, send: TimedSend) => boolean,
): Map<string, TimedSend[]> {
  const remaining = new Map(queues);
  for (const [termId, messages] of queues) {
    const ordered = [...messages].sort((a, b) => a.at - b.at);
    let delivered = 0;
    for (const send of ordered) {
      if (send.at > now || !deliver(termId, send)) break;
      delivered++;
    }
    if (!delivered) continue;
    const pending = ordered.slice(delivered);
    if (pending.length) remaining.set(termId, pending);
    else remaining.delete(termId);
  }
  return remaining;
}
