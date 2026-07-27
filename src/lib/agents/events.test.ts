import { describe, expect, test } from "bun:test";

import { applyEvent } from "./events";
import { emptyUsage, type AgentSessionState } from "./types";

function blank(): AgentSessionState {
  return {
    termId: "t1",
    agent: "claude",
    program: "claude",
    label: "Claude Code",
    mark: "CC",
    accent: "#d97757",
    status: "idle",
    cwd: "H:/project",
    model: null,
    effort: null,
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

describe("resumed", () => {
  test("marks the transcript and adopts the resumed session id", () => {
    const state = applyEvent(blank(), {
      type: "resumed",
      sessionId: "abc-123",
      title: "Fix the parser",
    });
    expect(state.sessionId).toBe("abc-123");
    // The empty state invites a first prompt; a continued conversation is not
    // one, even before the agent has said anything back.
    expect(state.started).toBe(true);
    expect(state.items).toEqual([
      expect.objectContaining({ kind: "notice", tone: "info", text: "Resumed “Fix the parser”" }),
    ]);
  });

  test("still says something when the store had no title", () => {
    const state = applyEvent(blank(), { type: "resumed", sessionId: "abc-123", title: "" });
    expect(state.items[0]).toMatchObject({
      kind: "notice",
      text: "Resumed the previous session",
    });
  });
});
