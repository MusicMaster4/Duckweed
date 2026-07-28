import type { AgentId, AgentModelChoice, AgentUsage } from "./types";

const LOCAL_COMMANDS = [
  {
    name: "/new",
    description: "Start a new chat with this agent",
  },
  {
    name: "/usage",
    description: "Show token, cost, and context usage reported for this session",
  },
] as const;

/**
 * Static slash-command catalogs, one per agent.
 *
 * These exist because no protocol advertises its commands eagerly enough:
 * Claude's `system/init` only lands with the first turn, Codex's app-server
 * has no command list at all, and an ACP agent's `available_commands_update`
 * trails the handshake. The composer needs a useful answer for `/` the
 * moment the session is ready, so each agent starts from this list and the
 * live advertisements merge over it (see {@link mergeCommands}).
 *
 * Only commands the session can actually dispatch belong here — either the
 * protocol carries them (Claude interprets slash text itself, ACP agents
 * intercept advertised names), the adapter wires them to an RPC (`/model`,
 * `/effort`, `/compact`), or the app answers them itself (`/resume`, which
 * opens the session picker and never reaches the agent). Names verified
 * against the installed CLIs (claude 2.1, codex 0.145, grok 0.2.112,
 * opencode 1.18).
 *
 * The lists are per agent on purpose: a pane running Grok must offer Grok's
 * commands and nothing else, because a command from another CLI either fails
 * or, worse, is chatted to the model at full price.
 */
const FALLBACKS: Record<AgentId, { name: string; description: string }[]> = {
  claude: [
    { name: "/resume", description: "Continue a past Claude Code session in this folder" },
    { name: "/model", description: "Change the model for this session" },
    { name: "/effort", description: "Set effort: low, medium, high, xhigh, max, auto" },
    { name: "/compact", description: "Compact the conversation to free context" },
    { name: "/clear", description: "Clear the conversation" },
    { name: "/context", description: "Show context window usage" },
    { name: "/review", description: "Review a pull request or change" },
    { name: "/init", description: "Create or refresh the project memory file" },
    { name: "/mcp", description: "Manage MCP servers" },
    { name: "/agents", description: "Manage subagents" },
    { name: "/config", description: "Open configuration" },
    { name: "/rename", description: "Rename this session" },
    { name: "/doctor", description: "Diagnose the installation" },
    { name: "/help", description: "Show help" },
  ],
  codex: [
    { name: "/resume", description: "Continue a past Codex thread in this folder" },
    { name: "/model", description: "Change the model for later turns" },
    { name: "/effort", description: "Set reasoning effort for later turns" },
    { name: "/compact", description: "Compact the conversation to free context" },
  ],
  grok: [
    { name: "/resume", description: "Continue a past Grok Build session in this folder" },
    { name: "/model", description: "Change the model for this session" },
    { name: "/effort", description: "Set reasoning effort: low, medium, high" },
    { name: "/compact", description: "Compress conversation history" },
    { name: "/context", description: "Show context window usage and session stats" },
    { name: "/session-info", description: "Show session details" },
  ],
  opencode: [
    { name: "/resume", description: "Continue a past OpenCode session in this folder" },
    { name: "/model", description: "Change the model for this session" },
    { name: "/effort", description: "Set thinking effort for the current model" },
    { name: "/compact", description: "Compact the conversation to free context" },
  ],
  cursor: [{ name: "/model", description: "Change the model for this session" }],
};

/**
 * Claude's stream-json init never lists switchable models, only the one in
 * use. These aliases are exactly what bare `/model` advertises (verified
 * against claude 2.1.220): short names, 1M variants, and plan-gated extras.
 *
 * Effort levels match `/effort` usage plus `ultracode` (needs dynamic
 * workflows / plan — still listed so the picker mirrors the CLI; rejected
 * levels surface as a notice rather than vanishing from the UI).
 */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto", "ultracode"];
