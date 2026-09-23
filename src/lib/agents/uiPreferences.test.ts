import { describe, expect, test } from "bun:test";

import { agentUiPreferences } from "./uiPreferences";

describe("agentUiPreferences", () => {
  test("preserves the old all-on or all-off setting for every harness", () => {
    expect(Object.values(agentUiPreferences(true))).toEqual([true, true, true, true, true]);
    expect(Object.values(agentUiPreferences(false))).toEqual([false, false, false, false, false]);
  });

  test("keeps each saved choice and defaults missing or malformed entries on", () => {
    expect(agentUiPreferences({ claude: false, codex: true, cursor: "false" })).toEqual({
      claude: false,
      codex: true,
      cursor: true,
      grok: true,
      opencode: true,
    });
    expect(Object.values(agentUiPreferences())).toEqual([true, true, true, true, true]);
  });
});
