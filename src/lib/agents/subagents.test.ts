import { describe, expect, test } from "bun:test";

import type { AgentItem, ToolItem } from "./types";
import {
  absorbedSubagentCallIds,
  isAbsorbedSubagentTool,
  rosterAnchorItemIds,
  rosterForAnchor,
  runningSubagentCount,
  subagentComposerCopy,
  subagentElapsedLabel,
  subagentFleetIsComplete,
  subagentFleetStatusLabel,
  subagentPeekTools,
  subagentPinLabel,
  subagentPinShouldShow,
  subagentPresenceNeeded,
  subagentRosterNodeInView,
  subagentResultLine,
  subagentRoleMark,
  subagentRosters,
  subagentStatusCounts,
  subagentsForTurn,
  subagentStatusLabel,
  visibleRosterRows,
  ROSTER_COLLAPSE_AFTER,
} from "./subagents";

function task(
  callId: string,
  status: ToolItem["status"],
  overrides: Partial<ToolItem> = {},
): ToolItem {
  return {
    kind: "tool",
    id: `tool-${callId}`,
    at: 2_000,
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
      task("four", "error"),
    ]);

    expect(runningSubagentCount(subagents)).toBe(2);
    expect(subagentStatusCounts(subagents)).toEqual({
      running: 1,
      pending: 1,
      done: 1,
      error: 1,
    });
    expect(subagentFleetStatusLabel(subagents)).toBe(
      "1 running · 1 queued · 1 completed · 1 failed",
    );
    expect(subagentStatusLabel("error")).toBe("Failed");
  });

  test("keeps the current fleet visible across same-turn steering", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user-1", at: 1, text: "Inspect in parallel" },
      task("running-before-steer", "running"),
      task("completed-before-steer", "done"),
      {
        kind: "user",
        id: "steer-1",
        at: 4,
        text: "Also check the Windows path",
        sameTurn: true,
      },
      task("started-after-steer", "pending"),
    ];

    expect(subagentsForTurn(items).map((subagent) => subagent.callId)).toEqual([
      "running-before-steer",
      "completed-before-steer",
      "started-after-steer",
    ]);
  });
});

describe("subagent rosters and timeline absorption", () => {
  const items: AgentItem[] = [
    { kind: "user", id: "user-1", at: 1, text: "First task" },
    task("old-explore", "done", { id: "tool-old-explore" }),
    task("old-tests", "done", { id: "tool-old-tests" }),
    { kind: "assistant", id: "answer-1", at: 3, text: "Done", streaming: false },
    { kind: "user", id: "user-2", at: 4, text: "Second task" },
    task("research", "running", { id: "tool-research" }),
    task("layout", "pending", { id: "tool-layout" }),
  ];

  test("keeps a completed previous-turn roster as its own transcript object", () => {
    const rosters = subagentRosters(items);
    expect(rosters).toHaveLength(2);
    expect(rosters[0]?.anchorItemId).toBe("tool-old-explore");
    expect(rosters[0]?.subagents.map((subagent) => subagent.callId)).toEqual([
      "old-explore",
      "old-tests",
    ]);
    expect(rosters[1]?.anchorItemId).toBe("tool-research");
    expect(rosters[1]?.subagents.map((subagent) => subagent.callId)).toEqual([
      "research",
      "layout",
    ]);
    expect(subagentsForTurn(items).map((subagent) => subagent.callId)).toEqual([
      "research",
      "layout",
    ]);
  });

  test("absorbs every roster task so the parent timeline does not also render cards", () => {
    const rosters = subagentRosters(items);
    const absorbed = absorbedSubagentCallIds(rosters);
    const anchors = rosterAnchorItemIds(rosters);

    expect([...absorbed]).toEqual([
      "old-explore",
      "old-tests",
      "research",
      "layout",
    ]);
    expect([...anchors]).toEqual(["tool-old-explore", "tool-research"]);
    expect(rosterForAnchor(rosters, "tool-research")?.subagents).toHaveLength(2);
    expect(isAbsorbedSubagentTool(items[5]!, absorbed)).toBe(true);
    expect(
      isAbsorbedSubagentTool(
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
        absorbed,
      ),
    ).toBe(false);
  });
});

