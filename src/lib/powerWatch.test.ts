import { afterEach, describe, expect, test } from "bun:test";

import {
  arm,
  connect,
  formatCountdown,
  getState,
  nextTiming,
  poll,
  resetForTests,
  secondsLeft,
  setIncludeScheduledMessages,
  type PowerWatchBusyEntry,
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

describe("scheduled messages", () => {
  const scheduled: PowerWatchBusyEntry = {
    termId: "terminal",
    label: "Terminal",
    reason: "scheduled-message",
  };

  afterEach(() => resetForTests());

  test("ignores a pending message by default and checks it when the option changes", () => {
    resetForTests({ phase: "armed" });
    connect({
      probe: (includeScheduledMessages) => includeScheduledMessages ? [scheduled] : [],
      fire: async () => {},
    });

    poll(0);
    expect(getState().phase).toBe("countdown");

    setIncludeScheduledMessages(true);
    expect(getState()).toMatchObject({ phase: "armed", firesAt: null, busy: [scheduled] });

    setIncludeScheduledMessages(false);
    expect(getState()).toMatchObject({ phase: "countdown", busy: [] });
  });

  test("waits for delivery and then for the agent before starting a full quiet period", async () => {
    resetForTests({ phase: "armed", includeScheduledMessages: true, action: "shutdown" });
    let pending = true;
    let running = false;
    const fired: string[] = [];
    connect({
      probe: (includeScheduledMessages) => {
        if (running) return [{ ...scheduled, reason: "agent-working" }];
        return includeScheduledMessages && pending ? [scheduled] : [];
      },
      fire: async (action) => { fired.push(action); },
    });

    poll(0);
    poll(GRACE);
    expect(getState().phase).toBe("armed");

    pending = false;
    running = true;
    poll(2 * GRACE);
    expect(getState()).toMatchObject({ phase: "armed", busy: [{ reason: "agent-working" }] });

    running = false;
    poll(3 * GRACE);
    expect(getState()).toMatchObject({ phase: "countdown", firesAt: 4 * GRACE });
    poll(4 * GRACE - 1);
    expect(fired).toEqual([]);
    poll(4 * GRACE);
    expect(fired).toEqual(["shutdown"]);
    await Promise.resolve();
  });
});

describe("countdown readout", () => {
  const state = (firesAt: number | null): PowerWatchState => ({
    action: "suspend",
    phase: "countdown",
    graceMs: GRACE,
    includeScheduledMessages: false,
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


describe("subagents", () => {
  afterEach(() => resetForTests());

  test("stays armed while subagents are working and counts down once they finish", () => {
    let subagentsActive = true;
    const fired: string[] = [];
    resetForTests({ graceMs: 60_000 });
    const disconnect = connect({
      probe: () =>
        subagentsActive
          ? [{ termId: "t1", label: "Tab 1 · Claude", reason: "agent-subagents" }]
          : [],
      fire: async (action) => {
        fired.push(action);
      },
    });
    try {
      arm();
      poll(1_000);
      expect(getState().phase).toBe("armed");
      expect(getState().busy[0]?.reason).toBe("agent-subagents");

      subagentsActive = false;
      poll(2_000);
      expect(getState().phase).toBe("countdown");
      expect(getState().firesAt).toBe(62_000);

      poll(62_000);
      expect(fired).toEqual(["suspend"]);
    } finally {
      disconnect();
    }
  });
});
