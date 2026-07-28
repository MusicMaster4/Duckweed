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
  test("replaces the current pane with a restored transcript", () => {
    let state = applyEvent(blank(), { type: "user", text: "Current conversation" });
    state = applyEvent(state, {
      type: "transcript",
      items: [
        { kind: "user", id: "old-user", at: 1, text: "Past prompt" },
        {
          kind: "assistant",
          id: "old-answer",
          at: 2,
          text: "Past answer",
          streaming: false,
        },
      ],
    });

    expect(state.started).toBe(true);
    expect(state.items.map((item) => item.id)).toEqual(["old-user", "old-answer"]);
    expect(state.usage).toEqual(emptyUsage());
  });

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

describe("transient notices", () => {
  test("picker confirmations disappear when real work starts", () => {
    const configured = applyEvent(blank(), {
      type: "notice",
      tone: "info",
      transient: true,
      text: "Effort set to high.",
    });
    const prompted = applyEvent(configured, { type: "user", text: "Explain this repo" });

    expect(prompted.items).toHaveLength(1);
    expect(prompted.items[0]).toMatchObject({ kind: "user", text: "Explain this repo" });
  });

  test("dismisses exit hints without removing durable errors", () => {
    let state = applyEvent(blank(), {
      type: "notice",
      tone: "error",
      text: "A durable failure",
    });
    state = applyEvent(state, {
      type: "notice",
      tone: "info",
      transient: true,
      text: "Press Ctrl+C again to exit.",
    });
    state = applyEvent(state, { type: "dismiss-transient-notices" });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ tone: "error", text: "A durable failure" });
  });
});

describe("assistant snapshots", () => {
  test("replaces a partial stream with the provider's complete text", () => {
    let state = applyEvent(blank(), {
      type: "assistant-delta",
      id: "answer-1",
      text: "Partial",
    });
    state = applyEvent(state, {
      type: "assistant-snapshot",
      id: "answer-1",
      text: "Partial response, now complete.",
    });

    expect(state.items[0]).toMatchObject({
      kind: "assistant",
      text: "Partial response, now complete.",
      streaming: false,
    });
  });
});

describe("double Ctrl+C exit", () => {
  test("arms and disarms without adding chat timeline content", () => {
    const armed = applyEvent(blank(), { type: "exit-armed", armed: true });
    expect(armed.exitArmed).toBe(true);
    expect(armed.items).toEqual([]);

    const disarmed = applyEvent(armed, { type: "exit-armed", armed: false });
    expect(disarmed.exitArmed).toBe(false);
    expect(disarmed.items).toEqual([]);
  });
});
