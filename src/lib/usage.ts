import { invoke } from "@tauri-apps/api/core";
import { saveDurably } from "./durableStorage";

/**
 * Token and cost statistics gathered from the coding agents installed on this
 * machine. The Rust side owns the scanning and the arithmetic; this module is
 * the shape of what it returns, plus the formatting the dashboard needs.
 */

export interface Tokens {
  /** Fresh input, excluding anything served from cache. */
  input: number;
  /** Generated output, excluding reasoning. */
  output: number;
  /** Thinking tokens, where the agent reports them apart from output. */
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

/** Tokens plus what they came to. Flattened into every summary below. */
export interface Totals extends Tokens {
  cost: number;
  requests: number;
}

export interface AgentSlice extends Totals {
  agent: string;
}

export interface DaySeries extends Totals {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  agents: AgentSlice[];
}

export interface AgentSummary extends Totals {
  id: string;
  label: string;
  vendor: string;
  /** Whether any data files were found for it. */
  installed: boolean;
  files: number;
  /** False for agents that log activity but no token counts. */
  tracks_tokens: boolean;
  /** Why this agent's numbers are less than complete, when they are. */
  caveat: string | null;
  last_used: number | null;
}

export interface ModelSummary extends Totals {
  model: string;
  agent: string;
  /** False when no rate is known, so the cost shown is zero, not cheap. */
  priced: boolean;
}

/** Where a limit is heading, measured against its own reset. */
export interface QuotaForecast {
  /** Utilization points consumed per hour of continued use. */
  per_hour: number;
  /**
   * `recent` from the sample history, `window` from the average since the
   * window opened, `blended` when a thin recent measurement was shrunk toward
   * that average, `exhausted` when there is nothing left to burn.
   */
  basis: "recent" | "blended" | "window" | "exhausted";
  /** 0–1: how much of `per_hour` the live measurement actually set. */
  confidence: number;
  /**
   * Hours of further use the remaining allowance buys. The honest form of the
   * answer for a long window, where a wall-clock date implies days of
   * uninterrupted work.
   */
  usage_hours_left: number | null;
  /** Epoch ms this limit would hit 100%; null when the pace never gets there. */
  runs_out_at: number | null;
  /** Utilization projected for the moment the window resets. */
  projected_percent: number | null;
  /** Active share of the clock applied to the projection, when one was. */
  duty: number | null;
}

export interface QuotaLimit {
  id: string;
  label: string;
  used: number;
  /** Null when the provider gives a percentage and no denominator. */
  limit: number | null;
  percent: number;
  unit: "tokens" | "usd" | "percent";
  resets_at: number | null;
  /** Length of the quota window, when the provider implies one. */
  window_ms: number | null;
  /** Null when there is not enough history or window to project from. */
  forecast: QuotaForecast | null;
}

export interface Quota {
  agent: string;
  label: string;
  /** Only provider-persisted limits are metered. */
  source: "reported" | "unavailable";
  plan: string | null;
  /** Why a trustworthy provider limit cannot be shown. */
  message: string | null;
  limits: QuotaLimit[];
}

export interface ScanStats {
  files_seen: number;
  /** Files actually opened; the rest were served from the index. */
  files_read: number;
  bytes_read: number;
  duration_ms: number;
}

export interface Snapshot {
  generated_at: number;
  range_days: number;
  totals: Totals;
  days: DaySeries[];
  agents: AgentSummary[];
  models: ModelSummary[];
  quotas: Quota[];
  /** Models seen with no entry in the price table. */
  unpriced: string[];
  scan: ScanStats;
}

export interface UsageQuery {
  days: number;
  /** Re-stat every file rather than trusting the in-memory index. */
  refresh: boolean;
}

export interface Rates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export type PriceOverrides = Record<string, Rates>;

/**
 * Read every agent's transcripts and summarize them. The first call builds an
 * index and can take a moment; later calls only re-read files that changed.
 */
export const usageScan = (query: UsageQuery) => invoke<Snapshot>("usage_scan", { query });

interface CachedSnapshot {
  value: Snapshot;
  cachedAt: number;
}

const snapshotCache = new Map<number, CachedSnapshot>();
const pendingScans = new Map<number, Promise<Snapshot>>();
let scanQueue: Promise<void> = Promise.resolve();
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 60_000;

/** A ready snapshot lets the Usage tab paint without a loading screen. */
export function cachedUsage(days: number): Snapshot | null {
  return snapshotCache.get(days)?.value ?? null;
}

/**
 * Warm the incremental transcript index without blocking the current view.
 *
 * Calls are coalesced by range and serialized across ranges because the Rust
 * scanner owns one shared index. A warm pass stats files but opens only those
 * whose size or modification time changed.
 */
export function prefetchUsage(
  days: number,
  maxAgeMs = DEFAULT_SNAPSHOT_MAX_AGE_MS,
): Promise<Snapshot> {
  const cached = snapshotCache.get(days);
  if (cached && Date.now() - cached.cachedAt <= maxAgeMs) {
    return Promise.resolve(cached.value);
  }
  const pending = pendingScans.get(days);
  if (pending) return pending;

  const task = scanQueue.then(() => usageScan({ days, refresh: false }));
  scanQueue = task.then(
    () => undefined,
    () => undefined,
  );
  pendingScans.set(days, task);
  void task.then(
    (value) => {
      snapshotCache.set(days, { value, cachedAt: Date.now() });
      if (pendingScans.get(days) === task) pendingScans.delete(days);
    },
    () => {
      if (pendingScans.get(days) === task) pendingScans.delete(days);
    },
  );
  return task;
}

/** Saved rate overrides, plus the model names the built-in table covers. */
export const usagePricing = () => invoke<[string[], PriceOverrides]>("usage_pricing");

export const usageSetPricing = (overrides: PriceOverrides) =>
  invoke<void>("usage_set_pricing", { overrides });

// ---------------------------------------------------------------- colours

/**
 * One fixed hue per agent, assigned by position and never by rank — a filter
 * that hides an agent must not repaint the others.
 *
 * These are categorical slots stepped for a dark surface. The order
 * is the colour-blind-safety mechanism: every adjacent pair clears the CVD and
 * normal-vision separation floors against this app's panel background, which
 * is what makes a stacked column readable. Reordering them breaks that, so
 * don't — add new agents at the end.
 */
export const AGENT_COLORS: Record<string, string> = {
  claude: "var(--viz-1)",
  codex: "var(--viz-2)",
  gemini: "var(--viz-3)",
  opencode: "var(--viz-4)",
  grok: "var(--viz-5)",
  droid: "var(--viz-6)",
  kilocode: "var(--viz-7)",
  kimi: "var(--viz-8)",
  pi: "var(--viz-9)",
  claudex: "var(--viz-10)",
  // Activity-only, so it never appears in a value chart and needs no hue.
  antigravity: "var(--viz-muted)",
};

export const agentColor = (id: string) => AGENT_COLORS[id] ?? "var(--viz-muted)";

// ---------------------------------------------------------------- format

/** `1284` / `12.9K` / `4.2M` — compact enough for an axis or a stat tile. */
export function compactNumber(value: number): string {
  const n = Math.abs(value);
  if (n < 1000) return String(Math.round(value));
  if (n < 1_000_000) return `${trim(value / 1000)}K`;
  if (n < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  if (n < 1_000_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  return `${trim(value / 1_000_000_000_000)}T`;
}

function trim(value: number): string {
  // One decimal below 10 keeps 1.2K distinct from 1.9K; above it the digit is
  // noise.
  return Math.abs(value) < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return "<$0.01";
  if (Math.abs(value) < 1000) return `$${value.toFixed(2)}`;
  return `$${compactNumber(value)}`;
}

/**
 * Money for an axis tick. Cents on a gridline are noise — the tick exists to
 * say roughly how tall the bar is, and the tooltip carries the real figure.
 */
export function formatUsdAxis(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) < 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) < 1000) return `$${Math.round(value)}`;
  return `$${compactNumber(value)}`;
}

