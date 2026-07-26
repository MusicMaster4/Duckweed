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

  test("transcripts are prefetched on startup and whenever Settings opens", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("prefetchUsage(loadUsageSettings().days)");
    expect(app).toContain("prefetchUsage(loadUsageSettings().days, 0)");
    const usageLib = read("src/lib/usage.ts");
    expect(usageLib).toContain("const pendingScans = new Map");
    expect(usageLib).toContain("let scanQueue");
  });

  test("tracking and quota ceilings require no manual configuration", () => {
    const panel = read("src/components/UsagePanel.tsx");
    expect(panel).not.toContain("Tracked agents");
    expect(panel).not.toContain("Set a limit");
    expect(panel).toContain("Automatically tracking");
    expect(panel).toContain("quota.source === \"reported\" ? \"Reported\" : \"Unavailable\"");

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
