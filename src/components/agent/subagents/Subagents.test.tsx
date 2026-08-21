import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  subagentRosters,
  subagentsForTurn,
} from "../../../lib/agents/subagents";
import type { AgentItem } from "../../../lib/agents/types";
import { ClaudeExperience } from "../official/ClaudeExperience";
import { ActivityHistory } from "../official/OfficialShared";
import { SubagentBoard, SubagentPin } from "./SubagentBoard";
import { SubagentFocus } from "./SubagentFocus";
import { SubagentUiProvider } from "./SubagentUiContext";

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
  {
    kind: "tool",
    id: "read-source",
    at: 4,
    callId: "read-source",
    name: "Read",
    tool: "read",
    title: "Read session.ts",
    status: "done",
    command: null,
    output: "ok",
    changes: [],
  },
];

const rosters = subagentRosters(items);
const live = subagentsForTurn(items);

function wrap(
  node: ReactNode,
  overrides: {
    peekedCallId?: string | null;
    items?: AgentItem[];
  } = {},
) {
  const rosterItems = overrides.items ?? items;
  return (
    <SubagentUiProvider
      agent="claude"
      now={26_000}
      rosters={subagentRosters(rosterItems)}
      peekedCallId={overrides.peekedCallId ?? null}
      focusedCallId={null}
      onPeek={() => {}}
      onOpen={() => {}}
      onClosePeek={() => {}}
      onLeaveFocus={() => {}}
    >
      {node}
    </SubagentUiProvider>
  );
}

function claudeProps(nextItems: AgentItem[], status: "working" | "idle" = "working") {
  return {
    items: nextItems,
    termId: "claude-roster",
    agent: "claude" as const,
    status,
    started: true,
    label: "Claude Code",
    mark: "CC",
    program: "claude",
    cwd: ".",
  };
}

