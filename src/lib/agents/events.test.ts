import { describe, expect, test } from "bun:test";

import {
  applyEvent,
  didStatusEnterIdle,
  isAnnounceableTurn,
  isMetaSlashCommand,
  isTurnEnd,
  type TurnAnnounceInput,
  type TurnEndInput,
} from "./events";
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
    workStartedAt: null,
    lastWorkedForMs: null,
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

describe("queued follow-ups", () => {
  test("removes the requested prompt without disturbing the rest of the queue", () => {
    let state = applyEvent(blank(), {
      type: "queue",
      prompt: { id: "queued-1", text: "first", images: [] },
    });
    state = applyEvent(state, {
      type: "queue",
      prompt: { id: "queued-2", text: "second", images: [] },
    });
    state = applyEvent(state, { type: "unqueue", id: "queued-2" });

    expect(state.pending).toEqual([
      { id: "queued-1", text: "first", images: [] },
    ]);
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

describe("work duration", () => {
  test("records one turn from the working transition through completion", () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      let state = applyEvent(blank(), { type: "status", status: "working" });
      expect(state.workStartedAt).toBe(1_000);
      expect(state.lastWorkedForMs).toBe(null);

      Date.now = () => 84_000;
      state = applyEvent(state, { type: "turn-end" });
      expect(state.workStartedAt).toBe(null);
      expect(state.lastWorkedForMs).toBe(83_000);
    } finally {
      Date.now = originalNow;
    }
  });

  test("keeps the original start while a turn waits for the user", () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 2_000;
      let state = applyEvent(blank(), { type: "status", status: "working" });
      state = applyEvent(state, { type: "status", status: "waiting" });

      Date.now = () => 7_000;
      state = applyEvent(state, { type: "status", status: "working" });
      expect(state.workStartedAt).toBe(2_000);
    } finally {
      Date.now = originalNow;
    }
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

const turn = (overrides: Partial<TurnEndInput> = {}): TurnEndInput => ({
  before: "working",
  after: "idle",
  permission: false,
  releasingQueued: false,
  interrupted: false,
  ...overrides,
});

const announce = (overrides: Partial<TurnAnnounceInput> = {}): TurnAnnounceInput => ({
  ...turn(),
  usedTools: false,
  userText: "fix the build",
  userInitiated: true,
  ...overrides,
});

describe("turn completion", () => {
  test("a finished turn is worth coming back to", () => {
    expect(isTurnEnd(turn())).toBe(true);
    // Answering a permission prompt and then finishing.
    expect(isTurnEnd(turn({ before: "waiting" }))).toBe(true);
  });

  test("a session becoming blocked on the user needs attention", () => {
    expect(isTurnEnd(turn({ after: "waiting", permission: true }))).toBe(true);
    // A second permission inside the same blocked stretch is one nudge, not two.
    expect(isTurnEnd(turn({ before: "waiting", after: "waiting", permission: true }))).toBe(false);
    // Waiting on something that is not a prompt the user can answer.
    expect(isTurnEnd(turn({ after: "waiting", permission: false }))).toBe(false);
  });

  test("the handshake is not a turn", () => {
    expect(isTurnEnd(turn({ before: "starting" }))).toBe(false);
  });

  test("quitting the agent is not a completed turn", () => {
    expect(isTurnEnd(turn({ after: "exited" }))).toBe(false);
    expect(isTurnEnd(turn({ after: "error" }))).toBe(false);
  });

  test("the user stopping the turn is not the agent finishing it", () => {
    expect(isTurnEnd(turn({ interrupted: true }))).toBe(false);
  });

  test("a queued follow-up leaving means the agent is still working", () => {
    expect(isTurnEnd(turn({ releasingQueued: true }))).toBe(false);
  });

  test("mid-turn status changes are not completions", () => {
    expect(isTurnEnd(turn({ before: "idle", after: "working" }))).toBe(false);
    expect(isTurnEnd(turn({ before: "working", after: "working" }))).toBe(false);
  });

  test("echoing a prompt while idle keeps ownership of the turn", () => {
    // Adapters emit the user item before their working status. That item
    // changes the transcript, not the status, so it must not clear the flag
    // that makes the eventual turn end announceable.
    expect(didStatusEnterIdle("idle", "idle")).toBe(false);
    expect(didStatusEnterIdle("idle", "working")).toBe(false);
    expect(didStatusEnterIdle("working", "idle")).toBe(true);
    expect(didStatusEnterIdle("waiting", "idle")).toBe(true);
    expect(didStatusEnterIdle("starting", "idle")).toBe(true);
  });
});

describe("completion announcements are only for real tasks", () => {
  test("a normal finished prompt is announceable", () => {
    expect(isAnnounceableTurn(announce())).toBe(true);
    expect(isAnnounceableTurn(announce({ usedTools: true }))).toBe(true);
  });

  test("a permission prompt is announceable even without tools", () => {
    expect(
      isAnnounceableTurn(
        announce({ after: "waiting", permission: true, userText: null, usedTools: false }),
      ),
    ).toBe(true);
  });

  test("/effort and other meta slash commands are not tasks", () => {
    expect(isMetaSlashCommand("/effort high")).toBe(true);
    expect(isMetaSlashCommand("/model sonnet")).toBe(true);
    expect(isMetaSlashCommand("/status")).toBe(true);
    expect(isMetaSlashCommand("fix the build")).toBe(false);
    expect(isMetaSlashCommand("/review the auth module")).toBe(false);

    expect(isAnnounceableTurn(announce({ userText: "/effort high" }))).toBe(false);
    expect(isAnnounceableTurn(announce({ userText: "/model opus" }))).toBe(false);
    expect(isAnnounceableTurn(announce({ userText: "/compact" }))).toBe(false);
    // A slash that actually ran tools is real work.
    expect(isAnnounceableTurn(announce({ userText: "/compact", usedTools: true }))).toBe(true);
  });

  test("synthetic working stretches (resume/load) stay silent", () => {
    expect(
      isAnnounceableTurn(announce({ userInitiated: false, userText: null, usedTools: false })),
    ).toBe(false);
  });

  test("interrupted and queued ends are still not announceable", () => {
    expect(isAnnounceableTurn(announce({ interrupted: true }))).toBe(false);
    expect(isAnnounceableTurn(announce({ releasingQueued: true }))).toBe(false);
  });
});
