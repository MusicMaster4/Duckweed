import { describe, expect, test } from "bun:test";

import { shouldNavigatePromptHistory } from "./textareaCaret";

describe("prompt history arrow navigation", () => {
  test("starts history only when ArrowUp is pressed on the first visual line", () => {
    expect(shouldNavigatePromptHistory("ArrowUp", false, true)).toBe(true);
    expect(shouldNavigatePromptHistory("ArrowUp", false, false)).toBe(false);
  });

  test("leaves ArrowDown native until history browsing starts", () => {
    expect(shouldNavigatePromptHistory("ArrowDown", false, true)).toBe(false);
    expect(shouldNavigatePromptHistory("ArrowDown", false, false)).toBe(false);
  });

  test("uses both arrows to walk history and return to the saved draft", () => {
    expect(shouldNavigatePromptHistory("ArrowUp", true, false)).toBe(true);
    expect(shouldNavigatePromptHistory("ArrowDown", true, false)).toBe(true);
  });
});
