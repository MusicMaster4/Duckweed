import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentProviderIcon } from "../AgentProviderIcon";
import { shouldDockCodexPrompt } from "./ChatGPTExperience";
import { ClaudeExperience } from "./ClaudeExperience";
import {
  GrokDotMatrix,
  GrokExperience,
  hiddenGrokProgressMessages,
} from "./GrokExperience";
import { activityGroups, AssistantMarkdown, ProviderEmpty } from "./OfficialShared";

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

  test("escapes HTML supplied by an agent", () => {
    const html = renderToStaticMarkup(<AssistantMarkdown text={'<script>alert("x")</script>'} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("settles the Grok matrix with every point dimmed", () => {
    const html = renderToStaticMarkup(<GrokDotMatrix active={false} />);
    expect(html).toContain("is-settled");
    expect(html).toContain('cx="12" cy="12" r="1.6" opacity="0.2"');
    expect(html).not.toContain('opacity="1"');
    expect(html).not.toContain("<animate");
  });

  test("interleaves Grok thoughts while collapsing tools to the latest call", () => {
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

    expect(html).not.toContain("grok-trace");
    expect(html.match(/grok-thought/g)?.length).toBeGreaterThan(1);
    expect(html).toContain("grok-tool-history");
    expect(html).toContain("2 tool calls");
    expect(html).toContain("Read frontend entry");
    expect(html).not.toContain("Read package metadata");
    expect(html).not.toContain("I will inspect the metadata now.");
    expect(html).toContain("grok-thought-body");
    expect(html).toContain("This final sentence must remain available");
    expect(html).toContain("<h3>Report</h3>");
    expect(html).toContain("<strong>Duckweed</strong>");
    expect(html.indexOf("Now I should inspect the frontend entry point.")).toBeLessThan(
      html.indexOf("Read frontend entry"),
    );
  });

  test("does not flash Grok planning prose before its first tool call", () => {
    const hidden = hiddenGrokProgressMessages(
      [
        { kind: "user", id: "u1", at: 1, text: "Inspect" },
        { kind: "thinking", id: "t1", at: 2, text: "Planning", streaming: true },
        {
          kind: "assistant",
          id: "progress",
          at: 3,
          text: "I will inspect the repository now.",
          streaming: true,
        },
      ],
      true,
    );
    expect(hidden.has("progress")).toBe(true);
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
    expect(html).not.toContain("This is still progress narration.");
    expect(html).not.toContain("grok-answer-layer");
  });

  test("uses provider artwork instead of the old letter badge", () => {
    const html = renderToStaticMarkup(<AgentProviderIcon agent="codex" />);
    expect(html).toContain("<svg");
    expect(html).not.toContain(">CX<");
  });

  test("keeps every Claude command but removes Thinking after completion", () => {
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
    expect(html).toContain("claude-completed-tools");
    expect(html).toContain("Read package metadata");
    expect(html).toContain("Run tests");
    expect(html).not.toContain("claude-trace-head");
    expect(html).not.toContain(">Thinking<");
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

  test("docks an optimistic first Codex prompt while the handshake finishes", () => {
    expect(shouldDockCodexPrompt("starting", true, false, false)).toBe(true);
    expect(shouldDockCodexPrompt("working", true, false, false)).toBe(true);
    expect(shouldDockCodexPrompt("working", true, false, true)).toBe(false);
    expect(shouldDockCodexPrompt("working", true, true, false)).toBe(false);
  });
});
