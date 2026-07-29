import { describe, expect, test } from "bun:test";

import {
  addFocusedUsage,
  clampDailyLimit,
  formatDailyLimit,
  formatUsageDuration,
  isDailyLimitReached,
  normalizeDailyUsage,
  rollDailyUsage,
} from "./dailyUsage";

const TODAY = new Date(2026, 6, 29, 10, 30);

describe("daily usage wellbeing", () => {
  test("restores today's focused time and resets an older day", () => {
    const today = normalizeDailyUsage(
      {
        enabled: true,
        limitMinutes: 120,
        day: "2026-07-29",
        usedMs: 45 * 60_000,
      },
      TODAY,
    );
    expect(today.usedMs).toBe(45 * 60_000);

    const rolled = rollDailyUsage(today, new Date(2026, 6, 30, 0, 0, 1));
    expect(rolled.day).toBe("2026-07-30");
    expect(rolled.usedMs).toBe(0);
    expect(rolled.enabled).toBe(true);
  });

  test("caps focused time at the configured limit", () => {
    const state = normalizeDailyUsage(
      {
        enabled: true,
        limitMinutes: 60,
        day: "2026-07-29",
        usedMs: 59 * 60_000,
      },
      TODAY,
    );
    const reached = addFocusedUsage(state, 2 * 60_000);
    expect(reached.usedMs).toBe(60 * 60_000);
    expect(isDailyLimitReached(reached)).toBe(true);
  });

  test("uses half-hour steps and readable durations", () => {
    expect(clampDailyLimit(74)).toBe(60);
    expect(clampDailyLimit(76)).toBe(90);
    expect(formatDailyLimit(90)).toBe("1h 30m");
    expect(formatUsageDuration(4 * 60_000 + 59_000)).toBe("4m");
  });
});
