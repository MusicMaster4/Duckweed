import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// The module reaches for localStorage on import; give it somewhere to write.
globalThis.localStorage ??= {
  store: new Map<string, string>(),
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  },
  removeItem(key: string) {
    this.store.delete(key);
  },
} as unknown as Storage;

const usage = await import("./usage");

describe("usage formatting", () => {
  test("usage calendar labels always use English", () => {
    expect(usage.dayTick("2026-07-20")).toBe("Mon 20");
    expect(usage.dayFull("2026-07-20")).toBe("Monday, Jul 20");
  });

  test("compacts numbers at the thresholds people read", () => {
    expect(usage.compactNumber(0)).toBe("0");
    expect(usage.compactNumber(999)).toBe("999");
    expect(usage.compactNumber(1000)).toBe("1K");
    expect(usage.compactNumber(1240)).toBe("1.2K");
    expect(usage.compactNumber(12_400)).toBe("12K");
    expect(usage.compactNumber(1_240_000)).toBe("1.2M");
    expect(usage.compactNumber(35_984_934_797)).toBe("36B");
  });

  test("money never rounds a real cost away to zero", () => {
    expect(usage.formatUsd(0)).toBe("$0");
    // A tenth of a cent is not nothing, and must not print as $0.00.
    expect(usage.formatUsd(0.001)).toBe("<$0.01");
    expect(usage.formatUsd(12.5)).toBe("$12.50");
    expect(usage.formatUsd(6740.85)).toBe("$6.7K");
  });

  test("quota values are formatted in their own unit", () => {
    expect(usage.formatQuotaValue(47, "percent")).toBe("47%");
    expect(usage.formatQuotaValue(3.5, "usd")).toBe("$3.50");
    expect(usage.formatQuotaValue(1_500_000, "tokens")).toBe("1.5M");
  });

  test("separates open sessions from agent CLIs found in usage history", () => {
    expect(usage.agentTrackingSummary(3, 10)).toBe(
      "3 agent sessions open \u00b7 usage history found for 10 agent CLIs",
    );
    expect(usage.agentTrackingSummary(1, 1)).toBe(
      "1 agent session open \u00b7 usage history found for 1 agent CLI",
    );
  });

  test("quota remaining inverts utilization for the meter label", () => {
    expect(usage.quotaRemaining({ used: 2, limit: 100, percent: 2, unit: "percent" })).toBe(98);
    expect(usage.quotaRemaining({ used: 77, limit: 100, percent: 77, unit: "percent" })).toBe(23);
    expect(usage.quotaRemaining({ used: 100, limit: 100, percent: 100, unit: "percent" })).toBe(0);
    expect(usage.quotaRemaining({ used: 3.5, limit: 10, percent: 35, unit: "usd" })).toBe(6.5);
    expect(usage.quotaRemaining({ used: 500, limit: null, percent: 0, unit: "tokens" })).toBe(0);
  });

  test("run-out clocks read relative to today", () => {
    const now = new Date(2026, 6, 26, 14, 0, 0).getTime(); // local Jul 26 2pm
    expect(usage.formatEtaClock(now, now)).toBe("now");
    expect(usage.formatEtaClock(now + 60_000, now)).not.toBe("now");
    // Same calendar day → clock only
    const sameDay = new Date(2026, 6, 26, 18, 30, 0).getTime();
    expect(usage.formatEtaClock(sameDay, now).toLowerCase()).not.toContain("tomorrow");
    // Next day
    const tomorrow = new Date(2026, 6, 27, 9, 15, 0).getTime();
    expect(usage.formatEtaClock(tomorrow, now).toLowerCase()).toContain("tomorrow");
  });

  test("burn rates keep a decimal only while they are small", () => {
    expect(usage.formatPace(21.4)).toBe("21%/h");
    expect(usage.formatPace(2.5)).toBe("2.5%/h");
    expect(usage.formatPace(3.04)).toBe("3%/h");
    expect(usage.formatPace(0.4)).toBe("0.4%/h");
  });

  test("reset and last-used times read as prose", () => {
    const now = 1_000_000_000_000;
    expect(usage.untilReset(now - 1, now)).toBe("resetting");
    expect(usage.untilReset(now + 30 * 60_000, now)).toBe("in 30m");
    expect(usage.untilReset(now + 3 * 3_600_000 + 20 * 60_000, now)).toBe("in 3h 20m");
    expect(usage.untilReset(now + 50 * 3_600_000, now)).toBe("in 2d");

    expect(usage.relativeTime(now, now)).toBe("just now");
    expect(usage.relativeTime(now - 4 * 60_000, now)).toBe("4m ago");
    expect(usage.relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
  });
});

describe("quota forecasts", () => {
  const NOW = new Date(2026, 6, 26, 14, 0, 0).getTime();
  const HOUR = 3_600_000;
  const limit = (percent: number, resetsInHours: number | null, forecast: unknown = null) =>
    ({
      id: "five-hour",
      label: "5-hour limit",
      used: percent,
      limit: 100,
      percent,
      unit: "percent",
      resets_at: resetsInHours == null ? null : NOW + resetsInHours * HOUR,
      window_ms: 5 * HOUR,
      forecast,
    }) as Parameters<typeof usage.describeForecast>[0];

  test("a spent window does not repeat its reset time", () => {
    const copy = usage.describeForecast(
      limit(100, 2, { per_hour: 0, basis: "exhausted", runs_out_at: NOW, projected_percent: 100 }),
      NOW,
    );
    expect(copy.tone).toBe("critical");
    expect(copy.text).toBe("No quota left");
    expect(copy.detail).toBeNull();
  });

  test("a limit that empties before its reset reports one fixed duration", () => {
    // 40% left, burning 20%/h → 2h, an hour before the 3h reset.
    const copy = usage.describeForecast(
      limit(60, 3, {
        per_hour: 20,
        basis: "recent",
        runs_out_at: NOW + 2 * HOUR,
        projected_percent: 120,
      }),
      NOW,
    );
    expect(copy.tone).toBe("warning");
    expect(copy.text).toBe("2h left");
    expect(copy.detail).toBe("20%/h");
  });

  test("under an hour of allowance left is critical, not merely a warning", () => {
    const copy = usage.describeForecast(
      limit(90, 4, {
        per_hour: 20,
        basis: "recent",
        runs_out_at: NOW + 30 * 60_000,
        projected_percent: 170,
      }),
      NOW,
    );
    expect(copy.tone).toBe("critical");
  });

  test("a window that refills first says so, with where it lands", () => {
    const copy = usage.describeForecast(
      limit(50, 1, {
        per_hour: 10,
        basis: "recent",
        runs_out_at: NOW + 5 * HOUR,
        projected_percent: 60,
      }),
      NOW,
    );
    expect(copy.tone).toBe("ok");
    expect(copy.text).toBe("40% by reset");
  });

  test("a projection landing near the cap is flagged even though it holds", () => {
    const copy = usage.describeForecast(
      limit(80, 1, {
        per_hour: 15,
        basis: "recent",
        runs_out_at: NOW + 80 * 60_000,
        projected_percent: 95,
      }),
      NOW,
    );
    expect(copy.tone).toBe("warning");
    expect(copy.text).toBe("5% by reset");
  });

  test("a window average is labelled and never presented as a live countdown", () => {
    const copy = usage.describeForecast(
      limit(40, 1, {
        per_hour: 10,
        basis: "window",
        runs_out_at: NOW + 6 * HOUR,
        projected_percent: 50,
      }),
      NOW,
    );
    expect(copy.tone).toBe("muted");
    expect(copy.detail).toBe("10%/h window avg");
    expect(copy.text).toBe("60% left");
  });

  test("an averaged run-out does not claim the user is spending at that pace now", () => {
    const averaged = usage.describeForecast(
      limit(70, 4, {
        per_hour: 30,
        basis: "window",
        runs_out_at: NOW + HOUR,
        projected_percent: 190,
      }),
      NOW,
    );
    expect(averaged.text).toBe("30% left");
    expect(averaged.detail).toBe("30%/h window avg");
  });

  // A weekly limit burning hard right now really is running out faster — but
  // saying so as a date claims to know which days you work and how late.
  const weekly = (percent: number, resetsInHours: number, forecast: unknown) =>
    ({
      id: "seven-day",
      label: "7-day limit",
      used: percent,
      limit: 100,
      percent,
      unit: "percent",
      resets_at: NOW + resetsInHours * HOUR,
      window_ms: 7 * 24 * HOUR,
      forecast,
    }) as Parameters<typeof usage.describeForecast>[0];

  test("a long window uses the same time-left format", () => {
    const copy = usage.describeForecast(
      weekly(60, 96, {
        per_hour: 10,
        basis: "recent",
        confidence: 0.8,
        usage_hours_left: 4,
        // Four hours of work, but at a quarter duty that is sixteen on the
        // clock — still short of the reset, so the limit does bind.
        runs_out_at: NOW + 16 * HOUR,
        projected_percent: 100,
        duty: 0.25,
      }),
      NOW,
    );
    expect(copy.tone).toBe("warning");
    expect(copy.text).toBe("4h left");
    expect(copy.detail).toBe("10%/h");
  });

  test("a long window that outlasts its reset still shows the budget", () => {
    const copy = usage.describeForecast(
      weekly(30, 48, {
        per_hour: 2,
        basis: "recent",
        confidence: 0.9,
        usage_hours_left: 35,
        runs_out_at: NOW + 140 * HOUR,
        projected_percent: 55,
        duty: 0.3,
      }),
      NOW,
    );
    expect(copy.tone).toBe("ok");
    expect(copy.text).toBe("45% by reset");
    expect(copy.detail).toBe("2%/h");
  });

  test("hours of use left is critical once it is down to an afternoon", () => {
    const copy = usage.describeForecast(
      weekly(95, 72, {
        per_hour: 4,
        basis: "recent",
        confidence: 0.9,
        usage_hours_left: 1.25,
        runs_out_at: NOW + 5 * HOUR,
        projected_percent: 100,
        duty: 0.25,
      }),
      NOW,
    );
    expect(copy.tone).toBe("critical");
    expect(copy.text).toBe("1h 15m left");
  });

  // A five-hour window is short enough that use and clock are the same thing,
  // so it keeps the time you can plan an afternoon around.
  test("a short window reports the same fixed duration", () => {
    const copy = usage.describeForecast(
      limit(60, 3, {
        per_hour: 20,
        basis: "recent",
        confidence: 0.8,
        usage_hours_left: 2,
        runs_out_at: NOW + 2 * HOUR,
        projected_percent: 120,
        duty: null,
      }),
      NOW,
    );
    expect(copy.text).toBe("2h left");
  });

  test("a pace still being established omits redundant status copy", () => {
    const copy = usage.describeForecast(
      limit(50, 2, {
        per_hour: 21.4,
        basis: "blended",
        confidence: 0.3,
        usage_hours_left: 2.3,
        runs_out_at: NOW + 2.3 * HOUR,
        projected_percent: 93,
        duty: null,
      }),
      NOW,
    );
    expect(copy.detail).toBe("21%/h");
    expect(copy.text).toBe("7% by reset");
  });

  test("nothing to project from falls back to plain facts", () => {
    const untouched = usage.describeForecast(limit(0, 3), NOW);
    expect(untouched.text).toBe("Unused");
    expect(untouched.detail).toBeNull();

    const young = usage.describeForecast(limit(8, 4.9), NOW);
    expect(young.tone).toBe("muted");
    expect(young.text).toBe("92% left");
    expect(young.detail).toBeNull();
  });
});

describe("usage settings", () => {
  test("a missing or corrupt store falls back to the defaults", () => {
    globalThis.localStorage.removeItem("duckweed:usage:v1");
    expect(usage.loadSettings()).toEqual(usage.DEFAULT_SETTINGS);

    globalThis.localStorage.setItem("duckweed:usage:v1", "{not json");
    expect(usage.loadSettings()).toEqual(usage.DEFAULT_SETTINGS);
  });

  test("an unsupported range is rejected rather than sent to the backend", () => {
    usage.saveSettings({ ...usage.DEFAULT_SETTINGS, days: 4000 });
    expect(usage.loadSettings().days).toBe(7);
  });

  test("round-trips a real configuration", () => {
    const settings = { days: 30, metric: "tokens" } as const;
    usage.saveSettings(settings);
    expect(usage.loadSettings()).toEqual(settings);
  });

  test("migrates old agent choices and manual quotas away", () => {
    globalThis.localStorage.setItem(
      "duckweed:usage:v1",
      JSON.stringify({
        agents: ["claude"],
        days: 14,
        metric: "cost",
        quotas: [{ agent: "claude", limit: 5 }],
      }),
    );
    expect(usage.loadSettings()).toEqual({ days: 14, metric: "cost" });
  });
});

describe("usage series colours", () => {
  test("every agent the backend knows has a colour slot, and no slot is stale", () => {
    // A new agent added to the Rust scanner but not here would be charted with
    // no colour at all, so the two lists have to move together.
    const rust = read("src-tauri/src/usage/sources.rs");
    const ids = [...rust.matchAll(/^\s*id: "([a-z]+)",$/gm)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(5);
    expect(Object.keys(usage.AGENT_COLORS).sort()).toEqual([...ids].sort());
  });

  test("no two value-carrying agents share a slot", () => {
    const slots = Object.entries(usage.AGENT_COLORS)
      .filter(([, colour]) => colour !== "var(--viz-muted)")
      .map(([, colour]) => colour);
    expect(new Set(slots).size).toBe(slots.length);
  });

  test("an unknown agent gets the neutral, never an invented hue", () => {
    expect(usage.agentColor("some-future-cli")).toBe("var(--viz-muted)");
  });
});
