import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  AgentId,
  AgentItem,
  AgentSessionState,
  PlanItem,
} from "../../../lib/agents/types";
import { AgentProviderIcon } from "../AgentProviderIcon";
import { CursorExperience } from "../provider/CursorExperience";
import { OpenCodeExperience } from "../provider/OpenCodeExperience";
import { ChatGPTExperience } from "./ChatGPTExperience";
import { ClaudeExperience } from "./ClaudeExperience";
import { GrokDotMatrix, GrokExperience } from "./GrokExperience";
import {
  PREPARING_MESSAGES,
  resetPreparingMessageAssignmentsForTests,
  setFunnyThinkingLabelRandomForTests,
} from "./preparingMessages";
import {
  activeAssistantId,
  activityGroups,
  AssistantMarkdown,
  continuedAssistantIds,
  PlanTracker,
  ProviderEmpty,
  shortAssistantUpdatesAsThinking,
} from "./OfficialShared";

function activitySession(agent: AgentId, items: AgentItem[]): AgentSessionState {
  return {
    termId: `${agent}-latest-activity`,
    agent,
    program: agent,
    label:
      agent === "codex"
        ? "Codex"
        : agent === "claude"
          ? "Claude Code"
          : agent === "grok"
            ? "Grok Build"
            : agent === "cursor"
              ? "Cursor Agent"
              : "OpenCode",
    mark: agent.slice(0, 2).toUpperCase(),
    accent: "#7ea6ff",
    status: "working",
    cwd: "H:\\project",
    model: null,
    effort: null,
    models: [],
    sessionId: null,
    items,
    pending: [],
    permission: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null, contextUsed: null },
    error: null,
    commands: [],
    started: true,
  };
}

function renderAgentActivity(agent: AgentId, items: AgentItem[]): string {
  const session = activitySession(agent, items);
  const props = {
    items,
    termId: session.termId,
    agent,
    status: session.status,
    started: session.started,
    label: session.label,
    mark: session.mark,
    program: session.program,
    cwd: session.cwd,
  };

  switch (agent) {
    case "codex":
      return renderToStaticMarkup(<ChatGPTExperience {...props} />);
    case "claude":
      return renderToStaticMarkup(<ClaudeExperience {...props} />);
    case "grok":
      return renderToStaticMarkup(<GrokExperience {...props} />);
    case "cursor":
      return renderToStaticMarkup(<CursorExperience session={session} items={items} />);
    case "opencode":
      return renderToStaticMarkup(<OpenCodeExperience session={session} items={items} />);
  }
}

