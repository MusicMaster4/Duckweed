import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { subagentsForTurn } from "../../../lib/agents/subagents";
import type { AgentItem } from "../../../lib/agents/types";
import { scrollFleetWithWheel, SubagentFleet } from "./SubagentFleet";
import { SubagentInspector } from "./SubagentInspector";

const items: AgentItem[] = [
  { kind: "user", id: "user", at: 1, text: "Inspect in parallel" },
  {
    kind: "tool",
    id: "task-parser",
    at: 2,
    callId: "task-parser",
    name: "Agent",
    tool: "task",
    title: "Inspect parser tests",
    status: "running",
    command: null,
    output: "Reading parser fixtures",
    changes: [],
    subagent: {
      label: "Inspect parser tests",
      role: "Explore",
      threadId: "child-parser",
      model: "haiku",
      prompt: "Find the fixture that breaks the parser.",
      activity: "Comparing parser fixtures",
      items: [
        {
          kind: "assistant",
          id: "child-update",
          at: 2,
          text: "The legacy fixture is the likely failure.",
          streaming: false,
        },
        {
          kind: "tool",
          id: "nested-task",
          at: 3,
          callId: "nested-task",
          name: "task",
          tool: "task",
          title: "Inspect nested dependency",
          status: "done",
          command: "bun test nested",
          output: "Nested dependency passed",
          changes: [],
        },
      ],
    },
  },
  {
    kind: "tool",
    id: "task-layout",
    at: 3,
    callId: "task-layout",
    name: "task",
    tool: "task",
    title: "Check narrow layout",
    status: "done",
    command: null,
    output: "Half-width layout passed",
    changes: [],
  },
];

describe("subagent UI", () => {
  test("turns a vertical wheel step into bounded horizontal fleet scrolling", () => {
    const list = { clientWidth: 300, scrollLeft: 20, scrollWidth: 800 };

    expect(scrollFleetWithWheel(list, 120)).toBe(true);
    expect(list.scrollLeft).toBe(140);
    expect(scrollFleetWithWheel(list, 1_000)).toBe(true);
    expect(list.scrollLeft).toBe(500);
    expect(scrollFleetWithWheel(list, 120)).toBe(false);
  });

  test("renders an accessible fleet with live activity and selection", () => {
    const subagents = subagentsForTurn(items);
    const html = renderToStaticMarkup(
      <SubagentFleet
        agent="claude"
        subagents={subagents}
        selectedCallId="task-parser"
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Subagents"');
    expect(html).toContain("<strong>Subagents</strong>");
    expect(html).not.toContain("<strong>Fleet</strong>");
    expect(html).toContain("1 running · 1 completed");
    expect(html).toContain("Inspect parser tests");
    expect(html).toContain("Comparing parser fixtures");
    expect(html).toContain(">Running</span>");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Completed: Check narrow layout");
  });

  test("renders prompt, identity, output, and timeline action in the inspector", () => {
    const subagent = subagentsForTurn(items)[0];
    const html = renderToStaticMarkup(
      <SubagentInspector
        agent="claude"
        subagent={subagent}
        canMessage={false}
        onMessage={async () => false}
        onClose={() => {}}
        onShowInTimeline={() => {}}
      />,
    );

    expect(html).toContain("Subagent inspector: Inspect parser tests");
    expect(html).toContain("<dt>Role</dt>");
    expect(html).toContain("Explore");
    expect(html).toContain("Find the fixture that breaks the parser.");
    expect(html).toContain("Reading parser fixtures");
    expect(html).toContain("Conversation");
    expect(html).toContain("The legacy fixture is the likely failure.");
    expect(html).toContain("Inspect nested dependency");
    expect(html).toContain(
      'aria-label="Toggle subagent details: Inspect nested dependency"',
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("only reports a summary");
    expect(html).toContain("Copy summary");
    expect(html).toContain("Show in timeline");
  });
});
