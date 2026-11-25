import { describe, expect, test } from "bun:test";
import { claudeChromeArgs, shadowsClaudeAiLogin } from "./claudeSettings";

describe("claudeChromeArgs", () => {
  test("adds --chrome when Chrome is enabled by default", () => {
    expect(claudeChromeArgs([], true)).toEqual(["--chrome"]);
  });

  test("adds nothing when the default is off", () => {
    expect(claudeChromeArgs([], false)).toEqual([]);
  });

  test("respects an explicit flag typed by the user", () => {
    expect(claudeChromeArgs(["--no-chrome"], true)).toEqual([]);
    expect(claudeChromeArgs(["--model", "opus", "--Chrome"], true)).toEqual([]);
  });
});

describe("shadowsClaudeAiLogin", () => {
  test("matches the CLI warning about an auth source outranking claude.ai", () => {
    expect(shadowsClaudeAiLogin(
      "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors",
    )).toBe(true);
  });

  test("ignores unrelated stderr", () => {
    expect(shadowsClaudeAiLogin("MCP server \"blender\" failed to connect")).toBe(false);
  });
});
