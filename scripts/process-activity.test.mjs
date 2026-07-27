import { describe, expect, test } from "bun:test";

import {
  detectAgent,
  didProcessFinish,
  isGenericOsc777Notification,
  parseAgentOsc777,
  shouldPlayCompletionSound,
  shouldSignalCompletion,
} from "../src/lib/processActivity.ts";

const state = (overrides = {}) => ({
  busy: false,
  exited: false,
  completionSeq: 0,
  agent: null,
  processStartedAt: null,
  ...overrides,
});

describe("terminal completion activity", () => {
  test("a child process changing from running to idle finishes", () => {
    expect(
      didProcessFinish(
        state({ busy: true }),
        state(),
      ),
    ).toBe(true);
  });

  test("an exited shell finishes even when it had no busy child", () => {
    expect(
      didProcessFinish(
        state(),
        state({ exited: true }),
      ),
    ).toBe(true);
  });

  test("starting and unchanged idle states do not finish", () => {
    expect(
      didProcessFinish(
        state(),
        state({ busy: true }),
      ),
    ).toBe(false);
    expect(
      didProcessFinish(
        state(),
        state(),
      ),
    ).toBe(false);
  });

  test("a persistent agent completing a turn finishes without exiting", () => {
    expect(
      didProcessFinish(
        state({ busy: true, completionSeq: 4 }),
        state({ busy: true, completionSeq: 5 }),
      ),
    ).toBe(true);
  });
});

describe("completion sound and highlight eligibility", () => {
  const now = 100_000;

  test("ignores ordinary terminal processes that ran for 30 seconds or less", () => {
    expect(
      shouldSignalCompletion(
        state({ busy: true, processStartedAt: now - 29_999 }),
        state({ processStartedAt: now - 29_999 }),
        now,
      ),
    ).toBe(false);
    expect(
      shouldSignalCompletion(
        state({ busy: true, processStartedAt: now - 30_000 }),
        state({ processStartedAt: now - 30_000 }),
        now,
      ),
    ).toBe(false);
  });

  test("signals ordinary terminal processes that ran for more than 30 seconds", () => {
    expect(
      shouldSignalCompletion(
        state({ busy: true, processStartedAt: now - 30_001 }),
        state({ processStartedAt: now - 30_001 }),
        now,
      ),
    ).toBe(true);
  });

  test("does not treat quitting a coding agent as a turn completion", () => {
    // Ctrl+C /exit: process goes idle (or shell exits) without a turn record.
    expect(
      shouldSignalCompletion(
        state({ busy: true, agent: "codex", processStartedAt: now - 120_000 }),
        state({ agent: "codex", processStartedAt: now - 120_000 }),
        now,
      ),
    ).toBe(false);
    expect(
      shouldSignalCompletion(
        state({ busy: true, agent: "grok", processStartedAt: now - 120_000 }),
        state({ processStartedAt: now - 120_000 }),
        now,
      ),
    ).toBe(false);
    expect(
      shouldSignalCompletion(
        state({ agent: "claude", processStartedAt: now - 120_000 }),
        state({ exited: true, processStartedAt: now - 120_000 }),
        now,
      ),
    ).toBe(false);
  });

  test("signals persistent agent turns regardless of process runtime", () => {
    expect(
      shouldSignalCompletion(
        state({ busy: true, completionSeq: 4, processStartedAt: now - 1 }),
        state({ busy: true, completionSeq: 5, processStartedAt: now - 1 }),
        now,
      ),
    ).toBe(true);
    expect(
      shouldSignalCompletion(
        state({
          busy: true,
          agent: "grok",
          completionSeq: 2,
          processStartedAt: now - 1,
        }),
        state({
          busy: true,
          agent: "grok",
          completionSeq: 3,
          processStartedAt: now - 1,
        }),
        now,
      ),
    ).toBe(true);
  });
});

