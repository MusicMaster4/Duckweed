import { saveDurably } from "./durableStorage";

export const DAILY_USAGE_KEY = "duckweed:wellbeing:v1";
export const DEFAULT_DAILY_LIMIT_MINUTES = 4 * 60;
export const MIN_DAILY_LIMIT_MINUTES = 30;
export const MAX_DAILY_LIMIT_MINUTES = 24 * 60;

export interface DailyUsageState {
  version: 1;
  enabled: boolean;
  limitMinutes: number;
  day: string;
  usedMs: number;
}

export function localDayKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function clampDailyLimit(minutes: number): number {
  const stepped = Math.round(minutes / 30) * 30;
  return Math.min(
    MAX_DAILY_LIMIT_MINUTES,
    Math.max(MIN_DAILY_LIMIT_MINUTES, stepped),
  );
}

export function freshDailyUsage(now = new Date()): DailyUsageState {
  return {
    version: 1,
    enabled: false,
    limitMinutes: DEFAULT_DAILY_LIMIT_MINUTES,
    day: localDayKey(now),
    usedMs: 0,
  };
}

export function normalizeDailyUsage(
  candidate: unknown,
  now = new Date(),
): DailyUsageState {
  const fallback = freshDailyUsage(now);
  if (!candidate || typeof candidate !== "object") return fallback;
  const value = candidate as Partial<DailyUsageState>;
  const currentDay = localDayKey(now);
  return {
    version: 1,
    enabled: value.enabled === true,
    limitMinutes:
      typeof value.limitMinutes === "number"
        ? clampDailyLimit(value.limitMinutes)
        : fallback.limitMinutes,
    day: currentDay,
    usedMs:
      value.day === currentDay && typeof value.usedMs === "number"
        ? Math.max(0, Math.floor(value.usedMs))
        : 0,
  };
}

export function loadDailyUsage(now = new Date()): DailyUsageState {
  try {
    const raw = localStorage.getItem(DAILY_USAGE_KEY);
    return normalizeDailyUsage(raw ? JSON.parse(raw) : null, now);
  } catch {
    return freshDailyUsage(now);
  }
}

export function saveDailyUsage(state: DailyUsageState): void {
  try {
    const raw = JSON.stringify(state);
    localStorage.setItem(DAILY_USAGE_KEY, raw);
    saveDurably(DAILY_USAGE_KEY, raw);
  } catch {
    // Wellbeing remains useful for this session when storage is unavailable.
  }
}

export function rollDailyUsage(
  state: DailyUsageState,
  now = new Date(),
): DailyUsageState {
  const day = localDayKey(now);
  return state.day === day ? state : { ...state, day, usedMs: 0 };
}

export function addFocusedUsage(
  state: DailyUsageState,
  elapsedMs: number,
): DailyUsageState {
  if (!state.enabled || elapsedMs <= 0 || isDailyLimitReached(state)) return state;
  const limitMs = state.limitMinutes * 60_000;
  return {
    ...state,
    usedMs: Math.min(limitMs, state.usedMs + elapsedMs),
  };
}

export function isDailyLimitReached(state: DailyUsageState): boolean {
  return state.enabled && state.usedMs >= state.limitMinutes * 60_000;
}

export function formatUsageDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatDailyLimit(minutes: number): string {
  return formatUsageDuration(minutes * 60_000);
}
