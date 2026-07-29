import { describe, expect, test } from "bun:test";

import type { AgentItem, ToolItem } from "./types";
import {
  runningSubagentCount,
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
});
