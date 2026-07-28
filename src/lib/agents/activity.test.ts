import { describe, expect, test } from "bun:test";

import { agentHasUnfinishedWork } from "./activity";

describe("agent close activity", () => {
  test("warns while an agent turn is unfinished", () => {
    expect(agentHasUnfinishedWork("starting")).toBe(true);
    expect(agentHasUnfinishedWork("working")).toBe(true);
    expect(agentHasUnfinishedWork("waiting")).toBe(true);
  });

  test("does not warn after the agent has finished working", () => {
    expect(agentHasUnfinishedWork("idle")).toBe(false);
    expect(agentHasUnfinishedWork("exited")).toBe(false);
    expect(agentHasUnfinishedWork("error")).toBe(false);
  });
});
