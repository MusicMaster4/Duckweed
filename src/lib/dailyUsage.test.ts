import { describe, expect, test } from "bun:test";

import {
  addFocusedUsage,
  clampDailyLimit,
  formatDailyLimit,
  formatUsageDuration,
  isDailyLimitReached,
  normalizeDailyUsage,
  remainingMinutesOf,
  rollDailyUsage,
  usedMinutesOf,
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
    // First minute is live in seconds so the meter does not look stuck at 0m.
    expect(formatUsageDuration(0)).toBe("0m");
    expect(formatUsageDuration(12_400)).toBe("12s");
    expect(formatUsageDuration(60_000)).toBe("1m");
    expect(formatDailyLimit(0)).toBe("0m");
  });

  test("pairs used and remaining whole minutes without a 29m cliff at 1s", () => {
    expect(usedMinutesOf(0)).toBe(0);
    expect(remainingMinutesOf(30, 0)).toBe(30);
    expect(usedMinutesOf(45_000)).toBe(0);
    expect(remainingMinutesOf(30, 45_000)).toBe(30);
    expect(usedMinutesOf(60_000)).toBe(1);
    expect(remainingMinutesOf(30, 60_000)).toBe(29);
  });
});
