import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { emptyUsage, type AgentSessionState } from "../../lib/agents/types";
import { fallbackModels } from "../../lib/agents/slashCatalog";
import { AgentControls } from "./AgentControls";

function session(agent: AgentSessionState["agent"]): AgentSessionState {
  return {
    termId: "term-1",
    agent,
    program: agent,
    label: agent === "codex" ? "Codex" : "OpenCode",
    mark: agent === "codex" ? "CX" : "OC",
    accent: "#888",
    status: "idle",
    workStartedAt: null,
    lastWorkedForMs: null,
    cwd: "H:/project",
    model: null,
    effort: null,
    accessMode: "default",
    models: [],
    sessionId: null,
    items: [],
    pending: [],
    permission: null,
    usage: emptyUsage(),
    error: null,
    commands: [],
    started: false,
  };
}

describe("agent access control", () => {
  test("shows inherited permissions as the default for Codex", () => {
    const html = renderToStaticMarkup(
      <AgentControls session={session("codex")} onSelect={() => {}} />,
    );

    expect(html).toContain("Agent default");
    expect(html).toContain("inherit the agent&#x27;s own configuration");
  });

  test("does not invent a session-wide permission switch for ACP agents", () => {
    const html = renderToStaticMarkup(
      <AgentControls session={session("opencode")} onSelect={() => {}} />,
    );

    expect(html).toBe("");
  });
});

describe("Grok effort picker", () => {
  test("labels xhigh as XHigh for Grok 4.6", () => {
    const grok = session("opencode");
    grok.agent = "grok";
    grok.label = "Grok Build";
    grok.mark = "GR";
    grok.model = "grok-4.6";
    grok.effort = "xhigh";
    grok.models = [
      {
        id: "grok-4.6",
        label: "Grok 4.6",
        efforts: ["xhigh", "high", "medium", "low"],
      },
    ];

    const html = renderToStaticMarkup(
      <AgentControls session={grok} onSelect={() => {}} />,
    );

    expect(html).toContain("Grok 4.6");
    expect(html).toContain("XHigh");
  });
});

describe("next-message agent controls", () => {
  test("shows the 1M Claude model rather than matching the ordinary Opus alias first", () => {
    const claude = session("claude");
    claude.model = "claude-opus-5-5-20260923[1m]";
    claude.models = fallbackModels("claude");
    const html = renderToStaticMarkup(<AgentControls session={claude} onSelect={() => {}} />);
    expect(html).toContain("Opus 5.5 (1M context)");
    expect(html).not.toContain('>Opus 5.5</span>');
  });

  test("shows a staged model without replacing the active model", () => {
    const staged = session("opencode");
    staged.model = "opencode/big-pickle";
    staged.nextModel = "opencode/claude-sonnet-4-5";
    staged.models = [
      { id: "opencode/big-pickle", label: "Big Pickle", efforts: [] },
      {
        id: "opencode/claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        efforts: ["high", "medium"],
      },
    ];

    const html = renderToStaticMarkup(
      <AgentControls session={staged} onSelect={() => {}} />,
    );

    expect(html).toContain("Claude Sonnet 4.5");
    expect(html).toContain("Model for next message");
    expect(html).toContain(">Next<");
  });
});
