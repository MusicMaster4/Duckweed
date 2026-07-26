import { invoke } from "@tauri-apps/api/core";

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

export interface QuotaLimit {
  id: string;
  label: string;
  used: number;
  /** Null when the provider gives a percentage and no denominator. */
  limit: number | null;
  percent: number;
  unit: "tokens" | "usd" | "percent";
  resets_at: number | null;
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
export function prefetchUsage(days: number, maxAgeMs = 15_000): Promise<Snapshot> {
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

/** `Mon 21` — an axis tick for a daily series. */
export function dayTick(date: string): string {
  const parsed = parseDay(date);
  if (!parsed) return date;
  return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

export function dayFull(date: string): string {
  const parsed = parseDay(date);
  if (!parsed) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function parseDay(date: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  // Construct in local time; the backend already bucketed by local midnight.
  return new Date(year, month - 1, day);
}

/** `in 3h 20m` / `in 2d` — how long until a quota window resets. */
export function untilReset(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "resetting";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `in ${days}d`;
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
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable; the dashboard still works, it just forgets.
  }
}