const CLAUDE_MODELS: AgentModelChoice[] = [
  { id: "default", label: "Default (recommended)", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", label: "Sonnet 5", efforts: CLAUDE_EFFORTS },
  { id: "fable", label: "Fable 5", efforts: CLAUDE_EFFORTS },
  { id: "opus", label: "Opus 5", efforts: CLAUDE_EFFORTS },
  { id: "haiku", label: "Haiku 4.5", efforts: CLAUDE_EFFORTS },
  { id: "opus[1m]", label: "Opus 5 (1M context)", efforts: CLAUDE_EFFORTS },
  { id: "sonnet[1m]", label: "Sonnet 5 (1M context)", efforts: CLAUDE_EFFORTS },
  { id: "fable[1m]", label: "Fable 5 (1M context)", efforts: CLAUDE_EFFORTS },
  { id: "best", label: "Best available", efforts: CLAUDE_EFFORTS },
  { id: "opusplan", label: "Opus Plan", efforts: CLAUDE_EFFORTS },
];

/**
 * Models Claudex exposes through CLIProxyAPI. The real Claude Code binary is
 * still the engine, but the Anthropic aliases above hit the proxy and fail —
 * only these ids are wired in the user's claudex wrapper.
 *
 * Effort still uses Claude's levels because Claudex sets
 * `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` and the CLI interprets `/effort`.
 */
const CLAUDEX_MODELS: AgentModelChoice[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: CLAUDE_EFFORTS },
  { id: "grok-4.5", label: "Grok 4.5 (Grok Build)", efforts: CLAUDE_EFFORTS },
  { id: "or/selected", label: "OpenRouter (selected)", efforts: CLAUDE_EFFORTS },
];

/** Friendly labels for Claude model ids that arrive from init / settings. */
export function claudeModelLabel(id: string): string {
  const lower = id.toLowerCase();
  const exact = CLAUDE_MODELS.find((model) => model.id.toLowerCase() === lower);
  if (exact) return exact.label;
  const claudex = CLAUDEX_MODELS.find((model) => model.id.toLowerCase() === lower);
  if (claudex) return claudex.label;
  // Full ids from system/init: `claude-opus-5[1m]`, `claude-sonnet-5`, …
  if (lower.includes("fable")) return lower.includes("1m") ? "Fable 5 (1M context)" : "Fable 5";
  if (lower.includes("opus")) return lower.includes("1m") ? "Opus 5 (1M context)" : "Opus 5";
  if (lower.includes("sonnet")) return lower.includes("1m") ? "Sonnet 5 (1M context)" : "Sonnet 5";
  if (lower.includes("haiku")) return "Haiku 4.5";
  if (lower === "gpt-5.6-sol" || lower === "gpt-5.6") return "GPT-5.6 Sol";
  if (lower === "grok-4.5") return "Grok 4.5 (Grok Build)";
  if (lower === "or/selected") return "OpenRouter (selected)";
  return id;
}

/** Map a full Claude model id onto the short alias the picker uses. */
export function claudeModelAlias(id: string): string {
  const lower = id.toLowerCase();
  if (lower === "default" || lower === "best" || lower === "opusplan") return lower;
  const oneM = lower.includes("[1m]") || lower.includes("1m");
  if (lower.includes("fable")) return oneM ? "fable[1m]" : "fable";
  if (lower.includes("opus") && lower.includes("plan")) return "opusplan";
  if (lower.includes("opus")) return oneM ? "opus[1m]" : "opus";
  if (lower.includes("sonnet")) return oneM ? "sonnet[1m]" : "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return id;
}

/**
 * Seed models/efforts when the protocol has not (yet) sent any. Live lists
 * from the adapter replace these entirely — see session events.
 */
const MODEL_FALLBACKS: Partial<Record<AgentId, AgentModelChoice[]>> = {
  claude: CLAUDE_MODELS,
  // Grok / Codex / OpenCode learn models over the wire; seeding empty avoids
  // offering stale ids that the agent would reject.
};