describe("official agent presentation", () => {
  beforeEach(() => {
    resetPreparingMessageAssignmentsForTests();
    // Pin the rare Thinking-label swap off so presentation tests stay stable.
    setFunnyThinkingLabelRandomForTests(() => 1);
  });

  afterEach(() => {
    resetPreparingMessageAssignmentsForTests();
  });

  test("uses an animated arrow only for the running workflow step", () => {
    const plan: PlanItem = {
      kind: "plan",
      id: "plan",
      at: 1,
      planType: "workflow",
      steps: [
        { text: "Completed task", status: "done" },
        { text: "Active task", status: "running" },
        { text: "Pending task", status: "pending" },
      ],
    };

    const html = renderToStaticMarkup(<PlanTracker item={plan} variant="codex" />);

    expect(html).toContain('class="official-plan-running-arrow"');
    expect(html).toContain(">Workflow</span>");
    expect(html).toContain('aria-current="step"');
    expect(html.match(/official-plan-running-arrow/g)?.length).toBe(1);
    expect(html).toContain("✓");
  });

  test("labels ordinary plans as tasks", () => {
    const plan: PlanItem = {
      kind: "plan",
      id: "tasks",
      at: 1,
      planType: "tasks",
      steps: [{ text: "Inspect the code", status: "running" }],
    };

    const html = renderToStaticMarkup(<PlanTracker item={plan} variant="codex" />);

    expect(html).toContain('aria-label="Tasks progress"');
    expect(html).toContain(">Tasks</span>");
    expect(html).not.toContain(">Workflow</span>");
  });

  test("offers a persistent copy action for user messages in every custom UI", () => {
    const prompt: AgentItem = {
      kind: "user",
      id: "prompt",
      at: 1,
      text: "Copy this exact message",
    };

    for (const agent of ["codex", "claude", "grok", "cursor", "opencode"] as const) {
      const html = renderAgentActivity(agent, [prompt]);
      expect(html).toContain('aria-label="Copy message"');
      expect(html).toContain("Copy this exact message");
    }
  });

  test("keeps the OpenCode copy control outside the user bubble", () => {
    const prompt: AgentItem = {
      kind: "user",
      id: "prompt",
      at: 1,
      text: "Copy this exact message",
    };
    const html = renderAgentActivity("opencode", [prompt]);

    expect(html).toContain('class="oc-user-turn"');
    expect(html).toContain('class="oc-user-bubble"');
    // Bubble closes before the actions row; the icon must not paint inside it.
    expect(html).toMatch(
      /oc-user-bubble[\s\S]*?Copy this exact message[\s\S]*?<\/div>\s*<div class="agent-message-actions"/,
    );
    const bubble = html.match(
      /class="oc-user-bubble"[^>]*>([\s\S]*?)<\/div>\s*<div class="agent-message-actions"/,
    );
    expect(bubble?.[1] ?? "").not.toContain('aria-label="Copy message"');
  });

  test("keeps official copy controls outside the user bubble", () => {
    const prompt: AgentItem = {
      kind: "user",
      id: "prompt",
      at: 1,
      text: "Copy this exact message",
    };

    for (const agent of ["codex", "claude", "grok"] as const) {
      const html = renderAgentActivity(agent, [prompt]);
      expect(html).toContain('class="official-user-turn');
      expect(html).toMatch(
        /official-user official-user--[\w]+[\s\S]*?Copy this exact message[\s\S]*?<\/article>\s*<div class="agent-message-actions"/,
      );
    }
  });

  test("renders agent markdown as structure instead of literal markers", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={"### Core idea\nThis is **important**.\n\n- first\n- second\n\n`bun test`"}
      />,
    );

    expect(html).toContain("<h3>Core idea</h3>");
    expect(html).toContain("<strong>important</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>bun test</code>");
    expect(html).not.toContain("### Core idea");
    expect(html).not.toContain("**important**");
  });

  test("preserves ordered-list numbering across descriptions between items", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={[
          "1. First feature",
          "Description of the first feature.",
          "",
          "2. Second feature",
          "Description of the second feature.",
          "",
          "3. Third feature",
          "Description of the third feature.",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<ol><li>First feature</li></ol>");
    expect(html).toContain('<ol start="2"><li>Second feature</li></ol>');
    expect(html).toContain('<ol start="3"><li>Third feature</li></ol>');
  });

  test("renders Markdown tables with inline formatting and alignment", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={[
          "Priority matrix",
          "",
          "| # | Improvement | Impact | Risk if ignored |",
          "|---:|:------------|:------:|-----------------|",
          "| 1 | **Virtualize** streams | High | Jank on long sessions |",
          "| 2 | `Shared UI` | Medium | Forever-N skins |",
        ].join("\n")}
      />,
    );

    expect(html).toContain('class="official-markdown-table-wrap"');
    expect(html).toContain("<table>");
    expect(html).toContain('<th style="text-align:right">#</th>');
    expect(html).toContain('<th style="text-align:center">Impact</th>');
    expect(html).toContain("<strong>Virtualize</strong> streams");
    expect(html).toContain("<code>Shared UI</code>");
    expect(html).not.toContain("|---:|");
  });

  test("supports tables without outer pipes and pipes inside inline code", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={"Command | Result\n--- | ---\n`foo | bar` | Passed\nA \\| B | Kept together"}
      />,
    );

    expect(html).toContain('<th style="text-align:left">Command</th>');
    expect(html).toContain("<code>foo | bar</code>");
    expect(html).toContain('<td style="text-align:left">Passed</td>');
    expect(html).toContain('<td style="text-align:left">A | B</td>');
  });

  test("escapes HTML supplied by an agent", () => {
    const html = renderToStaticMarkup(<AssistantMarkdown text={'<script>alert("x")</script>'} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("renders Markdown and bare http links as external links", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={
          "Open [the docs](https://example.com/docs) or visit https://example.com/billing."
        }
      />,
    );

    expect(html).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noreferrer">the docs</a>',
    );
    expect(html).toContain(
      '<a href="https://example.com/billing" target="_blank" rel="noreferrer">https://example.com/billing</a>.',
    );
  });

  test("settles the Grok matrix with every point dimmed", () => {
    const html = renderToStaticMarkup(<GrokDotMatrix active={false} />);
    expect(html).toContain("is-settled");
    expect(html).toContain('cx="12" cy="12" r="1.6" opacity="0.2"');
    expect(html).not.toContain('opacity="1"');
    expect(html).not.toContain("<animate");
  });

  test("keeps Grok progress comments between their activity phases", () => {
    const fullThought =
      "I should inspect the package metadata, then compare the entry points before answering. " +
      "This final sentence must remain available when the completed thought is expanded.";
    const html = renderToStaticMarkup(
      <GrokExperience
        agent="grok"
        label="Grok Build"
        mark="GR"
        program="grok"
        cwd="H:\\project"
        started
        status="idle"
        items={[
          { kind: "user", id: "u1", at: 1_000, text: "Explain this repo" },
          { kind: "thinking", id: "t1", at: 2_000, text: fullThought, streaming: false },
          {
            kind: "assistant",
            id: "progress-1",
            at: 3_000,
            text: "I will inspect the metadata now.",
            streaming: false,
          },
          {
            kind: "tool",
            id: "tool-1",
            at: 4_000,
            callId: "call-1",
            name: "Read",
            tool: "read",
            title: "Read package metadata",
            status: "done",
            command: null,
            output: "",
            changes: [],
          },
          {
            kind: "thinking",
            id: "t2",
            at: 5_000,
            text: "Now I should inspect the frontend entry point.",
            streaming: false,
          },
          {
            kind: "tool",
            id: "tool-2",
            at: 6_000,
            callId: "call-2",
            name: "Read",
            tool: "read",
            title: "Read frontend entry",
            status: "done",
            command: null,
            output: "",
            changes: [],
          },
          {
            kind: "assistant",
            id: "a1",
            at: 7_000,
            text: "### Report\nIt is **Duckweed**.",
            streaming: false,
          },
        ]}
      />,
    );

    expect(html.match(/agent-activity-cluster/g)?.length).toBe(1);
    expect(html.match(/agent-activity-pulse/g)?.length).toBe(1);
    expect(html.match(/>Thinking</g)?.length).toBe(1);
    expect(html).toContain("2 tool calls");
    expect(html).toContain("Now I should inspect the frontend entry point.");
    expect(html).toContain("Read frontend entry");
    expect(html).not.toContain("Read package metadata");
    expect(html).toContain("I will inspect the metadata now.");
    expect(html).toContain("is-interim-update");
    expect(html).not.toContain("This final sentence must remain available");
    expect(html).toContain("<h3>Report</h3>");
    expect(html).toContain("<strong>Duckweed</strong>");
    expect(html.indexOf("I will inspect the metadata now.")).toBeLessThan(
      html.indexOf("Now I should inspect the frontend entry point."),
    );
  });

  for (const agent of ["codex", "claude", "grok", "cursor", "opencode"] as const) {
    test(`${agent} always shows the full latest thinking trace and latest tool call`, () => {
      const items: AgentItem[] = [
        { kind: "user", id: "u1", at: 1, text: "Inspect the project" },
        {
          kind: "thinking",
          id: "thinking-old",
          at: 2,
          text: "OLD_THINKING_TRACE",
          streaming: false,
        },
        {
          kind: "tool",
          id: "tool-old",
          at: 3,
          callId: "call-old",
          name: "Read",
          tool: "read",
          title: "OLD_TOOL_CALL",
          status: "done",
          command: null,
          output: "",
          changes: [],
        },
        {
          kind: "thinking",
          id: "thinking-latest",
          at: 4,
          text: "LATEST THINKING FIRST LINE\n\nLATEST THINKING FINAL LINE",
          streaming: true,
        },
        {
          kind: "tool",
          id: "tool-latest",
          at: 5,
          callId: "call-latest",
          name: "Search",
          tool: "search",
          title: "LATEST_TOOL_CALL",
          status: "running",
          command: null,
          output: "",
          changes: [],
        },
      ];
      const html = renderAgentActivity(agent, items);

      expect(html.match(/agent-activity-history is-thinking/g)).toHaveLength(1);
      expect(html.match(/agent-activity-history is-tools/g)).toHaveLength(1);
      expect(html).toContain("LATEST THINKING FIRST LINE");
      expect(html).toContain("LATEST THINKING FINAL LINE");
      expect(html).toContain("LATEST_TOOL_CALL");
      expect(html).not.toContain("OLD_THINKING_TRACE");
      expect(html).not.toContain("OLD_TOOL_CALL");
      expect(html).not.toContain("2 traces");
      expect(html).toContain("2 tool calls");
      expect(html).toContain("official-chevron");
    });
  }

  for (const agent of ["codex", "claude", "grok", "cursor", "opencode"] as const) {
    test(`${agent} preserves an interim comment and moves fresh activity below it`, () => {
      const items: AgentItem[] = [
        { kind: "user", id: "user", at: 1, text: "Inspect" },
        {
          kind: "thinking",
          id: "thinking-before",
          at: 2,
          text: "Reviewing the entry point",
          streaming: false,
        },
        {
          kind: "assistant",
          id: "interim",
          at: 3,
          text: "I found the entry point. I am checking the callers now.",
          streaming: true,
        },
        {
          kind: "thinking",
          id: "thinking-after",
          at: 4,
          text: "Checking every caller in full",
          streaming: false,
        },
        {
          kind: "tool",
          id: "tool-after",
          at: 5,
          callId: "call-after",
          name: "Search",
          tool: "search",
          title: "Find entry point callers",
          status: "running",
          command: null,
          output: "",
          changes: [],
        },
      ];
      const html = renderAgentActivity(agent, items);

      expect(html).not.toContain("Reviewing the entry point");
      expect(html.match(/agent-activity-cluster/g)).toHaveLength(1);
      if (agent === "codex" || agent === "claude") {
        expect(html).not.toContain("I found the entry point. I am checking the callers now.");
        expect(html).not.toContain("is-interim-update");
        expect(html).toContain("Checking every caller in full");
        expect(html).toContain("agent-thinking-latest");
      } else {
        expect(html).toContain("I found the entry point. I am checking the callers now.");
        expect(html).toContain("is-interim-update");
        expect(html.indexOf("I found the entry point. I am checking the callers now.")).toBeLessThan(
          html.indexOf("Checking every caller in full"),
        );
      }
      if (agent === "cursor") {
        expect(html).toContain("cx-prose is-interim-update");
      } else if (agent === "opencode") {
        expect(html).toContain("oc-prose is-interim-update");
      } else {
        expect(html).not.toContain("official-stream-caret");
      }
    });
  }

  for (const agent of ["codex", "claude", "grok", "cursor", "opencode"] as const) {
    test(`${agent} replaces the old activity area as soon as a live comment arrives`, () => {
      const html = renderAgentActivity(agent, [
        { kind: "user", id: "user", at: 1, text: "Inspect" },
        {
          kind: "thinking",
          id: "thinking-before-comment",
          at: 2,
          text: "THIS_OLD_ACTIVITY_MUST_MOVE_OUT",
          streaming: false,
        },
        {
          kind: "assistant",
          id: "live-comment",
          at: 3,
          text: "I found the boundary. I am continuing below this update.",
          streaming: true,
        },
      ]);

      expect(html).toContain("I found the boundary. I am continuing below this update.");
      expect(html).not.toContain("THIS_OLD_ACTIVITY_MUST_MOVE_OUT");
      if (agent === "codex" || agent === "claude") {
        expect(html).not.toContain("is-interim-update");
        expect(html).toContain("agent-activity-cluster");
        expect(html).toContain("agent-thinking-latest");
      } else {
        expect(html).toContain("is-interim-update");
        expect(html).not.toContain("agent-activity-cluster");
      }
    });
  }

  test("keeps the thinking animation active through running and completed tool calls", () => {
    for (const toolStatus of ["running", "done"] as const) {
      const html = renderAgentActivity("claude", [
        { kind: "user", id: "user", at: 1, text: "Inspect" },
        {
          kind: "thinking",
          id: "completed-thinking",
          at: 2,
          text: "I will inspect the package metadata.",
          streaming: false,
        },
        {
          kind: "tool",
          id: `tool-${toolStatus}`,
          at: 3,
          callId: `call-${toolStatus}`,
          name: "Read",
          tool: "read",
          title: "Read package metadata",
          status: toolStatus,
          command: null,
          output: "",
          changes: [],
        },
      ]);

      expect(html).toContain("agent-activity-pulse is-active");
      expect(html).not.toContain("agent-activity-pulse is-settled");
    }
  });

  /**
   * Tab switches remount the custom UI. The thinking matrix is keyed by cluster
   * id, so a remount during the same wait must keep the same pattern instead of
   * drawing a new animation.
   */
  test("keeps the thinking matrix pattern across remounts of the same wait", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user-remount", at: 1, text: "Keep the matrix" },
      {
        kind: "thinking",
        id: "thinking-remount",
        at: 2,
        text: "Still working.",
        streaming: true,
      },
    ];

    const first = renderAgentActivity("claude", items);
    const second = renderAgentActivity("claude", items);
    const pattern = first.match(/data-pattern="([^"]+)"/)?.[1];

    expect(pattern).toBeTruthy();
    expect(second).toContain(`data-pattern="${pattern}"`);
  });

  /**
   * An interim agent message closes one activity phase and opens another under
   * it. That second matrix must roll a new pattern even though it is still the
   * same user turn — only tab remounts should freeze the draw.
   */
  test("draws a new thinking matrix after an interim agent message", () => {
    const phaseOne: AgentItem[] = [
      { kind: "user", id: "user-phase", at: 1, text: "Inspect" },
      {
        kind: "thinking",
        id: "thinking-before-interim",
        at: 2,
        text: "Planning the search carefully before I write anything.",
        streaming: false,
      },
    ];
    const phaseTwo: AgentItem[] = [
      ...phaseOne,
      {
        kind: "assistant",
        id: "interim-phase",
        at: 3,
        text: "I found the entry point and I will keep checking every caller next.",
        streaming: false,
      },
      {
        kind: "thinking",
        id: "thinking-after-interim",
        at: 4,
        text: "Checking callers now thoroughly after that update.",
        streaming: true,
      },
      {
        kind: "tool",
        id: "tool-after-interim",
        at: 5,
        callId: "call-after-interim",
        name: "Search",
        tool: "search",
        title: "Find entry point callers",
        status: "running",
        command: null,
        output: "",
        changes: [],
      },
    ];

    // Grok keeps interim comments as assistant messages, so activity reappears
    // as a fresh cluster under the comment — that is the case that must re-roll.
    const before = renderAgentActivity("grok", phaseOne);
    const after = renderAgentActivity("grok", phaseTwo);
    const firstPattern = before.match(/data-pattern="([^"]+)"/)?.[1];
    const secondPattern = after.match(/data-pattern="([^"]+)"/)?.[1];

    expect(firstPattern).toBeTruthy();
    expect(secondPattern).toBeTruthy();
    expect(secondPattern).not.toBe(firstPattern);

    // Remounting the second phase still has to keep the second pattern.
    const remounted = renderAgentActivity("grok", phaseTwo);
    expect(remounted).toContain(`data-pattern="${secondPattern}"`);
  });

  test("keeps Grok planning prose visible when work continues", () => {
    const html = renderAgentActivity("grok", [
        { kind: "user", id: "u1", at: 1, text: "Inspect" },
        { kind: "thinking", id: "t1", at: 2, text: "Planning", streaming: false },
        {
          kind: "assistant",
          id: "progress",
          at: 3,
          text: "I will inspect the repository now.",
          streaming: true,
        },
        {
          kind: "tool",
          id: "tool-after-comment",
          at: 4,
          callId: "call-after-comment",
          name: "Read",
          tool: "read",
          title: "Read repository",
          status: "running",
          command: null,
          output: "",
          changes: [],
        },
      ]);
    expect(html).toContain("I will inspect the repository now.");
    expect(html).toContain("is-interim-update");
    expect(html.indexOf("I will inspect the repository now.")).toBeLessThan(
      html.indexOf("Read repository"),
    );
  });

  test("does not label prose as the Grok answer while its latest tool is running", () => {
    const html = renderToStaticMarkup(
      <GrokExperience
        agent="grok"
        label="Grok Build"
        mark="GR"
        program="grok"
        cwd="H:\\project"
        started
        status="working"
        items={[
          { kind: "user", id: "u1", at: 1, text: "Inspect" },
          { kind: "thinking", id: "t1", at: 2, text: "Planning", streaming: false },
          {
            kind: "tool",
            id: "tool-1",
            at: 3,
            callId: "call-1",
            name: "Read",
            tool: "read",
            title: "Read package metadata",
            status: "running",
            command: null,
            output: "",
            changes: [],
          },
          {
            kind: "assistant",
            id: "progress",
            at: 4,
            text: "This is still progress narration.",
            streaming: true,
          },
        ]}
      />,
    );
    expect(html).toContain("This is still progress narration.");
    expect(html).not.toContain("grok-answer-layer");
  });

  for (const agent of ["codex", "claude", "grok"] as const) {
    test(`${agent} gives a completed answer the shared hairline`, () => {
      const session = activitySession(agent, [
        { kind: "user", id: "u1", at: 1, text: "Inspect" },
        {
          kind: "tool",
          id: "tool-1",
          at: 2,
          callId: "call-1",
          name: "Read",
          tool: "read",
          title: "Read package metadata",
          status: "done",
          command: null,
          output: "",
          changes: [],
        },
        { kind: "assistant", id: "answer-1", at: 3, text: "Done.", streaming: false },
      ]);
      session.status = "idle";
      const props = {
        items: session.items,
        termId: session.termId,
        agent,
        status: session.status,
        started: session.started,
        label: session.label,
        mark: session.mark,
        program: session.program,
        cwd: session.cwd,
      };
      const html =
        agent === "codex"
          ? renderToStaticMarkup(<ChatGPTExperience {...props} />)
          : agent === "claude"
            ? renderToStaticMarkup(<ClaudeExperience {...props} />)
            : renderToStaticMarkup(<GrokExperience {...props} />);

      expect(html).toContain("official-answer-layer");
      expect(html).toContain("official-answer-divider");
      expect(html).toContain(">Answer<");
    });
  }

  test("uses provider artwork instead of the old letter badge", () => {
    const html = renderToStaticMarkup(<AgentProviderIcon agent="codex" />);
    expect(html).toContain("<svg");
    expect(html).not.toContain(">CX<");
  });

  test("collapses completed Claude activity to its latest trace and tool call", () => {
    const html = renderToStaticMarkup(
      <ClaudeExperience
        agent="claude"
        label="Claude Code"
        mark="CC"
        program="claude"
        cwd="H:\\project"
        started
        status="idle"
        items={[
          { kind: "thinking", id: "t1", at: 1, text: "Inspecting", streaming: false },
          {
            kind: "tool",
            id: "tool-1",
            at: 2,
            callId: "call-1",
            name: "Bash",
            tool: "execute",
            title: "Read package metadata",
            status: "done",
            command: "Get-Content package.json",
            output: "",
            changes: [],
          },
          {
            kind: "tool",
            id: "tool-2",
            at: 3,
            callId: "call-2",
            name: "Bash",
            tool: "execute",
            title: "Run tests",
            status: "done",
            command: "bun test",
            output: "",
            changes: [],
          },
          { kind: "assistant", id: "a1", at: 4, text: "Done.", streaming: false },
        ]}
      />,
    );
    expect(html).toContain("agent-activity-cluster");
    expect(html).toContain("2 tool calls");
    expect(html).toContain(">Thinking<");
    expect(html).not.toContain("Read package metadata");
    expect(html).toContain("Run tests");
    expect(html).not.toContain("Get-Content package.json");
  });

  test("keeps activity grouped within its own user turn", () => {
    const groups = activityGroups([
      { kind: "user", id: "u1", at: 1, text: "first" },
      { kind: "thinking", id: "think-1", at: 2, text: "one", streaming: false },
      {
        kind: "tool",
        id: "tool-1",
        at: 3,
        callId: "call-1",
        name: "Read",
        tool: "read",
        title: "First command",
        status: "done",
        command: null,
        output: "",
        changes: [],
      },
      { kind: "assistant", id: "answer-1", at: 4, text: "first answer", streaming: false },
      { kind: "user", id: "u2", at: 5, text: "second" },
      {
        kind: "tool",
        id: "tool-2",
        at: 6,
        callId: "call-2",
        name: "Read",
        tool: "read",
        title: "Second command",
        status: "done",
        command: null,
        output: "",
        changes: [],
      },
      { kind: "assistant", id: "answer-2", at: 7, text: "second answer", streaming: false },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].activities.map((item) => item.id)).toEqual(["think-1", "tool-1"]);
    expect(groups[0].answerId).toBe("answer-1");
    expect(groups[1].activities.map((item) => item.id)).toEqual(["tool-2"]);
    expect(groups[1].answerId).toBe("answer-2");
  });

  test("starts fresh activity below an interim assistant comment", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      { kind: "thinking", id: "thinking-1", at: 2, text: "First phase", streaming: false },
      {
        kind: "assistant",
        id: "comment",
        at: 3,
        text: "I found the entry point. I am checking its callers now.",
        streaming: true,
      },
      {
        kind: "tool",
        id: "tool-2",
        at: 4,
        callId: "call-2",
        name: "Search",
        tool: "search",
        title: "Find callers",
        status: "running",
        command: null,
        output: "",
        changes: [],
      },
    ];

    const groups = activityGroups(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].activities.map((item) => item.id)).toEqual(["thinking-1"]);
    expect(groups[0].replacedByCommentId).toBe("comment");
    expect(groups[1].activities.map((item) => item.id)).toEqual(["tool-2"]);
    expect(continuedAssistantIds(items).has("comment")).toBe(true);
    expect(activeAssistantId(items, true)).toBe(null);
  });

  test("turns short running assistant updates into thinking and keeps longer responses", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      { kind: "assistant", id: "short", at: 2, text: "a".repeat(250), streaming: false },
      { kind: "assistant", id: "long", at: 3, text: "b".repeat(251), streaming: true },
    ];

    const presented = shortAssistantUpdatesAsThinking(items, true, 250);

    expect(presented[1]).toMatchObject({ id: "short", kind: "thinking" });
    expect(presented[2]).toMatchObject({ id: "long", kind: "assistant" });
  });

  test("keeps transformed historical updates stable across streaming renders", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      { kind: "assistant", id: "update", at: 2, text: "Checking files", streaming: false },
      { kind: "assistant", id: "live", at: 3, text: "Working", streaming: true },
    ];

    const first = shortAssistantUpdatesAsThinking(items, true, 250);
    const second = shortAssistantUpdatesAsThinking(items, true, 250);

    expect(first[1]).toBe(second[1]);
    expect(first[1]).not.toBe(items[1]);
  });

  test("keeps the character limit based on Unicode code points", () => {
    const withinLimit: AgentItem[] = [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      { kind: "assistant", id: "emoji", at: 2, text: "🦆🦆", streaming: true },
    ];
    const overLimit: AgentItem[] = [
      withinLimit[0],
      { kind: "assistant", id: "emoji-long", at: 3, text: "🦆🦆🦆", streaming: true },
    ];

    expect(shortAssistantUpdatesAsThinking(withinLimit, true, 2)[1].kind).toBe("thinking");
    expect(shortAssistantUpdatesAsThinking(overLimit, true, 2)[1].kind).toBe("assistant");
  });

  test("shows a varied waiting message after a long Codex update until fresh activity arrives", () => {
    const interimItems: AgentItem[] = [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      {
        kind: "thinking",
        id: "thinking-before-update",
        at: 2,
        text: "Reviewing the existing documentation.",
        streaming: false,
      },
      {
        kind: "assistant",
        id: "long-update",
        at: 3,
        text: `I found the relevant section and I am continuing with the remaining checks. ${"x".repeat(240)}`,
        streaming: false,
      },
    ];

    const waitingHtml = renderAgentActivity("codex", interimItems);
    const waitingMessage = PREPARING_MESSAGES.find((message) =>
      waitingHtml.includes(`>${message}<`),
    );

    expect(waitingHtml).toContain("I found the relevant section");
    expect(waitingHtml).toContain("agent-still-working");
    expect(waitingMessage).toBeDefined();
    expect(waitingHtml).toContain("agent-activity-pulse is-active");
    expect(waitingHtml).not.toContain("Reviewing the existing documentation.");

    const resumedHtml = renderAgentActivity("codex", [
      ...interimItems,
      {
        kind: "thinking",
        id: "thinking-after-update",
        at: 4,
        text: "Checking the remaining references.",
        streaming: true,
      },
      {
        kind: "tool",
        id: "tool-after-update",
        at: 5,
        callId: "call-after-update",
        name: "Search",
        tool: "search",
        title: "Find remaining references",
        status: "running",
        command: null,
        output: "",
        changes: [],
      },
    ]);

    expect(resumedHtml).not.toContain("agent-still-working");
    expect(resumedHtml).not.toContain(`>${waitingMessage}<`);
    expect(resumedHtml).toContain("Checking the remaining references.");
    expect(resumedHtml).toContain("Find remaining references");
  });

  test("rarely swaps the live Thinking label for a stand-in line while working", () => {
    setFunnyThinkingLabelRandomForTests(() => 0);

    const html = renderAgentActivity("codex", [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      {
        kind: "thinking",
        id: "thinking-live",
        at: 2,
        text: "Looking through the current files.",
        streaming: true,
      },
    ]);

    const funnyLabel = PREPARING_MESSAGES.find((message) =>
      html.includes(`>${message}<`),
    );
    expect(funnyLabel).toBeDefined();
    expect(html).not.toContain(">Thinking<");
    expect(html).toContain("Looking through the current files.");
  });

  test("keeps a completed turn's final response even when it is short", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "user", at: 1, text: "Inspect" },
      { kind: "assistant", id: "update", at: 2, text: "Checking.", streaming: false },
      { kind: "assistant", id: "final", at: 3, text: "Done.", streaming: false },
    ];

    const presented = shortAssistantUpdatesAsThinking(items, false, 250);

    expect(presented[1]).toMatchObject({ id: "update", kind: "thinking" });
    expect(presented[2]).toMatchObject({ id: "final", kind: "assistant" });
  });

  test("uses provider-specific limits for Codex and Claude Code", () => {
    // Codex keeps short updates as thinking up to 300 chars; Claude promotes
    // anything above 110 chars to a normal assistant message.
    const codexHtml = renderAgentActivity("codex", [
      { kind: "user", id: "codex-user", at: 1, text: "Inspect" },
      {
        kind: "assistant",
        id: "codex-update",
        at: 2,
        text: "c".repeat(275),
        streaming: true,
      },
    ]);
    const claudeHtml = renderAgentActivity("claude", [
      { kind: "user", id: "claude-user", at: 1, text: "Inspect" },
      {
        kind: "assistant",
        id: "claude-update",
        at: 2,
        text: "c".repeat(275),
        streaming: true,
      },
    ]);

    expect(codexHtml).toContain("agent-thinking-latest");
    expect(codexHtml).not.toContain("official-answer official-answer--chatgpt");
    expect(claudeHtml).toContain("official-answer official-answer--claude");
    expect(claudeHtml).not.toContain("agent-thinking-latest");
  });

  test("uses a single provider mark plus an ASCII startup animation", () => {
    const html = renderToStaticMarkup(
      <ProviderEmpty
        agent="codex"
        termId="pane-empty-state"
        label="Codex"
        program="codex"
        cwd="H:\\project"
        status="starting"
      />,
    );
    expect(html.match(/agent-provider-icon/g)).toHaveLength(1);
    expect(html).toContain("agent-ascii-loader");
    expect(html).toContain("Starting session");
  });

  test("uses the shared centered startup state for OpenCode", () => {
    const session: AgentSessionState = {
      termId: "opencode-empty-state",
      agent: "opencode",
      program: "opencode",
      label: "OpenCode",
      mark: "OC",
      accent: "#7be05a",
      status: "starting",
      cwd: "H:\\project",
      model: null,
      effort: null,
      models: [],
      sessionId: null,
      goal: null,
      items: [],
      pending: [],
      permission: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null, contextUsed: null },
      error: null,
      commands: [],
      started: false,
    };
    const html = renderToStaticMarkup(<OpenCodeExperience session={session} items={[]} />);

    expect(html).toContain("official-empty");
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("oc-open");
  });

  test("keeps a new Codex prompt in its final transcript position", () => {
    const html = renderAgentActivity("codex", [
      { kind: "user", id: "prompt", at: 1, text: "Inspect the project" },
    ]);

    expect(html).toContain("Inspect the project");
    expect(html).not.toContain("is-prompt-docked");
    expect(html).toContain("agent-activity-cluster");
  });
});
