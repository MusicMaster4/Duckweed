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


describe("subagent projection reuse", () => {
  test("does not reread settled output while a parent response streams", () => {
    const user: AgentItem = { kind: "user", id: "cache-user", at: 1, text: "Inspect" };
    const child = task("cache-child", "done");
    let outputReads = 0;
    Object.defineProperty(child, "output", {
      get() {
        outputReads += 1;
        return "Completed inspection\n".repeat(500);
      },
    });
    const items: AgentItem[] = [user, child];
    const fleet = subagentsForTurn(items);
    const rosters = subagentRosters(items);
    const readsAfterProjection = outputReads;
    for (let index = 0; index < 25; index += 1) {
      const streamed: AgentItem[] = [...items, {
        kind: "assistant", id: "cache-answer", at: 3,
        text: `Progress ${index}`, streaming: true,
      }];
      expect(subagentsForTurn(streamed)).toBe(fleet);
      expect(subagentRosters(streamed)).toBe(rosters);
      expect(rosters[0].subagents[0]).toBe(fleet[0]);
    }
    expect(outputReads).toBe(readsAfterProjection);
    expect(fleet[0].activity).toBe("Completed inspection");
  });

  test("invalidates only the worker and roster whose immutable item changes", () => {
    const user: AgentItem = { kind: "user", id: "cache-update-user", at: 1, text: "Inspect" };
    const one = task("cache-one", "done", { output: "Old result" });
    const two = task("cache-two", "running", { output: "Reading fixtures" });
    const items: AgentItem[] = [user, one, two];
    const fleet = subagentsForTurn(items);
    const rosters = subagentRosters(items);
    const updated: AgentItem[] = [user, one, {
      ...two, status: "done", output: "Reviewed all fixtures",
      subagent: { threadId: "updated-thread", label: "Fixture review" },
    }];
    const nextFleet = subagentsForTurn(updated);
    const nextRosters = subagentRosters(updated);
    expect(nextFleet).not.toBe(fleet);
    expect(nextFleet[0]).toBe(fleet[0]);
    expect(nextFleet[1]).not.toBe(fleet[1]);
    expect(nextFleet[1]).toMatchObject({
      status: "done", activity: "Reviewed all fixtures",
      threadId: "updated-thread", label: "Fixture review",
    });
    expect(nextRosters).not.toBe(rosters);
    expect(nextRosters[0].subagents[0]).toBe(rosters[0].subagents[0]);
    expect(nextRosters[0].subagents[1]).toBe(nextFleet[1]);
    expect(subagentsForTurn(items)[1]).toBe(fleet[1]);
  });

  test("keeps historical rosters stable and removes workers without stale cache entries", () => {
    const oldUser: AgentItem = { kind: "user", id: "cache-old-user", at: 1, text: "First" };
    const liveUser: AgentItem = { kind: "user", id: "cache-live-user", at: 2, text: "Second" };
    const old = task("cache-old", "done");
    const live = task("cache-live", "running");
    const items: AgentItem[] = [oldUser, old, liveUser, live];
    const rosters = subagentRosters(items);
    const updated = [oldUser, old, liveUser, { ...live, output: "Current result" }];
    const next = subagentRosters(updated);
    expect(next[0]).toBe(rosters[0]);
    expect(next[1]).not.toBe(rosters[1]);
    const removed = [oldUser, old, liveUser];
    expect(subagentsForTurn(removed)).toEqual([]);
    expect(subagentRosters(removed)).toEqual([rosters[0]]);
    expect(subagentRosters(items)).toEqual(rosters);
    expect(subagentsForTurn([liveUser])).toBe(subagentsForTurn([]));
    expect(subagentRosters([liveUser])).toBe(subagentRosters([]));
  });
});