export const formatTokens = (value: number) => compactNumber(value);

/** Full precision, for tooltips and tables where the exact figure matters. */
export const formatExact = (value: number) => value.toLocaleString();

const USAGE_DATE_LOCALE = "en-US";

/** `Mon 21` — an axis tick for a daily series. */
export function dayTick(date: string): string {
  const parsed = parseDay(date);
  if (!parsed) return date;
  const weekday = parsed.toLocaleDateString(USAGE_DATE_LOCALE, { weekday: "short" });
  return `${weekday} ${parsed.getDate()}`;
}

export function dayFull(date: string): string {
  const parsed = parseDay(date);
  if (!parsed) return date;
  const weekday = parsed.toLocaleDateString(USAGE_DATE_LOCALE, { weekday: "long" });
  const month = parsed.toLocaleDateString(USAGE_DATE_LOCALE, { month: "short" });
  return `${weekday}, ${month} ${parsed.getDate()}`;
}

function parseDay(date: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  // Construct in local time; the backend already bucketed by local midnight.
  return new Date(year, month - 1, day);
}

/** `3h 20m` / `2d` — a duration, at the precision people actually plan by. */
export function formatSpan(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

/** `in 3h 20m` / `in 2d` — how long until a quota window resets. */
export function untilReset(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "resetting";
  return `in ${formatSpan(ms)}`;
}

/** `4m ago` / `yesterday` — when an agent last ran. */
export function relativeTime(at: number, now: number): string {
  const ms = now - at;
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

/** The unit a quota bar is measured in, spelled out for a label. */
export function formatQuotaValue(value: number, unit: QuotaLimit["unit"]): string {
  if (unit === "usd") return formatUsd(value);
  if (unit === "percent") return `${Math.round(value)}%`;
  return compactNumber(value);
}

/**
 * How much of a quota window is still available, in the same unit as `used`.
 * Both the meter label and the bar use remaining (drains toward empty).
 */
export function quotaRemaining(
  limit: Pick<QuotaLimit, "used" | "limit" | "percent" | "unit">,
): number {
  if (limit.unit === "percent") {
    return Math.max(0, Math.min(100, 100 - limit.percent));
  }
  if (limit.limit != null) {
    return Math.max(0, limit.limit - limit.used);
  }
  return 0;
}

/**
 * When a limit is expected to empty, as a clock time rather than a countdown:
 * "4:40 PM" is something you can plan a session around, "in 2h 37m" is not.
 */
export function formatEtaClock(at: number, now: number): string {
  if (at <= now + 30_000) return "now";
  const date = new Date(at);
  const clock = date.toLocaleTimeString(USAGE_DATE_LOCALE, {
    hour: "numeric",
    minute: "2-digit",
  });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTarget = new Date(at);
  startOfTarget.setHours(0, 0, 0, 0);
  const dayDelta = Math.round(
    (startOfTarget.getTime() - startOfToday.getTime()) / 86_400_000,
  );
  if (dayDelta === 0) return clock;
  if (dayDelta === 1) return `tomorrow ${clock}`;
  if (dayDelta > 1 && dayDelta < 7) {
    const weekday = date.toLocaleDateString(USAGE_DATE_LOCALE, { weekday: "short" });
    return `${weekday} ${clock}`;
  }
  const day = date.toLocaleDateString(USAGE_DATE_LOCALE, {
    month: "short",
    day: "numeric",
  });
  return `${day}, ${clock}`;
}

/** `21%/h` — a burn rate, kept to one significant decimal while it is small. */
export function formatPace(perHour: number): string {
  if (perHour >= 10) return `${Math.round(perHour)}%/h`;
  if (perHour >= 1) return `${perHour.toFixed(1).replace(/\.0$/, "")}%/h`;
  return `${perHour.toFixed(1)}%/h`;
}

/** Severity of a forecast, so the colour is never the only signal. */
export type ForecastTone = "critical" | "warning" | "ok" | "muted";

export interface ForecastCopy {
  tone: ForecastTone;
  /** The short forecast shown below the bar. */
  text: string;
  /** Current consumption pace, shown dimmed after the forecast. */
  detail: string | null;
}

/** Keep the secondary line consistent; the forecast is already understood as an estimate. */
function describePace(forecast: QuotaForecast): string {
  return formatPace(forecast.per_hour);
}

/**
 * The line under a quota bar.
 *
 * Forecasts use one compact format across all window sizes: time left if the
 * quota runs out first, otherwise the share still left when the window resets.
 */
export function describeForecast(limit: QuotaLimit, now: number): ForecastCopy {
  const { forecast, resets_at: resets } = limit;

  if (forecast?.basis === "exhausted" || limit.percent >= 99.5) {
    return { tone: "critical", text: "No quota left", detail: null };
  }

  if (!forecast) {
    if (limit.percent <= 0) {
      return { tone: "ok", text: "Unused", detail: null };
    }
    return {
      tone: "muted",
      text: `${Math.round(Math.max(0, 100 - limit.percent))}% left`,
      detail: null,
    };
  }

  const pace = describePace(forecast);
  const runsOut = forecast.runs_out_at;

  if (runsOut != null && (resets == null || runsOut < resets)) {
    const usageTimeLeft =
      forecast.usage_hours_left != null ? forecast.usage_hours_left * 3_600_000 : null;
    const timeLeft = usageTimeLeft ?? runsOut - now;
    return {
      tone:
        usageTimeLeft != null
          ? usageTimeLeft <= 2 * 3_600_000
            ? "critical"
            : "warning"
          : runsOut - now <= 3_600_000
            ? "critical"
            : "warning",
      text: `${formatSpan(timeLeft)} left`,
      detail: pace,
    };
  }

  const projected = forecast.projected_percent;
  if (projected == null) {
    return { tone: "ok", text: "Within limit", detail: pace };
  }
  // The bar and its value both read as quota *left*, so the forecast has to
  // land on the same scale — `projected_percent` is utilization.
  const leftAtReset = Math.min(100, Math.max(0, 100 - projected));
  return {
    tone: leftAtReset <= 10 ? "warning" : "ok",
    text: `${Math.round(leftAtReset)}% by reset`,
    detail: pace,
  };
}

// ---------------------------------------------------------------- settings

const KEY = "duckweed:usage:v1";

export type Metric = "cost" | "tokens";

export interface UsageSettings {
  /** Length of the daily series. */
  days: number;
  /** Whether the charts plot money or tokens. */
  metric: Metric;
}

export const DEFAULT_SETTINGS: UsageSettings = {
  days: 7,
  metric: "cost",
};

export const RANGES = [7, 14, 30, 90];

export function loadSettings(): UsageSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<UsageSettings>;
    return {
      days: RANGES.includes(parsed.days as number) ? (parsed.days as number) : 7,
      metric: parsed.metric === "tokens" ? "tokens" : "cost",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UsageSettings): void {
  try {
    const raw = JSON.stringify(settings);
    localStorage.setItem(KEY, raw);
    saveDurably(KEY, raw);
  } catch {
    // Storage can be unavailable; the dashboard still works, it just forgets.
  }
}
