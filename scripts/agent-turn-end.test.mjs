import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isTurnEnd } from "../src/lib/agents/events.ts";

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

describe("completion signals are rationed per prompt", () => {
  const terminals = read("src/lib/terminals.ts");

  test("a log or hook completion is dropped when nothing was asked", () => {
    expect(terminals).toContain("if (session.agentTurnCredits <= 0) return;");
    expect(terminals).toContain("session.agentTurnCredits -= 1;");
  });

  test("launching an agent and pressing Enter into it both buy a completion", () => {
    expect(terminals).toContain("session.agentTurnCredits = 1;");
    expect(terminals).toContain(
      "if (session.agent && isAgentPromptSubmission(data)) creditAgentTurn(session);",
    );
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
});
