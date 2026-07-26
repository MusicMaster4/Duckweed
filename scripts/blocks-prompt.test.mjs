import { describe, expect, test } from "bun:test";

import { looksLikePrompt } from "../src/lib/blocks.ts";

describe("looksLikePrompt", () => {
  test("matches classic PowerShell idle prompts", () => {
    expect(looksLikePrompt("PS H:\\Python\\Slop\\duckweed>")).toBe(true);
    expect(looksLikePrompt("PS C:\\Users\\me>")).toBe(true);
    expect(looksLikePrompt("PS /home/me>")).toBe(true);
    expect(looksLikePrompt("PS>")).toBe(true);
  });

  test("matches conda-prefixed PowerShell prompts", () => {
    expect(looksLikePrompt("(base) PS H:\\Python\\Slop\\duckweed>")).toBe(true);
  });

  test("matches PowerShell ^C chrome", () => {
    expect(looksLikePrompt("PS H:\\path> ^C")).toBe(true);
  });

  test("matches simple bash/zsh prompts", () => {
    expect(looksLikePrompt("user@host:~/projects$")).toBe(true);
    expect(looksLikePrompt("~/code %")).toBe(true);
  });

  test("does not treat empty as a prompt (blanks are handled separately)", () => {
    expect(looksLikePrompt("")).toBe(false);
    expect(looksLikePrompt("   ")).toBe(false);
  });

  test("does not swallow ordinary command output", () => {
    expect(looksLikePrompt("✓ done")).toBe(false);
    expect(looksLikePrompt("21 files changed, 1498 insertions(+), 72 deletions(-)")).toBe(false);
    expect(looksLikePrompt("git push 2.2s")).toBe(false);
    expect(looksLikePrompt("message feat: add tools panel")).toBe(false);
    // Diff / log lines that merely end with `>` must not count as chrome.
    expect(looksLikePrompt("compare with origin/main >")).toBe(false);
  });

  test("does not mistake a PowerShell command echo for an idle prompt", () => {
    expect(looksLikePrompt("PS H:\\Python\\Slop\\duckweed> gg c")).toBe(false);
  });
});
