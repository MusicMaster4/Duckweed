import { describe, expect, test } from "bun:test";

import { canResume, timeAgo } from "./history";

describe("canResume", () => {
  test("covers the agents whose sessions can be found and continued", () => {
    expect(canResume("claude")).toBe(true);
    expect(canResume("codex")).toBe(true);
    expect(canResume("grok")).toBe(true);
    expect(canResume("opencode")).toBe(true);
    // Cursor Agent publishes neither a listing nor a store we can read, so it
    // must not offer a picker that would always be empty.
    expect(canResume("cursor")).toBe(false);
  });
});

describe("timeAgo", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const ago = (ms: number) => timeAgo(now - ms, now);

  test("reads as a glance, not a date", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(3 * 60_000)).toBe("3m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
    expect(ago(60 * 86_400_000)).toBe("2mo ago");
    expect(ago(400 * 86_400_000)).toBe("1y ago");
  });

  test("says nothing when the record carried no timestamp", () => {
    expect(timeAgo(0, now)).toBe("");
  });

  test("never reports a session as being from the future", () => {
    expect(timeAgo(now + 60_000, now)).toBe("just now");
  });
});
