import { useCallback, useEffect, useRef, useState } from "react";

import {
  DAILY_USAGE_KEY,
  addFocusedUsage,
  clampDailyLimit,
  isDailyLimitReached,
  loadDailyUsage,
  normalizeDailyUsage,
  rollDailyUsage,
  saveDailyUsage,
  type DailyUsageState,
} from "../lib/dailyUsage";

const SAMPLE_INTERVAL_MS = 1_000;
const MAX_FOCUSED_SAMPLE_MS = 5_000;
const PERSIST_INTERVAL_MS = 15_000;

function appCanCountUsage(state: DailyUsageState): boolean {
  return (
    state.enabled &&
    !isDailyLimitReached(state) &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

export interface DailyUsageController {
  state: DailyUsageState;
  locked: boolean;
  setEnabled: (enabled: boolean) => void;
  setLimitMinutes: (minutes: number) => void;
}

/**
 * Counts deliberate, focused Duckweed time. Minimized/background time and long
 * timer gaps caused by sleep are excluded, while the local calendar day rolls
 * over without requiring an app restart.
 */
export function useDailyUsage(): DailyUsageController {
  const [state, setState] = useState(() => loadDailyUsage());
  const stateRef = useRef(state);
  stateRef.current = state;
  const sampleRef = useRef({
    at: Date.now(),
    active: appCanCountUsage(state),
  });
  const lastPersistedAtRef = useRef(Date.now());

  const commit = useCallback((next: DailyUsageState, persist: boolean) => {
    const previous = stateRef.current;
    stateRef.current = next;
    if (
      previous.enabled !== next.enabled ||
      previous.limitMinutes !== next.limitMinutes ||
      previous.day !== next.day ||
      previous.usedMs !== next.usedMs
    ) {
      setState(next);
    }
    if (persist) {
      lastPersistedAtRef.current = Date.now();
      saveDailyUsage(next);
    }
  }, []);

  const sample = useCallback(
    (forcePersist = false) => {
      const nowMs = Date.now();
      const previousSample = sampleRef.current;
      let next = rollDailyUsage(stateRef.current, new Date(nowMs));
      if (previousSample.active && next.day === stateRef.current.day) {
        const elapsed = Math.min(
          MAX_FOCUSED_SAMPLE_MS,
          Math.max(0, nowMs - previousSample.at),
        );
        next = addFocusedUsage(next, elapsed);
      }
      sampleRef.current = {
        at: nowMs,
        active: appCanCountUsage(next),
      };
      const shouldPersist =
        forcePersist || nowMs - lastPersistedAtRef.current >= PERSIST_INTERVAL_MS;
      commit(next, shouldPersist);
    },
    [commit],
  );

  useEffect(() => {
    const timer = window.setInterval(() => sample(), SAMPLE_INTERVAL_MS);
    const settle = () => sample(true);
    const syncWindow = (event: StorageEvent) => {
      if (event.key !== DAILY_USAGE_KEY || !event.newValue) return;
      try {
        const incoming = normalizeDailyUsage(JSON.parse(event.newValue));
        const current = rollDailyUsage(stateRef.current);
        const next = {
          ...incoming,
          // Only one window can be focused, but their storage events can cross
          // in either order. Never let an older snapshot erase counted time.
          usedMs: Math.max(current.usedMs, incoming.usedMs),
        };
        sampleRef.current = { at: Date.now(), active: appCanCountUsage(next) };
        commit(next, false);
      } catch {
        // Ignore a partial or corrupt write from another window.
      }
    };
    window.addEventListener("focus", settle);
    window.addEventListener("blur", settle);
    window.addEventListener("storage", syncWindow);
    document.addEventListener("visibilitychange", settle);
    window.addEventListener("pagehide", settle);
    window.addEventListener("beforeunload", settle);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", settle);
      window.removeEventListener("blur", settle);
      window.removeEventListener("storage", syncWindow);
      document.removeEventListener("visibilitychange", settle);
      window.removeEventListener("pagehide", settle);
      window.removeEventListener("beforeunload", settle);
    };
  }, [sample]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      sample();
      const next = { ...stateRef.current, enabled };
      sampleRef.current = { at: Date.now(), active: appCanCountUsage(next) };
      commit(next, true);
    },
    [commit, sample],
  );

  const setLimitMinutes = useCallback(
    (minutes: number) => {
      sample();
      const next = {
        ...stateRef.current,
        limitMinutes: clampDailyLimit(minutes),
      };
      sampleRef.current = { at: Date.now(), active: appCanCountUsage(next) };
      commit(next, true);
    },
    [commit, sample],
  );

  return {
    state,
    locked: isDailyLimitReached(state),
    setEnabled,
    setLimitMinutes,
  };
}
