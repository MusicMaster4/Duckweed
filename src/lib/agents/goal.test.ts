import { describe, expect, test } from "bun:test";

import {
  goalAfterCommand,
  goalAfterProviderText,
  goalResponseFailed,
} from "./goal";

describe("goal state normalization", () => {
  test("tracks provider-owned commands without changing status queries", () => {
    expect(goalAfterCommand(null, "/goal ship the release")).toEqual({
      objective: "ship the release",
      status: "active",
    });
    expect(
      goalAfterCommand(
        { objective: "ship the release", status: "active" },
        "/goal pause",
      ),
    ).toEqual({ objective: "ship the release", status: "paused" });
    expect(
      goalAfterCommand(
        { objective: "ship the release", status: "paused" },
        "/goal resume",
      ),
    ).toEqual({ objective: "ship the release", status: "active" });
    expect(goalAfterCommand(null, "/goal status")).toBeUndefined();
    expect(goalAfterCommand(null, "/goal clear")).toBeNull();
  });

  test("reads structured and compact provider responses", () => {
    expect(
      goalAfterProviderText(null, "Goal active.\nObjective: finish the migration"),
    ).toEqual({
      objective: "finish the migration",
      status: "active",
    });
    expect(
      goalAfterProviderText(null, "Goal set: research only, no code changes"),
    ).toEqual({
      objective: "research only, no code changes",
      status: "active",
    });
    expect(goalAfterProviderText(null, "No goal is set for this thread.")).toBeNull();
  });

  test("recognizes a provider refusing the goal command", () => {
    expect(goalResponseFailed("Unknown command: /goal")).toBe(true);
    expect(goalResponseFailed("Goal set: inspect the repository")).toBe(false);
  });
});
