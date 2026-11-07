import { describe, expect, test } from "bun:test";
import {
  automaticApprovalDeadline, automaticApprovalSetting, hasPendingAutomaticApproval, startAutomaticApprovals,
  type AutomaticApproval,
} from "./automaticApproval";
import type { AgentPermission } from "./types";

const prompt = (id = "p1"): AgentPermission => ({
  id, kind: "approval", title: "Run command", detail: null, command: "example", changes: [],
  options: [
    { id: "deny", label: "Deny", kind: "reject" },
    { id: "always", label: "Always allow", kind: "allow-always" },
    { id: "allow", label: "Allow", kind: "allow" },
  ],
});

function harness(initial: AutomaticApproval = "until-disabled") {
  let now = 100_000;
  let setting = initial;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const sessions = new Map<string, { permission: AgentPermission | null }>();
  const subscribers = new Set<() => void>();
  const responses: string[][] = [];
  const emit = () => { for (const callback of [...subscribers]) callback(); };
  const source = {
    activeTermIds: () => [...sessions.keys()],
    get: (id: string) => sessions.get(id),
    subscribeAll: (callback: () => void) => {
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    },
    respond: (...args: string[]) => { responses.push(args); emit(); },
  };
  const start = () => startAutomaticApprovals(source, () => setting, {
    now: () => now,
    schedule: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => { timers.delete(id as unknown as number); },
  });
  const tick = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  };
  return { sessions, subscribers, responses, timers, emit, start, tick,
    setSetting: (value: AutomaticApproval) => { setting = value; } };
}

describe("automatic approval lifetime", () => {
  test("supports both timed options and indefinite access", () => {
    expect(automaticApprovalDeadline("1-hour", 1_000)).toBe(3_601_000);
    expect(automaticApprovalDeadline("10-hours", 1_000)).toBe(36_001_000);
    expect(automaticApprovalDeadline("until-disabled", 1_000)).toBe("until-disabled");
  });
  test("restores unexpired deadlines without restarting the duration", () => {
    const saved = automaticApprovalDeadline("1-hour", 1_000);
    expect(automaticApprovalSetting(saved, 3_600_999)).toBe(saved);
    expect(automaticApprovalSetting(saved, 3_601_000)).toBeNull();
    expect(automaticApprovalSetting(saved, 4_000_000)).toBeNull();
    expect(automaticApprovalSetting("until-disabled", 4_000_000)).toBe("until-disabled");
  });
  test("missing, disabled, and malformed saves default to off", () => {
    for (const value of [undefined, null, true, false, {}, "true", 0, NaN, Infinity]) {
      expect(automaticApprovalSetting(value, 100_000)).toBeNull();
    }
  });
});

describe("delayed approvals across sessions", () => {
  test("approves existing and new prompts after exactly one second, only once", () => {
    const h = harness();
    h.sessions.set("hidden-tab", { permission: prompt() });
    const stop = h.start();
    h.tick(999);
    h.emit(); // Unrelated stream updates must not reset the delay.
    expect(h.responses).toEqual([]);
    h.tick(1);
    h.emit();
    h.tick(5_000);
    expect(h.responses).toEqual([["hidden-tab", "p1", "allow"]]);
    h.sessions.set("another-tab", { permission: prompt("p2") });
    h.emit();
    h.tick(1_000);
    expect(h.responses[1]).toEqual(["another-tab", "p2", "allow"]);
    stop();
  });
  test("manual responses, closed sessions, and replaced prompts cancel stale approvals", () => {
    const h = harness();
    for (const id of ["manual", "closed", "replaced"]) h.sessions.set(id, { permission: prompt() });
    const stop = h.start();
    h.tick(500);
    h.sessions.get("manual")!.permission = null;
    h.sessions.delete("closed");
    h.sessions.get("replaced")!.permission = prompt("new");
    h.emit();
    h.tick(500);
    expect(h.responses).toEqual([]);
    h.tick(500);
    expect(h.responses).toEqual([["replaced", "new", "allow"]]);
    stop();
  });
  test("disabling and expiry are rechecked even without a session event", () => {
    for (const deadline of [null, 100_500]) {
      const h = harness();
      h.sessions.set("tab", { permission: prompt() });
      const stop = h.start();
      h.setSetting(deadline);
      h.tick(1_000);
      expect(h.responses).toEqual([]);
      stop();
    }
  });
  test("cleanup cancels queued work and removes the subscription", () => {
    const h = harness();
    h.sessions.set("tab", { permission: prompt() });
    const stop = h.start();
    stop();
    h.tick(1_000);
    expect(h.responses).toEqual([]);
    expect(h.timers.size).toBe(0);
    expect(h.subscribers.size).toBe(0);
  });
  test("leaves questions and reject-only decisions for the user", () => {
    const h = harness();
    h.sessions.set("question", { permission: { ...prompt(), kind: "question" } });
    h.sessions.set("reject", { permission: { ...prompt(), options: [prompt().options[0]] } });
    const stop = h.start();
    h.tick(1_000);
    expect(h.responses).toEqual([]);
    stop();
  });
  test("disabled or expired settings never schedule approvals", () => {
    for (const setting of [null, 99_999]) {
      const h = harness(setting);
      h.sessions.set("tab", { permission: prompt() });
      const stop = h.start();
      expect(h.timers.size).toBe(0);
      stop();
    }
  });
});

describe("automatic permission notification suppression", () => {
  const now = 100_000;
  const waiting = () => ({ status: "waiting" as const, permission: prompt() });

  test("silences approval prompts with active timed or indefinite access", () => {
    for (const setting of [now + 1, "until-disabled"] as const) {
      expect(hasPendingAutomaticApproval(waiting(), setting, now)).toBe(true);
    }
    const always = { ...prompt(), options: [prompt().options[1]] };
    expect(hasPendingAutomaticApproval({ status: "waiting", permission: always }, "until-disabled", now)).toBe(true);
  });

  test("keeps permission notifications when disabled or expired", () => {
    for (const setting of [null, now - 1, now]) {
      expect(hasPendingAutomaticApproval(waiting(), setting, now)).toBe(false);
    }
  });

  test("keeps questions and requests without an affirmative option visible", () => {
    for (const permission of [
      { ...prompt(), kind: "question" as const },
      { ...prompt(), options: [prompt().options[0]] },
      null,
    ]) {
      expect(hasPendingAutomaticApproval({ status: "waiting", permission }, "until-disabled", now)).toBe(false);
    }
  });

  test("keeps completion, error, exit, and terminal-only notifications", () => {
    for (const status of ["idle", "working", "error", "exited"] as const) {
      expect(hasPendingAutomaticApproval({ status, permission: null }, "until-disabled", now)).toBe(false);
    }
    expect(hasPendingAutomaticApproval(null, "until-disabled", now)).toBe(false);
    expect(hasPendingAutomaticApproval(undefined, "until-disabled", now)).toBe(false);
  });
});