describe("subagent pin and transcript lifetime", () => {
  test("treats a completed idle roster as a transcript object rather than TTL-retiring it", () => {
    const user: AgentItem = {
      kind: "user",
      id: "user",
      at: 1,
      text: "Inspect",
    };
    const completedItems: AgentItem[] = [
      user,
      task("one", "done"),
      task("two", "error"),
    ];
    const completed = subagentsForTurn(completedItems);

    expect(subagentFleetIsComplete(completed, "idle")).toBe(true);
    expect(subagentPresenceNeeded(completed, "idle")).toBe(false);
    expect(subagentRosters(completedItems)).toHaveLength(1);
    expect(subagentRosters(completedItems)[0]?.subagents).toHaveLength(2);
  });

  test("hides the pin when the roster is in view and shows a single line when it is not", () => {
    const running = subagentsForTurn([
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      task("one", "running", {
        subagent: { label: "Explore parser", activity: "Reading claude.ts" },
      }),
      task("two", "done"),
    ]);
    const completed = running.map((subagent) => ({
      ...subagent,
      status: "done" as const,
    }));

    expect(subagentPinShouldShow(true, running, "working")).toBe(false);
    expect(subagentPinShouldShow(false, running, "working")).toBe(true);
    expect(subagentPinShouldShow(false, completed, "working")).toBe(true);
    expect(subagentPinShouldShow(false, completed, "idle")).toBe(false);
    expect(subagentPinLabel(running)).toBe(
      "1 running · Explore parser · Reading claude.ts",
    );
  });

  test("treats a missing roster node as off-screen so the pin can still show", () => {
    const running = subagentsForTurn([
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      task("one", "running"),
    ]);

    expect(subagentRosterNodeInView(null, true)).toBe(false);
    expect(subagentRosterNodeInView(null, false)).toBe(false);
    expect(
      subagentPinShouldShow(subagentRosterNodeInView(null, true), running, "working"),
    ).toBe(true);
  });
});

describe("peek and focus fields", () => {
  test("builds marks, elapsed, result lines, and nested previews from live summaries", () => {
    const [explore, review] = subagentsForTurn([
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      task("explore", "running", {
        at: 1_000,
        subagent: {
          label: "Explore parser",
          role: "Explore",
          activity: "Reading adapters/claude.ts",
          prompt: "Find the fixture that breaks the parser.",
          items: [
            {
              kind: "tool",
              id: "nested-read",
              at: 1_100,
              callId: "nested-read",
              name: "Read",
              tool: "read",
              title: "Read adapter fixtures",
              status: "done",
              command: null,
              output: "",
              changes: [],
            },
            {
              kind: "assistant",
              id: "nested-note",
              at: 1_200,
              text: "The legacy fixture is the likely failure.",
              streaming: false,
            },
          ],
        },
      }),
      task("review", "done", {
        output: "Selector coverage passed. Nested cases still look clean.",
        subagent: { label: "Review selector tests", role: "Test reviewer" },
      }),
    ]);

    expect(subagentRoleMark(explore!)).toBe("E");
    expect(subagentElapsedLabel(1_000, 25_000, "running")).toBe("24s");
    expect(subagentElapsedLabel(1_000, 25_000, "done")).toBe(null);
    expect(subagentResultLine(explore!)).toBe("Reading adapters/claude.ts");
    expect(subagentResultLine(review!)).toBe("Selector coverage passed.");
    expect(subagentPeekTools(explore!).map((item) => item.title)).toEqual([
      "Read adapter fixtures",
    ]);
  });

  test("retargets the parent composer only when the child accepts prompts", () => {
    expect(subagentComposerCopy("Inspect parser tests", true)).toEqual({
      placeholder: "Ask a follow-up or redirect this subagent...",
      ariaLabel: "Message Inspect parser tests",
      disabled: false,
    });
    expect(subagentComposerCopy("Check narrow layout", false)).toEqual({
      placeholder: "This subagent only reports a summary",
      ariaLabel: "This subagent only reports a summary",
      disabled: true,
    });
  });

  test("groups extra completed workers once a roster grows past the glance cap", () => {
    const subagents = subagentsForTurn([
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      ...Array.from({ length: ROSTER_COLLAPSE_AFTER + 2 }, (_, index) =>
        task(`done-${index}`, "done"),
      ),
      task("live", "running"),
    ]);

    const visible = visibleRosterRows(subagents);
    expect(visible.rows.some((row) => row.callId === "live")).toBe(true);
    expect(visible.hiddenCompleted).toBeGreaterThan(0);
    expect(visible.rows.length + visible.hiddenCompleted).toBe(subagents.length);
  });
});
