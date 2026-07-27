import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAnnounceableTurn,
  isMetaSlashCommand,
  isTurnEnd,
} from "../src/lib/agents/events.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

const turn = (overrides = {}) => ({
  before: "working",
  after: "idle",
  permission: false,
  releasingQueued: false,
  interrupted: false,
  ...overrides,
});

const announce = (overrides = {}) => ({
  ...turn(),
  usedTools: false,
  userText: "fix the build",
  userInitiated: true,
  ...overrides,
});

describe("custom agent UI turn completion", () => {
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
    expect(
      isAnnounceableTurn(announce({ userText: "/compact", usedTools: true })),
    ).toBe(true);
  });

  test("synthetic working stretches (resume/load) stay silent", () => {
    expect(
      isAnnounceableTurn(
        announce({ userInitiated: false, userText: null, usedTools: false }),
      ),
    ).toBe(false);
  });

  test("interrupted and queued ends are still not announceable", () => {
    expect(isAnnounceableTurn(announce({ interrupted: true }))).toBe(false);
    expect(isAnnounceableTurn(announce({ releasingQueued: true }))).toBe(false);
  });
});

describe("completion signals are rationed per prompt", () => {
  const terminals = read("src/lib/terminals.ts");
  const session = read("src/lib/agents/session.ts");

  test("a log or hook completion is dropped when nothing was asked", () => {
    expect(terminals).toContain("if (session.agentTurnCredits <= 0) return;");
    expect(terminals).toContain("session.agentTurnCredits -= 1;");
  });

  test("launching an agent and pressing Enter into it both buy a completion", () => {
    expect(terminals).toContain("session.agentTurnCredits = 1;");
    // Only an already-bound agent gets a follow-up credit; first bind is launch.
    expect(terminals).toContain("if (alreadyBound && isAgentPromptSubmission(data))");
    expect(terminals).toContain("creditAgentTurn(session");
  });

  test("each prompt resets the duration clock so short follow-ups stay quiet", () => {
    expect(terminals).toContain("session.processStartedAt = Date.now();");
    expect(session).toContain("subscribeTurnStart");
    expect(session).toContain("announceTurnStart");
    expect(terminals).toContain("agentSessions.subscribeTurnStart");
  });

  test("quitting the CLI drops the credit its late events would spend", () => {
    const unbind = terminals.indexOf("function unbindAgent(");
    const reset = terminals.indexOf("session.agentTurnCredits = 0;", unbind);
    expect(unbind).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(unbind);
  });

  test("the custom UI's own protocol signal is not rationed", () => {
    expect(terminals).toContain("markAgentComplete(session, true)");
    expect(terminals).toContain("agentSessions.subscribeTurnEnd");
  });

  test("config slash ends are filtered before the sound is earned", () => {
    expect(session).toContain("isAnnounceableTurn");
    expect(session).toContain("userInitiatedTurn");
    // Raw CLI panes filter the same slash list when a log/hook completes.
    expect(terminals).toContain("isMetaSlashCommand(session.lastAgentPrompt)");
    expect(terminals).toContain("lastAgentPrompt");
  });
});
