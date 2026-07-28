import { describe, expect, test } from "bun:test";

import { highlightCommand } from "./commandSyntax";

const compact = (input: string) =>
  highlightCommand(input)
    .filter((token) => token.kind !== "plain" || token.text.trim())
    .map(({ text, kind }) => [text, kind]);

describe("command input syntax highlighting", () => {
  test("preserves every character, including incomplete syntax", () => {
    for (const input of [
      "",
      "bun run app",
      "git commit -m \"unfinished",
      "$env:NODE_ENV = 'test'\n bun test",
      "echo foo#bar # comment",
    ]) {
      expect(highlightCommand(input).map((token) => token.text).join("")).toBe(input);
    }
  });

  test("distinguishes commands, known subcommands, flags, and arguments", () => {
    expect(compact("bun run app --watch")).toEqual([
      ["bun", "command"],
      ["run", "subcommand"],
      ["app", "plain"],
      ["--watch", "flag"],
    ]);
  });

  test("resets command position across pipelines and statements", () => {
    expect(compact("git status | rg TODO && bun test")).toEqual([
      ["git", "command"],
      ["status", "subcommand"],
      ["|", "operator"],
      ["rg", "command"],
      ["TODO", "plain"],
      ["&&", "operator"],
      ["bun", "command"],
      ["test", "subcommand"],
    ]);
  });

  test("recognises strings, variables, paths, URLs, numbers, and comments", () => {
    expect(compact('echo "$env:HOME" ./src 42 https://example.com # note')).toEqual([
      ["echo", "command"],
      ['"$env:HOME"', "string"],
      ["./src", "path"],
      ["42", "number"],
      ["https://example.com", "url"],
      ["# note", "comment"],
    ]);
  });

  test("keeps flag assignment parts semantically separate", () => {
    expect(compact("vite --port=5173 --host=localhost")).toEqual([
      ["vite", "command"],
      ["--port", "flag"],
      ["=", "operator"],
      ["5173", "number"],
      ["--host", "flag"],
      ["=", "operator"],
      ["localhost", "plain"],
    ]);
  });

  test("understands wrappers and environment assignments", () => {
    expect(compact("NODE_ENV=test sudo bun run dev")).toEqual([
      ["NODE_ENV=test", "variable"],
      ["sudo", "command"],
      ["bun", "command"],
      ["run", "subcommand"],
      ["dev", "plain"],
    ]);
  });

  test("highlights PowerShell assignment syntax without treating equals as a command", () => {
    expect(compact("$env:NODE_ENV = \"test\"")).toEqual([
      ["$env:NODE_ENV", "variable"],
      ["=", "operator"],
      ['"test"', "string"],
    ]);
  });
});
