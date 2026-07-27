import { describe, expect, test } from "bun:test";

import { fallbackCommands, fallbackModels, GUIDED_ARG_COMMANDS } from "./slashCatalog";
import { effortsFor, shortModelLabel } from "./types";

describe("slashCatalog", () => {
  test("every agent has at least /model in its fallback commands", () => {
    for (const agent of ["claude", "codex", "grok", "opencode", "cursor"] as const) {
      expect(fallbackCommands(agent).some((command) => command.name === "/model")).toBe(true);
    }
  });

  test("claude seeds switchable models so the picker works before init", () => {
    const models = fallbackModels("claude");
    expect(models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(models[0].efforts).toContain("high");
    expect(fallbackModels("codex")).toEqual([]);
  });

  test("guided arg commands are exactly model and effort", () => {
    expect([...GUIDED_ARG_COMMANDS].sort()).toEqual(["/effort", "/model"]);
  });
});

describe("effortsFor / shortModelLabel", () => {
  test("prefers the active model's efforts, then the union", () => {
    const models = [
      { id: "a", label: "A", efforts: ["low", "high"] },
      { id: "b", label: "B", efforts: ["medium"] },
    ];
    expect(effortsFor({ model: "a", models })).toEqual(["low", "high"]);
    expect(effortsFor({ model: null, models })).toEqual(["low", "high", "medium"]);
    expect(effortsFor({ model: "missing", models: [] })).toEqual([]);
  });

  test("shortens provider-prefixed model ids", () => {
    expect(shortModelLabel("opencode/claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(shortModelLabel("grok-4.5")).toBe("grok-4.5");
  });
});
