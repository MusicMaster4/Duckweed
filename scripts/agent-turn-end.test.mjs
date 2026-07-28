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
    expect(terminals).toContain("const completed = session.agentTurns.shift();");
    expect(terminals).toContain("if (!completed) return;");
  });

  test("only real prompts buy a completion", () => {
    expect(terminals).toContain("if (launchPrompt !== null) creditAgentTurn(session, launchPrompt)");
    expect(terminals).not.toContain("session.agentTurnCredits = 1;");
    // Only an already-bound agent gets an interactive prompt credit; a launch
    // is credited separately when it actually carries prompt text.
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
    const reset = terminals.indexOf("session.agentTurns = [];", unbind);
    expect(unbind).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(unbind);
  });

  test("the custom UI's own protocol signal is not rationed", () => {
    expect(terminals).toContain("markAgentComplete(session, true)");
    expect(terminals).toContain("agentSessions.subscribeTurnEnd");
    expect(terminals).toContain("shouldAcceptAgentCompletion(trusted");
  });

  test("config slash ends are filtered before the sound is earned", () => {
    expect(session).toContain("isAnnounceableTurn");
    expect(session).toContain("userInitiatedTurn");
    // Raw CLI panes filter the same slash list when a log/hook completes.
    expect(terminals).toContain("isMetaSlashCommand(completed.prompt)");
    expect(terminals).toContain("agentTurns");
  });

  test("a queued custom UI follow-up keeps ownership of its later completion", () => {
    const emit = session.slice(
      session.indexOf("function emit("),
      session.indexOf("function handleFrame(", session.indexOf("function emit(")),
    );
    const clear = emit.indexOf("session.userInitiatedTurn = false;");
    const release = emit.indexOf("if (releasingQueued)");
    const dispatch = emit.indexOf("dispatch(session, queued.text", release);
    expect(clear).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(clear);
    expect(dispatch).toBeGreaterThan(release);
  });
});

describe("custom agent UI restores the shell underneath it", () => {
  const terminals = read("src/lib/terminals.ts");

  test("intercepts a harness launch before shell history and used-state", () => {
    const submit = terminals.slice(
      terminals.indexOf("export function submitCommand("),
      terminals.indexOf("/** Run `text` in the pane's shell", terminals.indexOf("export function submitCommand(")),
    );
    expect(submit.indexOf("startAgentUi(session, text, session.ran)")).toBeGreaterThan(-1);
    expect(submit.indexOf("startAgentUi(session, text, session.ran)")).toBeLessThan(
      submit.indexOf("markRan(session)"),
    );
    expect(submit.indexOf("startAgentUi(session, text, session.ran)")).toBeLessThan(
      submit.indexOf("commandHistory.record"),
    );
  });

  test("puts terminal metadata back before revealing and focusing the shell", () => {
    const close = terminals.slice(
      terminals.indexOf("export function closeAgentUi("),
      terminals.indexOf("/** Handle the custom surface", terminals.indexOf("export function closeAgentUi(")),
    );
    expect(close).toContain("session.ran = restore.ran");
    expect(close).toContain("session.processStartedAt = restore.processStartedAt");
    expect(close.indexOf("session.ran = restore.ran")).toBeLessThan(
      close.indexOf("notifySession(id)"),
    );
    expect(close.indexOf("notifySession(id)")).toBeLessThan(close.indexOf("focus(id)"));
  });

  test("remembers whether a raw pane was pristine before the launch was typed", () => {
    expect(terminals).toContain("rawCommandStartedRan");
    expect(terminals).toContain("const startedRan = session.rawCommandStartedRan ?? session.ran");
    expect(terminals).toContain("startAgentUi(session, command, startedRan, command)");
  });

  test("erases the raw launch from PSReadLine instead of relying on Ctrl+U", () => {
    const erase = terminals.slice(
      terminals.indexOf("function eraseRawShellLine("),
      terminals.indexOf("/**\n * Track what is being typed", terminals.indexOf("function eraseRawShellLine(")),
    );
    expect(erase).toContain('"\\x7f".repeat(width)');
    expect(terminals).toContain("eraseRawShellLine(session, command)");
    expect(terminals).toContain("eraseRawShellLine(session, restore.rawLaunchText)");
    expect(terminals).not.toContain('send(session, "\\x15")');
  });

  test("clears the editor draft before a harness launch can unmount it", () => {
    const submit = terminals.slice(
      terminals.indexOf("export function submitCommand("),
      terminals.indexOf("/** Run `text` in the pane's shell", terminals.indexOf("export function submitCommand(")),
    );
    expect(submit).toContain('session.draft = ""');
    expect(submit.indexOf('session.draft = ""')).toBeLessThan(
      submit.indexOf("startAgentUi(session, text, session.ran)"),
    );
  });
});

describe("custom agent workflow dock", () => {
  const surface = read("src/components/agent/AgentSurface.tsx");

  test("keeps the newest provider plan immediately above the composer", () => {
    expect(surface).toContain("export function latestWorkflow(");
    expect(surface).toContain('session.items.filter((item) => item.kind !== "plan")');
    const dock = surface.indexOf('className="agent-workflow-dock"');
    const composer = surface.indexOf("<AgentComposer", dock);
    expect(dock).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(dock);
  });
});
