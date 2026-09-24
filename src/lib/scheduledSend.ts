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
}

/** A local time to submit the terminal's current draft. */
export interface TimedSend {
  at: number;
}

export type SubmitDelivery = "default" | "alternate";
