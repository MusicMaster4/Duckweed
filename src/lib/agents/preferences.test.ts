import { afterEach, describe, expect, test } from "bun:test";

import type { AgentLaunch } from "./launch";
import {
  preferenceScope,
  rememberPreferences,
  resetForTests,
  withRememberedPreferences,
} from "./preferences";

function launch(
  agent: AgentLaunch["agent"],
  program: string,
  model: string | null = null,
  effort: string | null = null,
): AgentLaunch {
  return {
    agent,
    program,
    env: {},
    wrapperArgs: [],
    args: [],
    prompt: null,
    model,
    effort,
    resume: false,
    resumeId: null,
  };
}

afterEach(() => resetForTests());

describe("custom agent model preferences", () => {
  test("restores the last model and effort in a later session", () => {
    const opencode = launch("opencode", "opencode");
    rememberPreferences(opencode, {
      model: "opencode/claude-opus-5",
      effort: "high",
    });

    expect(withRememberedPreferences(opencode)).toMatchObject({
      model: "opencode/claude-opus-5",
      effort: "high",
    });
  });

  test("keeps every CLI's choices independent", () => {
    const choices = [
      [launch("claude", "claude"), "opus", "high"],
      [launch("codex", "codex"), "gpt-5.6-sol", "xhigh"],
      [launch("cursor", "cursor-agent"), "composer-2", "medium"],
      [launch("grok", "grok"), "grok-4.5", "low"],
      [launch("opencode", "opencode"), "opencode/big-pickle", "minimal"],
    ] as const;

    for (const [cli, model, effort] of choices) {
      rememberPreferences(cli, { model, effort });
    }
    for (const [cli, model, effort] of choices) {
      expect(withRememberedPreferences(cli)).toMatchObject({ model, effort });
    }
  });

  test("does not mix Claude with wrappers that use another model catalog", () => {
    const claude = launch("claude", "claude");
    const claudex = launch("claude", "C:\\tools\\claudex.cmd");
    rememberPreferences(claude, { model: "opus", effort: "high" });
    rememberPreferences(claudex, { model: "gpt-5.6-sol", effort: "xhigh" });

    expect(preferenceScope(claude)).not.toBe(preferenceScope(claudex));
    expect(withRememberedPreferences(claude).model).toBe("opus");
    expect(withRememberedPreferences(claudex).model).toBe("gpt-5.6-sol");
  });

  test("explicit launch flags override remembered values field by field", () => {
    const codex = launch("codex", "codex");
    rememberPreferences(codex, { model: "gpt-5.5", effort: "medium" });

    expect(withRememberedPreferences({ ...codex, effort: "xhigh" })).toMatchObject({
      model: "gpt-5.5",
      effort: "xhigh",
    });
  });

  test("keeps the last effort when only the model changes", () => {
    const grok = launch("grok", "grok");
    rememberPreferences(grok, { model: "grok-4.5", effort: "high" });
    rememberPreferences(grok, { model: "grok-4.6" });

    expect(withRememberedPreferences(grok)).toMatchObject({
      model: "grok-4.6",
      effort: "high",
    });
  });
});
