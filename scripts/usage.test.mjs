import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

// The module reaches for localStorage on import; give it somewhere to write.
globalThis.localStorage ??= {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
  removeItem(key) {
    this.store.delete(key);
  },
};

const usage = await import("../src/lib/usage.ts");

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

  test("quota remaining inverts utilization for the meter label", () => {
    expect(
      usage.quotaRemaining({ used: 2, limit: 100, percent: 2, unit: "percent" }),
    ).toBe(98);
    expect(
      usage.quotaRemaining({ used: 77, limit: 100, percent: 77, unit: "percent" }),
    ).toBe(23);
    expect(
      usage.quotaRemaining({ used: 100, limit: 100, percent: 100, unit: "percent" }),
    ).toBe(0);
    expect(
      usage.quotaRemaining({ used: 3.5, limit: 10, percent: 35, unit: "usd" }),
    ).toBe(6.5);
    expect(
      usage.quotaRemaining({ used: 500, limit: null, percent: 0, unit: "tokens" }),
    ).toBe(0);
  });

  test("run-out clocks read relative to today", () => {
    const now = new Date(2026, 6, 26, 14, 0, 0).getTime(); // local Jul 26 2pm
    expect(usage.formatEtaClock(now, now)).toBe("now");
    expect(usage.formatEtaClock(now + 60_000, now)).not.toBe("now");
    // Same calendar day → clock only
    const sameDay = new Date(2026, 6, 26, 18, 30, 0).getTime();
    const same = usage.formatEtaClock(sameDay, now);
    expect(same.toLowerCase()).not.toContain("tomorrow");
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
  const limit = (percent, resetsInHours, forecast = null) => ({
    id: "five-hour",
    label: "5-hour limit",
    used: percent,
    limit: 100,
    percent,
    unit: "percent",
    resets_at: resetsInHours == null ? null : NOW + resetsInHours * HOUR,
    window_ms: 5 * HOUR,
    forecast,
  });

  test("a spent window says when it comes back, not how fast it went", () => {
    const copy = usage.describeForecast(
      limit(100, 2, { per_hour: 0, basis: "exhausted", runs_out_at: NOW, projected_percent: 100 }),
      NOW,
    );
    expect(copy.tone).toBe("critical");
    expect(copy.text).toBe("Spent for this window");
    expect(copy.detail).toBe("back in 2h");
  });

  test("a limit that empties before its reset reports the clock and the gap", () => {
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
    expect(copy.text).toContain("Runs out");
    expect(copy.text).toContain("1h before reset");
    expect(copy.detail).toBe("burning 20%/h");
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
    expect(copy.text).toBe("Resets first, at about 60% used");
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
    expect(copy.text).toContain("95% used");
  });

  // The old panel printed "stable" here, which told you nothing at all.
  test("an idle hour still reports the window's own average pace", () => {
    const copy = usage.describeForecast(
      limit(40, 1, {
        per_hour: 10,
        basis: "window",
        runs_out_at: NOW + 6 * HOUR,
        projected_percent: 50,
      }),
      NOW,
    );
    expect(copy.detail).toBe("10%/h average, idle this hour");
    expect(copy.text).toContain("Resets first");
  });

  test("an averaged run-out is hedged, a live one is not", () => {
    const averaged = usage.describeForecast(
      limit(70, 4, {
        per_hour: 30,
        basis: "window",
        runs_out_at: NOW + HOUR,
        projected_percent: 190,
      }),
      NOW,
    );
    expect(averaged.text.startsWith("Would run out")).toBe(true);
  });

  test("nothing to project from falls back to plain facts", () => {
    const untouched = usage.describeForecast(limit(0, 3), NOW);
    expect(untouched.text).toBe("Untouched this window");
    expect(untouched.detail).toBe("resets in 3h");

    const young = usage.describeForecast(limit(8, 4.9), NOW);
    expect(young.tone).toBe("muted");
    expect(young.text).toBe("8% used so far");
    expect(young.detail).toBe("not enough history to project a pace");
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
    const settings = {
      days: 30,
      metric: "tokens",
    };
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
  test("every agent the backend knows has a colour slot", () => {
    const rust = read("src-tauri/src/usage/sources.rs");
    const ids = [...rust.matchAll(/^\s{8}id: "([a-z]+)",$/gm)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(usage.AGENT_COLORS[id]).toBeDefined();
    }
    // And nothing stale in the other direction.
    expect(Object.keys(usage.AGENT_COLORS).sort()).toEqual([...ids].sort());
  });

  test("no two value-carrying agents share a slot", () => {
    const slots = Object.entries(usage.AGENT_COLORS)
      .filter(([, colour]) => colour !== "var(--viz-muted)")
      .map(([, colour]) => colour);
    expect(new Set(slots).size).toBe(slots.length);
  });

  test("the palette is defined once, in the stylesheet", () => {
    const css = read("src/styles.css");
    // The slots the palette validator was run against; changing a hex here
    // without re-running it breaks the colour-blind separation guarantee.
    for (const hex of [
      "#3987e5",
      "#d95926",
      "#199e70",
      "#c98500",
      "#d55181",
      "#008300",
      "#9085e9",
      "#e66767",
      "#1599b0",
    ]) {
      expect(css).toContain(hex);
    }
  });

  test("an unknown agent gets the neutral, never an invented hue", () => {
    expect(usage.agentColor("some-future-cli")).toBe("var(--viz-muted)");
  });
});

describe("usage wiring", () => {
  test("the scan commands are registered with tauri", () => {
    const main = read("src-tauri/src/main.rs");
    for (const command of ["usage_scan", "usage_pricing", "usage_set_pricing"]) {
      expect(main).toContain(`async fn ${command}`);
      // Present in the invoke_handler list, not just defined.
      expect(main).toMatch(new RegExp(`^\\s+${command},$`, "m"));
    }
    expect(main).toContain("UsageState::default()");
  });

  test("the dashboard is its own settings section, not part of General", () => {
    const settings = read("src/components/SettingsMenu.tsx");
    expect(settings).toContain('"Usage"');
    expect(settings).toContain('const showUsage = section === "Usage" && !searching;');
  });

  test("usage preloads on Settings entry but never during app startup", () => {
    const app = read("src/App.tsx");
    expect(app.match(/prefetchUsage/g)?.length).toBe(2);
    expect(app).toContain("prefetchUsage(loadUsageSettings().days, 60_000)");
    const settings = read("src/components/SettingsMenu.tsx");
    expect(settings).toContain("{showUsage && <UsagePanel />}");
    const panel = read("src/components/UsagePanel.tsx");
    expect(panel).toContain("prefetchUsage(days");
    const usageLib = read("src/lib/usage.ts");
    expect(usageLib).toContain("const pendingScans = new Map");
    expect(usageLib).toContain("let scanQueue");
  });

  test("tracking and quota ceilings require no manual configuration", () => {
    const panel = read("src/components/UsagePanel.tsx");
    expect(panel).not.toContain("Tracked agents");
    expect(panel).not.toContain("Set a limit");
    expect(panel).toContain("Automatically tracking");
    expect(panel).not.toContain("usage-badge");

    const backend = read("src-tauri/src/usage/mod.rs");
    expect(backend).not.toContain("pub agents: Vec<String>");
    expect(backend).not.toContain("QuotaConfig");
  });

  test("Claude quota uses its official OAuth session without owning refresh tokens", () => {
    const quota = read("src-tauri/src/usage/quota.rs");
    expect(quota).toContain("https://api.anthropic.com/api/oauth/usage");
    expect(quota).toContain(".claude/.credentials.json");
    expect(quota).toContain("CLAUDE_CACHE_TTL");
    expect(quota).not.toContain('rename = "refreshToken"');
  });

  test("charts ship a table view and a legend", () => {
    const charts = read("src/components/UsageCharts.tsx");
    expect(charts).toContain("export function TableView");
    expect(charts).toContain("export function Legend");
    const panel = read("src/components/UsagePanel.tsx");
    expect(panel).toContain("<TableView");
    expect(panel).toContain("<Legend");
  });
});
