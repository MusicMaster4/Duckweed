import { describe, expect, test } from "bun:test";

import {
  formatCountdown,
  nextTiming,
  secondsLeft,
  type PowerWatchPhase,
  type PowerWatchState,
} from "./powerWatch";

const GRACE = 120_000;

const at = (phase: PowerWatchPhase, firesAt: number | null = null) => ({
  phase,
  firesAt,
  graceMs: GRACE,
});

describe("nextTiming", () => {
  test("an armed watch with work left stays armed", () => {
    expect(nextTiming(at("armed"), true, 1_000)).toEqual({ phase: "armed", firesAt: null });
  });

  test("quiet starts the countdown one full grace period out", () => {
    expect(nextTiming(at("armed"), false, 1_000)).toEqual({
      phase: "countdown",
      firesAt: 1_000 + GRACE,
    });
  });

  test("the countdown holds while it runs", () => {
    expect(nextTiming(at("countdown", 100_000), false, 50_000)).toEqual({
      phase: "countdown",
      firesAt: 100_000,
    });
  });

  test("fires the moment the deadline is reached", () => {
    expect(nextTiming(at("countdown", 100_000), false, 100_000).phase).toBe("firing");
  });

  test("work starting cancels the countdown outright", () => {
    expect(nextTiming(at("countdown", 100_000), true, 50_000)).toEqual({
      phase: "armed",
      firesAt: null,
    });
  });

  test("quiet has to hold for the whole period, so an interruption restarts it", () => {
    // A pane going quiet, then busy again a second later, then quiet: the
    // second countdown must be a fresh grace period, not the remains of the
    // first. This is the gap between two agent turns.
    const started = nextTiming(at("armed"), false, 0);
    const interrupted = nextTiming({ ...started, graceMs: GRACE }, true, 1_000);
    const restarted = nextTiming({ ...interrupted, graceMs: GRACE }, false, 2_000);
    expect(restarted.firesAt).toBe(2_000 + GRACE);
    expect(nextTiming({ ...restarted, graceMs: GRACE }, false, started.firesAt ?? 0).phase).toBe(
      "countdown",
    );
  });

  test("phases that are not waiting on anything are left alone", () => {
    for (const phase of ["off", "firing", "failed"] as const) {
      expect(nextTiming(at(phase), false, 999_999)).toEqual({ phase, firesAt: null });
    }
  });
});

describe("countdown readout", () => {
  const state = (firesAt: number | null): PowerWatchState => ({
    action: "suspend",
    phase: "countdown",
    graceMs: GRACE,
    firesAt,
    busy: [],
    error: null,
  });

  test("rounds up so the last second is shown rather than skipped", () => {
    expect(secondsLeft(state(10_000), 8_500)).toBe(2);
  });

  test("never goes below zero, or reports time with no deadline", () => {
    expect(secondsLeft(state(10_000), 30_000)).toBe(0);
    expect(secondsLeft(state(null), 0)).toBe(0);
  });

  test("formats as m:ss", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(75)).toBe("1:15");
    expect(formatCountdown(900)).toBe("15:00");
  });
});
