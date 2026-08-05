import { describe, expect, test } from "bun:test";

import { isAuthenticationFailure, nativeAuthCommand } from "./auth";

describe("agent authentication", () => {
  test("routes every supported agent through its native CLI", () => {
    expect(nativeAuthCommand("claude", "login")).toBe("claude auth login");
    expect(nativeAuthCommand("codex", "logout")).toBe("codex logout");
    expect(nativeAuthCommand("cursor", "login")).toBe("cursor-agent login");
    expect(nativeAuthCommand("grok", "logout")).toBe("grok logout");
    expect(nativeAuthCommand("opencode", "login")).toBe("opencode providers login");
  });

  test("recognizes auth failures without swallowing ordinary errors", () => {
    expect(isAuthenticationFailure("Not authenticated")).toBe(true);
    expect(isAuthenticationFailure("401 Unauthorized: Missing bearer token")).toBe(true);
    expect(isAuthenticationFailure("Please run /login to continue")).toBe(true);
    expect(isAuthenticationFailure("The model is temporarily overloaded")).toBe(false);
    expect(isAuthenticationFailure("Permission denied while reading package.json")).toBe(false);
  });
});
