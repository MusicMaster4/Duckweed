import { describe, expect, test } from "bun:test";

import type { AgentItem, PlanItem } from "../../lib/agents/types";
import {
  COMPLETED_WORKFLOW_TTL_MS,
  latestWorkflow,
  workflowIsComplete,
} from "../../lib/agentWorkflow";

const completedPlan: PlanItem = {
  kind: "plan",
  id: "plan-current",
  at: 2,
  title: "Implementation",
  steps: [
    { text: "Inspect", status: "done" },
    { text: "Implement", status: "done" },
  ],
};

describe("agent workflow dock", () => {
  test("tracks only a plan in the current user turn", () => {
    const previousTurn: AgentItem[] = [
      { kind: "user", id: "user-1", at: 1, text: "First task" },
      completedPlan,
      { kind: "assistant", id: "answer-1", at: 3, text: "Done", streaming: false },
      { kind: "user", id: "user-2", at: 4, text: "Second task" },
    ];

    expect(latestWorkflow(previousTurn)).toBe(null);
    expect(latestWorkflow([...previousTurn, { ...completedPlan, id: "plan-2", at: 5 }])?.id).toBe(
      "plan-2",
    );
  });

  test("starts the expiry window only after every task is done and the agent is idle", () => {
    expect(workflowIsComplete(completedPlan, "idle")).toBe(true);
    expect(workflowIsComplete(completedPlan, "working")).toBe(false);
    expect(
      workflowIsComplete(
        {
          ...completedPlan,
          steps: [
            { text: "Inspect", status: "done" },
            { text: "Implement", status: "running" },
          ],
        },
        "idle",
      ),
    ).toBe(false);
    expect(COMPLETED_WORKFLOW_TTL_MS).toBe(30_000);
  });
});
