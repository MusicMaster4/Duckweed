import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { emptyUsage, type AgentSessionState } from "../../lib/agents/types";
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

describe("next-message agent controls", () => {
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
