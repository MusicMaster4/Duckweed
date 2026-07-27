import type { AgentId, AgentModelChoice } from "./types";

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
 * intercept advertised names) or the adapter wires them to an RPC
 * (`/model`, `/effort`, `/compact`). Names verified against the installed
 * CLIs (claude 2.1, codex 0.145, grok 0.2.112, opencode 1.18).
 */
const FALLBACKS: Record<AgentId, { name: string; description: string }[]> = {
  claude: [
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
    { name: "/model", description: "Change the model for later turns" },
    { name: "/effort", description: "Set reasoning effort for later turns" },
    { name: "/compact", description: "Compact the conversation to free context" },
  ],
  grok: [
    { name: "/model", description: "Change the model for this session" },
    { name: "/effort", description: "Set reasoning effort: low, medium, high" },
    { name: "/compact", description: "Compress conversation history" },
    { name: "/context", description: "Show context window usage and session stats" },
    { name: "/session-info", description: "Show session details" },
  ],
  opencode: [
    { name: "/model", description: "Change the model for this session" },
    { name: "/compact", description: "Compact the conversation to free context" },
  ],
  cursor: [{ name: "/model", description: "Change the model for this session" }],
};

/**
 * Claude's stream-json init never lists switchable models, only the one in
 * use. These short aliases are what `/model` and the control request accept
 * (verified against claude 2.1), so the picker has something to offer before
 * the user has to invent an id.
 */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto"];
const CLAUDE_MODELS: AgentModelChoice[] = [
  { id: "opus", label: "Opus", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS },
  { id: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS },
];

/**
 * Seed models/efforts when the protocol has not (yet) sent any. Live lists
 * from the adapter replace these entirely — see session events.
 */
const MODEL_FALLBACKS: Partial<Record<AgentId, AgentModelChoice[]>> = {
  claude: CLAUDE_MODELS,
  // Grok / Codex / OpenCode learn models over the wire; seeding empty avoids
  // offering stale ids that the agent would reject.
};

/** The commands an agent knows before (or without ever) advertising any. */
export function fallbackCommands(agent: AgentId): { name: string; description: string }[] {
  return FALLBACKS[agent].map((command) => ({ ...command }));
}

/** Models/efforts known before the agent reports its own list. */
export function fallbackModels(agent: AgentId): AgentModelChoice[] {
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
