import { describe, expect, test } from "bun:test";

import { highlightAgentComposer } from "./agentComposerSyntax";

const compact = (input: string) =>
  highlightAgentComposer(input)
    .filter((token) => token.kind !== "plain" || token.text.trim())
    .map(({ text, kind }) => [text, kind]);

describe("agent composer syntax highlighting", () => {
  test("preserves every character while syntax is incomplete", () => {
    for (const input of [
      "",
      "/",
      "/model gpt-5",
      "Review @src/AgentComposer.tsx and @",
      'Open @"docs/release notes.md',
      "mail@example.com",
    ]) {
      expect(highlightAgentComposer(input).map((token) => token.text).join("")).toBe(input);
    }
  });

  test("highlights only the leading slash command name", () => {
    expect(compact("/model gpt-5.6")).toEqual([
      ["/model", "command"],
      [" gpt-5.6", "plain"],
    ]);
    expect(compact("Explain /model behavior")).toEqual([["Explain /model behavior", "plain"]]);
  });

  test("highlights multiple file mentions without treating email as a mention", () => {
    expect(compact("Compare @src/app.ts with @README.md and mail@example.com")).toEqual([
      ["Compare ", "plain"],
      ["@src/app.ts", "file"],
      [" with ", "plain"],
      ["@README.md", "file"],
      [" and mail@example.com", "plain"],
    ]);
  });

  test("keeps a quoted path, spaces, and escaped quotes in one mention", () => {
    expect(compact('Open @"docs/release \\"notes\\".md" next')).toEqual([
      ["Open ", "plain"],
      ['@"docs/release \\"notes\\".md"', "file"],
      [" next", "plain"],
    ]);
  });
});