describe("subagent roster UI", () => {
  test("renders one roster of parallel workers with status and live activity", () => {
    const html = renderToStaticMarkup(
      <SubagentBoard
        agent="claude"
        roster={rosters[0]!}
        now={26_000}
        peekedCallId={null}
        onPeek={() => {}}
        onOpen={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Subagents"');
    expect(html).toContain("<strong>Subagents</strong>");
    expect(html).toContain("1 running · 1 completed");
    expect(html).toContain("Inspect parser tests");
    expect(html).toContain("Comparing parser fixtures");
    expect(html).toContain(">Running</span>");
    expect(html).toContain("Check narrow layout");
    expect(html).toContain("Half-width layout passed");
    expect(html).not.toContain("agent-sub-chip");
    expect(html).not.toContain("Show in timeline");
  });

  test("absorbs current-turn task cards so the timeline does not also render Subagent rows", () => {
    const activities = items.filter(
      (item): item is Extract<AgentItem, { kind: "tool" }> => item.kind === "tool",
    );
    const html = renderToStaticMarkup(
      wrap(
        <ActivityHistory
          activities={activities}
          variant="claude"
          clusterId="turn-1"
        />,
      ),
    );

    expect(html).toContain('aria-label="Subagents"');
    expect(html).toContain("Inspect parser tests");
    expect(html).toContain("Read session.ts");
    expect(html).not.toContain("official-tool-kicker");
    expect(html).not.toContain(">Subagent<");
  });

  test("keeps the roster when an interim comment hides the activity cluster", () => {
    const hiddenItems: AgentItem[] = [
      items[0]!,
      items[1]!,
      items[2]!,
      {
        kind: "assistant",
        id: "progress-1",
        at: 5,
        text:
          "I found the compatibility boundary and I am checking every streamed update before I finish. The adapters still need a second pass.",
        streaming: false,
      },
      {
        kind: "thinking",
        id: "thinking-later",
        at: 6,
        text: "Checking the remaining references.",
        streaming: true,
      },
    ];
    const html = renderToStaticMarkup(
      wrap(
        <ClaudeExperience {...claudeProps(hiddenItems)} />,
        { items: hiddenItems },
      ),
    );

    expect(html).toContain('aria-label="Subagents"');
    expect(html).toContain("Inspect parser tests");
    expect(html).toContain("Comparing parser fixtures");
    expect(html).toContain("I found the compatibility boundary");
    expect(html).not.toContain("official-tool-kicker");
    expect(html).not.toContain(">Subagent<");
  });

  test("keeps the roster when the live answer hides the current activity cluster", () => {
    const hiddenItems: AgentItem[] = [
      items[0]!,
      items[1]!,
      items[2]!,
      {
        kind: "assistant",
        id: "live-answer",
        at: 5,
        text:
          "I found the compatibility boundary and I am checking every streamed update before I finish. The adapters still need a second pass.",
        streaming: true,
      },
    ];
    const html = renderToStaticMarkup(
      wrap(
        <ClaudeExperience {...claudeProps(hiddenItems)} />,
        { items: hiddenItems },
      ),
    );

    expect(html).toContain('aria-label="Subagents"');
    expect(html).toContain("Inspect parser tests");
    expect(html).toContain("Check narrow layout");
    expect(html).toContain("I found the compatibility boundary");
    expect(html).not.toContain("official-tool-kicker");
  });

  test("peeks a compact inline summary without an overlay inspector", () => {
    const html = renderToStaticMarkup(
      <SubagentBoard
        agent="claude"
        roster={rosters[0]!}
        now={26_000}
        peekedCallId="task-parser"
        onPeek={() => {}}
        onOpen={() => {}}
      />,
    );

    expect(html).toContain("agent-sub-peek");
    expect(html).toContain("Find the fixture that breaks the parser.");
    expect(html).toContain("Inspect nested dependency");
    expect(html).toContain(">Open<");
    expect(html).not.toContain("Subagent inspector:");
    expect(html).not.toContain("Show in timeline");
    expect(html).not.toContain("Message this subagent");
  });
});

describe("subagent focus UI", () => {
  test("replaces the parent view with nested child content and a back control", () => {
    const html = renderToStaticMarkup(
      <SubagentFocus
        agent="claude"
        parentLabel="Claude Code"
        parentWorking
        subagent={live[0]!}
        now={26_000}
        onBack={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Back to parent"');
    expect(html).toContain("Claude Code");
    expect(html).toContain("Inspect parser tests");
    expect(html).toContain("The legacy fixture is the likely failure.");
    expect(html).toContain("Inspect nested dependency");
    expect(html).toContain("Parent still working");
    expect(html).not.toContain("Show in timeline");
    expect(html).not.toContain("Message this subagent");
    expect(html).not.toContain("only reports a summary");
  });

  test("says so honestly when the child has no nested transcript", () => {
    const html = renderToStaticMarkup(
      <SubagentFocus
        agent="claude"
        parentLabel="Claude Code"
        parentWorking={false}
        subagent={live[1]!}
        now={26_000}
        onBack={() => {}}
      />,
    );

    expect(html).toContain("This provider did not expose a child transcript.");
    expect(html).toContain("Half-width layout passed");
    expect(html).toContain('aria-label="Back to parent"');
  });
});

describe("subagent pin and composer retarget", () => {
  test("renders a single-line pin rather than a multi-chip fleet", () => {
    const html = renderToStaticMarkup(
      <SubagentPin agent="claude" subagents={live} onPeek={() => {}} />,
    );

    expect(html).toContain("agent-sub-pin");
    expect(html).toContain("1 running · Inspect parser tests · Comparing parser fixtures");
    expect(html).not.toContain("agent-sub-chip");
    expect(html).not.toContain("agent-sub-board-list");
  });

  test("wires the focused composer to the shared subagent copy helper", async () => {
    const source = await Bun.file(`${import.meta.dir}/../AgentComposer.tsx`).text();
    expect(source).toContain("subagentComposerCopy");
    expect(source).toContain("target.canMessage");
    expect(source).toContain("disabled");
  });

  test("mounts the roster in the agent surface instead of a fleet overlay", async () => {
    const surface = await Bun.file(`${import.meta.dir}/../AgentSurface.tsx`).text();
    expect(surface).toContain("SubagentPin");
    expect(surface).toContain("SubagentFocus");
    expect(surface).toContain("subagentPinShouldShow");
    expect(surface).toContain("subagentRosterNodeInView");
    expect(surface).not.toContain("SubagentFleet");
    expect(surface).not.toContain("SubagentInspector");
    expect(surface).not.toContain("Show in timeline");
    expect(surface).not.toContain("COMPLETED_SUBAGENT_FLEET_TTL_MS");
  });
});
