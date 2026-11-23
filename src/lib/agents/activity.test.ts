import { describe, expect, test } from "bun:test";

import { agentHasUnfinishedWork } from "./activity";

describe("agent close activity", () => {
  test("warns while an agent turn is unfinished", () => {
    expect(agentHasUnfinishedWork("starting")).toBe(true);
    expect(agentHasUnfinishedWork("working")).toBe(true);
    expect(agentHasUnfinishedWork("waiting")).toBe(true);
  });

  test("does not warn after the agent has finished working", () => {
    expect(agentHasUnfinishedWork("idle")).toBe(false);
    expect(agentHasUnfinishedWork("exited")).toBe(false);
    expect(agentHasUnfinishedWork("error")).toBe(false);
  });

  test("treats active subagents as unfinished work even when the parent is idle", () => {
    const runningTask = {
      kind: "tool" as const,
      id: "t-1",
      at: 1,
      callId: "c-1",
      name: "Agent",
      tool: "task" as const,
      title: "Research",
      status: "running" as const,
      command: null,
      output: "",
      changes: [],
    };
    const pendingTask = { ...runningTask, id: "t-2", callId: "c-2", status: "pending" as const };
    const unavailableTask = {
      ...runningTask,
      id: "t-3",
      callId: "c-3",
      subagent: { statusUnavailable: true },
    };
    const doneTask = { ...runningTask, id: "t-4", callId: "c-4", status: "done" as const };

    expect(agentHasUnfinishedWork("idle", [runningTask])).toBe(true);
    expect(agentHasUnfinishedWork("idle", [pendingTask])).toBe(true);
    expect(agentHasUnfinishedWork("idle", [unavailableTask])).toBe(false);
    expect(agentHasUnfinishedWork("idle", [doneTask])).toBe(false);
    expect(agentHasUnfinishedWork("exited", [runningTask])).toBe(false);
    expect(agentHasUnfinishedWork("error", [runningTask])).toBe(false);
  });
});
