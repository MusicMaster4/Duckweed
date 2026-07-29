import { describe, expect, test } from "bun:test";

import { goalAfterCommand, goalAfterProviderText } from "./goal";

describe("goal state normalization", () => {
  test("tracks provider-owned goal commands without changing status queries", () => {
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

  test("reads authoritative goal status replies from slash-command output", () => {
    expect(
      goalAfterProviderText(null, "Goal active.\nObjective: finish the migration"),
    ).toEqual({
      objective: "finish the migration",
      status: "active",
    });
    expect(
      goalAfterProviderText(
        { objective: "finish the migration", status: "active" },
        "Goal achieved.",
      ),
    ).toEqual({
      objective: "finish the migration",
      status: "complete",
    });
    expect(goalAfterProviderText(null, "No goal is set for this thread.")).toBeNull();
  });
});
