import { describe, expect, test } from "bun:test";
import { codexCapacityReplySettings, isCodexCapacityError } from "./capacityReply";

describe("Codex capacity reply preferences", () => {
  test("old saves and invalid values remain disabled", () => {
    for (const value of [undefined, null, false, {}, { enabled: "true", message: 42 }]) {
      expect(codexCapacityReplySettings(value)).toEqual({ enabled: false, message: "continue" });
    }
  });

  test("preserves explicit consent and the exact saved message, including blank messages", () => {
    for (const message of ["Keep going\nFinish the task.", ""]) {
      expect(codexCapacityReplySettings({ enabled: true, message })).toEqual({ enabled: true, message });
    }
  });

  test("matches the capacity error without treating other failures as capacity errors", () => {
    expect(isCodexCapacityError("Selected model is at capacity. Please try a different model.")).toBe(true);
    expect(isCodexCapacityError("SELECTED MODEL IS AT CAPACITY")).toBe(true);
    expect(isCodexCapacityError("You have reached your usage limit.")).toBe(false);
    expect(isCodexCapacityError("Rate limit exceeded")).toBe(false);
  });
});
