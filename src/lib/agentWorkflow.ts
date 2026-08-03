import type { AgentItem, AgentSessionState, PlanItem } from "./agents/types";

export const COMPLETED_WORKFLOW_TTL_MS = 30_000;

/** The newest provider plan in the current user turn is the workflow dock. */
export function latestWorkflow(items: AgentItem[]): PlanItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "plan") return item;
    if (item.kind === "user" && !item.sameTurn) return null;
  }
  return null;
}

export function workflowIsComplete(
  workflow: PlanItem | null,
  status: AgentSessionState["status"] | undefined,
): boolean {
  if (!workflow || workflow.steps.length === 0 || status !== "idle") return false;
  return workflow.steps.every((step) => step.status === "done");
}
