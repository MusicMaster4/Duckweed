import { describe, expect, test } from "bun:test";
import { desktopConnectionFailure } from "./codexDesktop";

describe("Codex desktop connection failures", () => {
  test.each([
    ["The browser access host is unavailable", "Browser control is not connected", true],
    ["Cannot authenticate the browser access response", "Browser control is not connected", true],
    ["Computer Use native pipe is unavailable: failed to connect native pipe: os error 2", "Computer Use is not connected", true],
    ["Local browser use is disabled in Work settings", "denied browser access for this account", false],
  ])("recognizes %s", (text, expected, reconnect) => {
    expect(desktopConnectionFailure({ server: "cua_repl", result: { content: [{ text }] } })).toEqual({
      message: expect.stringContaining(expected),
      reconnect,
    });
  });
  test("distinguishes a native browser URL policy stop from a missing connection", () => {
    const text = "Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy.";
    const failure = desktopConnectionFailure({ server: "node_repl", result: { isError: true, content: [{ text }] } });
    expect(failure?.message).toContain("could not verify the current browser URL");
    expect(failure?.reconnect).toBe(false);
  });
  test("does not misclassify unrelated MCP failures or page content", () => {
    expect(desktopConnectionFailure({ server: "cua_repl", result: { content: [{ text: "Page not found" }] } })).toBeNull();
    expect(desktopConnectionFailure({ server: "github", error: { message: "The browser access host is unavailable" } })).toBeNull();
  });
});
