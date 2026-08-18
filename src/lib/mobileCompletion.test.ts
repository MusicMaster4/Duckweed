import { describe, expect, test } from "bun:test";

import {
  completionDetailsFromState,
  shouldSendDelayedMobileCompletion,
} from "./mobileCompletion";
import { emptyUsage, type AgentSessionState } from "./agents/types";

function state(): AgentSessionState {
  return {
    termId: "term-1",
    agent: "codex",
    program: "codex",
    label: "Codex",
    mark: "CX",
    accent: "#7be05a",
    status: "idle",
    workStartedAt: null,
    lastWorkedForMs: 12_500,
    cwd: "H:/projects/duckweed",
    model: null,
    effort: null,
    models: [],
    sessionId: null,
    goal: null,
    items: [
      { id: "u1", at: 1, kind: "user", text: "Old request" },
      { id: "a1", at: 2, kind: "assistant", text: "Old response", streaming: false },
      { id: "u2", at: 3, kind: "user", text: "Implement notifications" },
      { id: "a2", at: 4, kind: "assistant", text: "I will inspect the app.", streaming: false },
      {
        id: "tool",
        at: 5,
        kind: "tool",
        callId: "call-1",
        name: "Read",
        tool: "read",
        title: "Inspect settings",
        status: "done",
        command: null,
        output: "",
        changes: [],
      },
      { id: "a3", at: 6, kind: "assistant", text: "  Notifications are ready.  ", streaming: false },
    ],
    pending: [],
    permission: null,
    usage: emptyUsage(),
    error: null,
    commands: [],
    started: true,
  };
}

describe("mobile completion details", () => {
  test("uses only the final response from the newest user turn", () => {
    expect(completionDetailsFromState(state())).toEqual({
      agent: "codex",
      label: "Codex",
      response: "Notifications are ready.",
      needsAttention: false,
      durationMs: 12_500,
    });
  });

  test("marks a session waiting for the user as needing attention", () => {
    const waiting = state();
    waiting.status = "waiting";
    expect(completionDetailsFromState(waiting).needsAttention).toBe(true);
  });
});

describe("delayed mobile completion delivery", () => {
  test("sends a background completion only while its desktop unread mark remains", () => {
    expect(shouldSendDelayedMobileCompletion({
      unreadAtCompletion: true,
      unreadNow: true,
      lastInteractionAt: null,
      now: 70_000,
    })).toBe(true);
    expect(shouldSendDelayedMobileCompletion({
      unreadAtCompletion: true,
      unreadNow: false,
      lastInteractionAt: null,
      now: 70_000,
    })).toBe(false);
  });

  test("selected terminals notify only after one minute without human interaction", () => {
    expect(shouldSendDelayedMobileCompletion({
      unreadAtCompletion: false,
      unreadNow: false,
      lastInteractionAt: 10_001,
      now: 70_000,
    })).toBe(false);
    expect(shouldSendDelayedMobileCompletion({
      unreadAtCompletion: false,
      unreadNow: false,
      lastInteractionAt: 10_000,
      now: 70_000,
    })).toBe(true);
    expect(shouldSendDelayedMobileCompletion({
      unreadAtCompletion: false,
      unreadNow: false,
      lastInteractionAt: null,
      now: 70_000,
    })).toBe(true);
  });
});
