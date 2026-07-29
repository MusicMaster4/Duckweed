import { describe, expect, test } from "bun:test";

import { appCanCountUsage } from "./useDailyUsage";
import type { DailyUsageState } from "../lib/dailyUsage";

function state(partial: Partial<DailyUsageState> = {}): DailyUsageState {
  return {
    version: 1,
    enabled: true,
    limitMinutes: 30,
    day: "2026-07-29",
    usedMs: 0,
    ...partial,
  };
}

describe("appCanCountUsage", () => {
  test("requires the limit to be enabled and not yet reached", () => {
    expect(appCanCountUsage(state({ enabled: false }), true)).toBe(false);
    expect(
      appCanCountUsage(state({ usedMs: 30 * 60_000 }), true),
    ).toBe(false);
  });

  test("counts when the OS window is focused", () => {
    expect(appCanCountUsage(state(), true)).toBe(true);
  });

  test("does not count when the window is unfocused and document is unavailable", () => {
    // Node/bun unit tests have no DOM; the production path falls back to
    // document.hasFocus() only when a document exists.
    expect(appCanCountUsage(state(), false)).toBe(false);
  });
});
