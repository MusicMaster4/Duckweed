import { describe, expect, test } from "bun:test";

import { AGENT_IDS } from "./catalog";
import { canResume } from "./history";
import {
  fallbackCommands,
  fallbackModels,
  formatSessionUsage,
  GUIDED_ARG_COMMANDS,
  isNewChatCommand,
  mergeCommands,
} from "./slashCatalog";
import { effortsFor, shortModelLabel } from "./types";

describe("slashCatalog", () => {
  test("every agent has at least /model in its fallback commands", () => {
    for (const agent of ["claude", "codex", "grok", "opencode", "cursor"] as const) {
      expect(fallbackCommands(agent).some((command) => command.name === "/model")).toBe(true);
    }
  });

  test("every agent exposes native logout", () => {
    for (const agent of AGENT_IDS) {
      const names = fallbackCommands(agent).map((command) => command.name);
      expect(names).toContain("/logout");
      expect(names).not.toContain("/login");
    }
  });

  test("offers app-owned /usage to every agent", () => {
    for (const agent of ["claude", "codex", "grok", "opencode", "cursor"] as const) {
      expect(fallbackCommands(agent).some((command) => command.name === "/usage")).toBe(true);
    }
  });

  test("offers app-owned /new to every custom agent", () => {
    for (const agent of ["claude", "codex", "grok", "opencode", "cursor"] as const) {
      const commands = fallbackCommands(agent);
      expect(commands.some((command) => command.name === "/new")).toBe(true);
      expect(
        commands.filter((command) => command.name.startsWith("/n")).map((command) => command.name),
      ).toContain("/new");
    }
    expect(fallbackCommands("claude", "claudex").some((command) => command.name === "/new")).toBe(
      true,
    );
  });

  test("offers /goal only where the harness can dispatch it", () => {
    expect(fallbackCommands("codex").some((command) => command.name === "/goal")).toBe(true);
    expect(fallbackCommands("claude").some((command) => command.name === "/goal")).toBe(true);
    for (const agent of ["grok", "opencode", "cursor"] as const) {
      expect(fallbackCommands(agent).some((command) => command.name === "/goal")).toBe(false);
    }

    // ACP has no standard goal RPC. A compatible harness advertises the
    // command live, at which point the shared composer exposes it.
    expect(
      mergeCommands(fallbackCommands("grok"), [
        { name: "/goal", description: "Manage a long-running goal" },
      ]).find((command) => command.name === "/goal"),
    ).toEqual({ name: "/goal", description: "Manage a long-running goal" });
  });

  test("accepts /n as a direct new-chat alias", () => {
    expect(isNewChatCommand("/new")).toBe(true);
    expect(isNewChatCommand("/NEW ")).toBe(true);
    expect(isNewChatCommand("/n")).toBe(true);
    expect(isNewChatCommand("/next")).toBe(false);
  });

  test("formats partial and empty usage without depending on a CLI", () => {
    expect(
      formatSessionUsage({
        inputTokens: 12_400,
        outputTokens: 600,
        contextUsed: 0.42,
        costUsd: 0.091,
      }),
    ).toBe("Usage this session · 12.4k input · 600 output · 13.0k total · 42% context · $0.09");
    expect(
      formatSessionUsage({
        inputTokens: 0,
        outputTokens: 0,
        contextUsed: null,
        costUsd: null,
      }),
    ).toContain("no token data");
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

  test("claudex seeds proxy models instead of Anthropic aliases", () => {
    const models = fallbackModels("claude", "claudex");
    const ids = models.map((model) => model.id);
    expect(ids).toEqual(["gpt-5.6-sol", "grok-4.5", "or/selected"]);
    expect(ids).not.toContain("opus");
    expect(ids).not.toContain("sonnet");
    // Same Claude effort surface — Claudex enables effort on the wrapped CLI.
    expect(models[0].efforts).toEqual(
      expect.arrayContaining(["low", "medium", "high", "xhigh", "max", "auto"]),
    );
    expect(
      fallbackCommands("claude", "claudex").find((command) => command.name === "/resume")
        ?.description,
    ).toContain("Claudex");
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
    expect(shortModelLabel("grok-4.5")).toBe("Grok 4.5");
    expect(shortModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(shortModelLabel("or/selected")).toBe("OpenRouter");
  });
});
