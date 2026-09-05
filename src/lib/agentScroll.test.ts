import { describe, expect, test } from "bun:test";

import {
  distanceFromBottom,
  isAtScrollBottom,
  shouldShowJumpToBottom,
  syncObservedChildren,
} from "./agentScroll";

describe("agent surface scrolling", () => {
  const metrics = (scrollTop: number, scrollHeight = 1_000, clientHeight = 500) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  test("measures distance from the visible bottom", () => {
    expect(distanceFromBottom(metrics(420))).toBe(80);
    expect(distanceFromBottom(metrics(520))).toBe(0);
  });

  test("keeps following within the bottom tolerance", () => {
    expect(isAtScrollBottom(metrics(482))).toBe(true);
    expect(isAtScrollBottom(metrics(481))).toBe(false);
  });

  test("only shows the jump control after a deliberate, meaningful scroll away", () => {
    expect(shouldShowJumpToBottom(metrics(350), false)).toBe(false);
    expect(shouldShowJumpToBottom(metrics(420), true)).toBe(false);
    expect(shouldShowJumpToBottom(metrics(350), true)).toBe(true);
  });

  test("never shows the jump control when the transcript does not overflow", () => {
    expect(shouldShowJumpToBottom(metrics(0, 400, 500), true)).toBe(false);
  });

  test("unobserves transcript roots removed during subagent navigation", () => {
    const parent = { id: "parent" };
    const child = { id: "child" };
    const observed = new Set([parent]);
    const calls: string[] = [];
    const observer = {
      observe: (target: { id: string }) => calls.push(`observe:${target.id}`),
      unobserve: (target: { id: string }) => calls.push(`unobserve:${target.id}`),
    };

    syncObservedChildren(observer, observed, [child]);

    expect(calls).toEqual(["unobserve:parent", "observe:child"]);
    expect([...observed]).toEqual([child]);
  });
});
