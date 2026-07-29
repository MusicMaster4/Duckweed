import { describe, expect, test } from "bun:test";

import type { AgentItem, ToolItem } from "./types";
import {
  COMPLETED_SUBAGENT_FLEET_TTL_MS,
  runningSubagentCount,
  subagentFleetIsComplete,
  subagentsForTurn,
  subagentStatusLabel,
} from "./subagents";

function task(
  callId: string,
  status: ToolItem["status"],
  overrides: Partial<ToolItem> = {},
): ToolItem {
  return {
    kind: "tool",
    id: `tool-${callId}`,
    at: 2,
    callId,
    name: "task",
    tool: "task",
    title: `Task ${callId}`,
    status,
    command: null,
    output: "",
    changes: [],
    ...overrides,
  };
}

describe("subagentsForTurn", () => {
  test("isolates parallel children to the latest user turn", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user-1", at: 1, text: "First task" },
      task("old", "done"),
      { kind: "assistant", id: "answer-1", at: 3, text: "Done", streaming: false },
      { kind: "user", id: "user-2", at: 4, text: "Second task" },
      task("research", "running"),
      task("tests", "pending"),
      {
        kind: "tool",
        id: "read-1",
        at: 7,
        callId: "read-1",
        name: "read",
        tool: "read",
        title: "Read source",
        status: "done",
        command: null,
        output: "",
        changes: [],
      },
    ];

    expect(subagentsForTurn(items).map((subagent) => subagent.callId)).toEqual([
      "research",
      "tests",
    ]);
  });

  test("prefers structured identity and activity with useful L1 fallbacks", () => {
    const [structured, flat] = subagentsForTurn([
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      task("structured", "running", {
        title: "Spawned subagent: Inspect parser tests",
        output: "Thread: child-1\nReading fixtures",
        subagent: {
          label: "Inspect parser tests",
          role: "Explore",
          threadId: "child-1",
          model: "gpt-5.6-sol",
          prompt: "Find the failing parser case",
          activity: "Comparing parser fixtures",
        },
      }),
      task("flat", "done", {
        title: "Review compatibility",
        output: "Checked the adapters\nNo incompatibilities found",
      }),
    ]);

    expect(structured).toMatchObject({
      id: "child-1",
      label: "Inspect parser tests",
      role: "Explore",
      activity: "Comparing parser fixtures",
      prompt: "Find the failing parser case",
    });
    expect(flat).toMatchObject({
      id: "flat",
      label: "Review compatibility",
      activity: "No incompatibilities found",
    });
  });

  test("reports fleet status and active count in product language", () => {
    const subagents = subagentsForTurn([
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      task("one", "running"),
      task("two", "pending"),
      task("three", "done"),
    ]);

    expect(runningSubagentCount(subagents)).toBe(2);
    expect(subagentStatusLabel("error")).toBe("Failed");
  });

  test("keeps unfinished children visible across same-turn steering", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user-1", at: 1, text: "Inspect in parallel" },
      task("running-before-steer", "running"),
      task("completed-before-steer", "done"),
      {
        kind: "user",
        id: "steer-1",
        at: 4,
        text: "Also check the Windows path",
      },
      task("started-after-steer", "pending"),
    ];

    expect(subagentsForTurn(items).map((subagent) => subagent.callId)).toEqual([
      "running-before-steer",
      "started-after-steer",
    ]);
  });
});

describe("subagent fleet lifecycle", () => {
  test("retires only after every child is terminal and the parent is idle", () => {
    const user: AgentItem = {
      kind: "user",
      id: "user",
      at: 1,
      text: "Inspect",
    };
    const running = subagentsForTurn([
      user,
      task("one", "running"),
      task("two", "done"),
    ]);
    const completed = subagentsForTurn([
      user,
      task("one", "done"),
      task("two", "error"),
    ]);

    expect(subagentFleetIsComplete(running, "idle")).toBe(false);
    expect(subagentFleetIsComplete(completed, "working")).toBe(false);
    expect(subagentFleetIsComplete(completed, "idle")).toBe(true);
    expect(COMPLETED_SUBAGENT_FLEET_TTL_MS).toBe(30_000);
  });
});
