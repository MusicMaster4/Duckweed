import { describe, expect, test } from "bun:test";

import { canResume } from "./history";
import { fallbackCommands, fallbackModels, GUIDED_ARG_COMMANDS } from "./slashCatalog";
import { effortsFor, shortModelLabel } from "./types";

describe("slashCatalog", () => {
  test("every agent has at least /model in its fallback commands", () => {
    for (const agent of ["claude", "codex", "grok", "opencode", "cursor"] as const) {
      expect(fallbackCommands(agent).some((command) => command.name === "/model")).toBe(true);
    }
  });

  test("claude seeds the real CLI model aliases and effort levels", () => {
    const models = fallbackModels("claude");
    expect(models.map((model) => model.id)).toContain("opus[1m]");
    expect(models.map((model) => model.id)).toContain("fable");
    expect(models.map((model) => model.id)).toContain("default");
    expect(models[0].efforts).toEqual(
      expect.arrayContaining(["low", "medium", "high", "xhigh", "max", "auto", "ultracode"]),
    );
    expect(fallbackModels("codex")).toEqual([]);
  });

  test("guided arg commands are exactly model and effort", () => {
    expect([...GUIDED_ARG_COMMANDS].sort()).toEqual(["/effort", "/model"]);
  });

  test("/resume is offered exactly where a session can be found and resumed", () => {
    for (const agent of ["claude", "codex", "grok", "opencode", "cursor"] as const) {
      const has = fallbackCommands(agent).some((command) => command.name === "/resume");
      expect(has).toBe(canResume(agent));
    }
  });

  test("a pane only ever sees its own agent's commands", () => {
    // The failure this guards against is a Grok pane offering to resume a
    // Claude session: the command would either fail or be chatted to the model.
    const grok = fallbackCommands("grok").map((command) => command.name);
    const claude = fallbackCommands("claude").map((command) => command.name);
    expect(grok).toContain("/session-info");
    expect(claude).not.toContain("/session-info");
    expect(claude).toContain("/init");
    expect(grok).not.toContain("/init");
    // Descriptions name the agent whose sessions they list, for the same reason.
    const resume = fallbackCommands("grok").find((command) => command.name === "/resume");
    expect(resume?.description).toContain("Grok Build");
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

  test("shortens provider-prefixed and Claude model ids", () => {
    expect(shortModelLabel("opencode/claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(shortModelLabel("claude-opus-5[1m]")).toBe("Opus 5 (1M)");
    expect(shortModelLabel("grok-4.5")).toBe("grok 4.5");
  });
});
