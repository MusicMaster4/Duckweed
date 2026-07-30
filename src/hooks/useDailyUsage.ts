import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
const TAURI_RUNTIME = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Whether the app is in the foreground enough to count as focused use.
 *
 * Prefer the last OS window-focus signal (kept in `windowFocused`). DOM
 * `document.hasFocus()` is only a fallback: on WebView2/Tauri it can stay
 * false after alt-tab or titlebar clicks even while Duckweed is frontmost.
 */
export function appCanCountUsage(
  state: DailyUsageState,
  windowFocused: boolean,
): boolean {
  if (!state.enabled || isDailyLimitReached(state)) return false;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return false;
  }
  if (windowFocused) return true;
  return typeof document !== "undefined" && document.hasFocus();
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
  // Seed from the DOM; Tauri's isFocused()/onFocusChanged correct this ASAP.
  const windowFocusedRef = useRef(
    typeof document !== "undefined" ? document.hasFocus() : false,
  );
  const sampleRef = useRef({
    at: Date.now(),
    active: appCanCountUsage(state, windowFocusedRef.current),
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
        active: appCanCountUsage(next, windowFocusedRef.current),
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
    const markFocused = (focused: boolean) => {
      if (windowFocusedRef.current === focused) {
        // Still re-sample: visibility may have changed without a focus flip.
        settle();
        return;
      }
      windowFocusedRef.current = focused;
      settle();
    };
    const onWindowFocus = () => markFocused(true);
    const onWindowBlur = () => markFocused(false);
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
        sampleRef.current = {
          at: Date.now(),
          active: appCanCountUsage(next, windowFocusedRef.current),
        };
        commit(next, false);
      } catch {
        // Ignore a partial or corrupt write from another window.
      }
    };
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("storage", syncWindow);
    document.addEventListener("visibilitychange", settle);
    window.addEventListener("pagehide", settle);
    window.addEventListener("beforeunload", settle);

    let cancelled = false;
    let unlistenFocus: (() => void) | undefined;
    if (TAURI_RUNTIME) {
      const win = getCurrentWindow();
      void win
        .isFocused()
        .then((focused) => {
          if (!cancelled) markFocused(focused);
        })
        .catch(() => {
          // Fall back to DOM focus events already wired above.
        });
      void win
        .onFocusChanged((event) => {
          if (!cancelled) markFocused(event.payload);
        })
        .then((off) => {
          if (cancelled) off();
          else unlistenFocus = off;
        })
        .catch(() => {
          // Older/unavailable window APIs: DOM focus is enough.
        });
    }

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("storage", syncWindow);
      document.removeEventListener("visibilitychange", settle);
      window.removeEventListener("pagehide", settle);
      window.removeEventListener("beforeunload", settle);
      unlistenFocus?.();
    };
  }, [sample, commit]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      sample();
      const next = { ...stateRef.current, enabled };
      sampleRef.current = {
        at: Date.now(),
        active: appCanCountUsage(next, windowFocusedRef.current),
      };
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
      sampleRef.current = {
        at: Date.now(),
        active: appCanCountUsage(next, windowFocusedRef.current),
      };
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