/** True when the typed program is the Claudex Claude Code wrapper. */
export function isClaudexProgram(program: string | null | undefined): boolean {
  return program === "claudex";
}

/**
 * Default model Claudex injects when the user did not pass `--model`.
 * Mirrors `claudex.ps1`: Grok / OpenRouter flags, otherwise GPT-5.6 Sol.
 */
export function claudexDefaultModel(wrapperArgs: readonly string[] = []): string {
  for (const arg of wrapperArgs) {
    const lower = arg.toLowerCase();
    if (lower === "--g" || lower === "--grok") return "grok-4.5";
    if (lower === "--o" || lower === "--pick-openrouter") return "or/selected";
  }
  return "gpt-5.6-sol";
}

/** The commands an agent knows before (or without ever) advertising any. */
export function fallbackCommands(
  agent: AgentId,
  program?: string,
): { name: string; description: string }[] {
  const commands = [
    ...FALLBACKS[agent].map((command) => ({ ...command })),
    ...LOCAL_COMMANDS.map((command) => ({ ...command })),
  ];
  if (!isClaudexProgram(program)) return commands;
  // Same slash surface as Claude Code, reworded so /resume does not claim to
  // open a plain Anthropic Claude session.
  return commands.map((command) =>
    command.name === "/resume"
      ? { ...command, description: "Continue a past Claudex session in this folder" }
      : command,
  );
}

/** App-owned spellings that replace the current conversation with a blank one. */
export function isNewChatCommand(value: string): boolean {
  return /^\/(?:new|n)$/i.test(value.trim());
}

function formatUsageCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** App-owned `/usage`, available even when the underlying CLI has no command. */
export function formatSessionUsage(usage: AgentUsage): string {
  const total = usage.inputTokens + usage.outputTokens;
  if (
    total === 0 &&
    usage.costUsd === null &&
    usage.contextUsed === null
  ) {
    return "Usage this session: no token data has been reported yet.";
  }

  const parts = [
    `${formatUsageCount(usage.inputTokens)} input`,
    `${formatUsageCount(usage.outputTokens)} output`,
    `${formatUsageCount(total)} total`,
  ];
  if (usage.contextUsed !== null) {
    parts.push(`${Math.round(usage.contextUsed * 100)}% context`);
  }
  if (usage.costUsd !== null) {
    parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}`);
  }
  return `Usage this session · ${parts.join(" · ")}`;
}

/** Models/efforts known before the agent reports its own list. */
export function fallbackModels(agent: AgentId, program?: string): AgentModelChoice[] {
  if (isClaudexProgram(program)) {
    return CLAUDEX_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] }));
  }
  const list = MODEL_FALLBACKS[agent];
  return list ? list.map((model) => ({ ...model, efforts: [...model.efforts] })) : [];
}

/** Slash commands whose next token is chosen from a guided menu. */
export const GUIDED_ARG_COMMANDS = new Set(["/model", "/effort"]);

/**
 * Fold live-advertised commands into the current list. A live name replaces
 * the static entry with the same name — but a live entry with no description
 * inherits the static one, since Claude's init frame ships bare names.
 * Commands the agent never heard of stay: `/model` works on Grok over RPC
 * even though Grok never advertises it.
 */
export function mergeCommands(
  base: { name: string; description: string }[],
  live: { name: string; description: string }[],
): { name: string; description: string }[] {
  const liveByName = new Map(live.map((command) => [command.name.toLowerCase(), command]));
  const merged = base.map((command) => {
    const update = liveByName.get(command.name.toLowerCase());
    if (!update) return command;
    liveByName.delete(command.name.toLowerCase());
    return { name: update.name, description: update.description || command.description };
  });
  for (const command of liveByName.values()) merged.push(command);
  return merged;
}
