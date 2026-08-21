import { describe, expect, test } from "bun:test";

import { agentSpawnEnv } from "./catalog";

describe("agentSpawnEnv", () => {
  test("passes the caller's env through without inventing GROK_CONFIG", () => {
    expect(agentSpawnEnv({})).toBeNull();
    expect(agentSpawnEnv({ FOO: "bar" })).toEqual({ FOO: "bar" });
  });

  test("does not overlay Grok follow_up_behavior on GROK_CONFIG", () => {
    const existing = JSON.stringify({
      ui: { screen_mode: "minimal" },
      features: { lsp_tools: true },
    });
    const env = agentSpawnEnv({
      XAI_API_KEY: "secret",
      GROK_CONFIG: existing,
    });
    expect(env).toEqual({
      XAI_API_KEY: "secret",
      GROK_CONFIG: existing,
    });
    expect(JSON.parse(env!.GROK_CONFIG)).toEqual({
      ui: { screen_mode: "minimal" },
      features: { lsp_tools: true },
    });
  });
});