describe("completion sound eligibility", () => {
  const now = 100_000;

  test("does not play for jobs that ran one minute or less", () => {
    expect(
      shouldPlayCompletionSound(
        state({ busy: true, processStartedAt: now - 60_000 }),
        state({ processStartedAt: now - 60_000 }),
        now,
      ),
    ).toBe(false);
    expect(
      shouldPlayCompletionSound(
        state({
          busy: true,
          agent: "codex",
          completionSeq: 1,
          processStartedAt: now - 59_999,
        }),
        state({
          busy: true,
          agent: "codex",
          completionSeq: 2,
          processStartedAt: now - 59_999,
        }),
        now,
      ),
    ).toBe(false);
  });

  test("plays for finished jobs and agent turns that ran more than one minute", () => {
    expect(
      shouldPlayCompletionSound(
        state({ busy: true, processStartedAt: now - 60_001 }),
        state({ processStartedAt: now - 60_001 }),
        now,
      ),
    ).toBe(true);
    expect(
      shouldPlayCompletionSound(
        state({
          busy: true,
          agent: "claude",
          completionSeq: 1,
          processStartedAt: now - 60_001,
        }),
        state({
          busy: true,
          agent: "claude",
          completionSeq: 2,
          processStartedAt: now - 60_001,
        }),
        now,
      ),
    ).toBe(true);
  });

  test("does not play when quitting a coding agent", () => {
    expect(
      shouldPlayCompletionSound(
        state({ busy: true, agent: "grok", processStartedAt: now - 120_000 }),
        state({ processStartedAt: now - 120_000 }),
        now,
      ),
    ).toBe(false);
  });

  test("does not play when the process did not finish", () => {
    expect(
      shouldPlayCompletionSound(
        state({ processStartedAt: now - 120_000 }),
        state({ busy: true, processStartedAt: now - 120_000 }),
        now,
      ),
    ).toBe(false);
  });
});

describe("CLI agent signals", () => {
  test("recognises official commands and common profile wrappers", () => {
    expect(detectAgent("codex --search")).toBe("codex");
    expect(detectAgent("claude-work --resume")).toBe("claude");
    expect(detectAgent("grok-build")).toBe("grok");
    expect(detectAgent("npx @openai/codex")).toBe("codex");
    expect(detectAgent("opencode")).toBe("opencode");
    expect(detectAgent("npx @google/gemini-cli")).toBe("gemini");
    expect(detectAgent("agy --continue")).toBe("antigravity");
    expect(detectAgent("qwen-code")).toBe("qwen");
    expect(detectAgent("copilot")).toBe("copilot");
    expect(detectAgent("aider --model sonnet")).toBe("aider");
    expect(detectAgent("aider-chat")).toBe("aider");
    expect(detectAgent("npm test")).toBeNull();
    expect(detectAgent("echo codex")).toBeNull();
  });

  test("parses Warp-compatible OSC 777 completion events", () => {
    const event = parseAgentOsc777(
      'notify;warp://cli-agent;{"v":1,"agent":"claude","event":"stop"}',
    );
    expect(event).toEqual({ agent: "claude", needsAttention: true });
  });

  test("does not treat prompt submission as completion", () => {
    const event = parseAgentOsc777(
      'notify;warp://cli-agent;{"v":1,"agent":"codex","event":"prompt_submit"}',
    );
    expect(event).toEqual({ agent: "codex", needsAttention: false });
  });

  test("recognises generic OSC 777 terminal notifications", () => {
    expect(
      isGenericOsc777Notification(
        "notify;Gemini CLI session complete;Gemini CLI finished responding.",
      ),
    ).toBe(true);
    expect(isGenericOsc777Notification("progress;50")).toBe(false);
    // Progress/status notifies must not look like a finished turn.
    expect(isGenericOsc777Notification("notify;Working;Still generating…")).toBe(false);
    expect(isGenericOsc777Notification("notify;Status;Agent busy")).toBe(false);
  });
});
