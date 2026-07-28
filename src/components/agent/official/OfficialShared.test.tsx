import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentId, AgentItem, AgentSessionState } from "../../../lib/agents/types";
import { AgentProviderIcon } from "../AgentProviderIcon";
import { CursorExperience } from "../provider/CursorExperience";
import { OpenCodeExperience } from "../provider/OpenCodeExperience";
import { ChatGPTExperience, shouldDockCodexPrompt } from "./ChatGPTExperience";
import { ClaudeExperience } from "./ClaudeExperience";
import { GrokDotMatrix, GrokExperience } from "./GrokExperience";
import {
  activeAssistantId,
  activityGroups,
  AssistantMarkdown,
  continuedAssistantIds,
  ProviderEmpty,
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

      expect(html).toContain("I found the entry point. I am checking the callers now.");
      expect(html).toContain("is-interim-update");
      expect(html).not.toContain("Reviewing the entry point");
      expect(html.match(/agent-activity-cluster/g)).toHaveLength(1);
      expect(html.indexOf("I found the entry point. I am checking the callers now.")).toBeLessThan(
        html.indexOf("Checking every caller in full"),
      );
      if (agent === "cursor") {
        expect(html).toContain("cx-prose is-interim-update");
      } else if (agent === "opencode") {
        expect(html).toContain("oc-prose is-interim-update");
      } else {
        expect(html).not.toContain("official-stream-caret");
      }
    });
  }

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

  test("docks an optimistic first Codex prompt while the handshake finishes", () => {
    expect(shouldDockCodexPrompt("starting", true, false, false)).toBe(true);
    expect(shouldDockCodexPrompt("working", true, false, false)).toBe(true);
    expect(shouldDockCodexPrompt("working", true, false, true)).toBe(false);
    expect(shouldDockCodexPrompt("working", true, true, false)).toBe(false);
  });
});
