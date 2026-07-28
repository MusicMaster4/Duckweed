import type { AgentId } from "./types";

/** Which wire protocol an agent's headless mode speaks. */
export type AgentProtocol =
  /** Claude Code's `stream-json`: one Anthropic SDK message per line. */
  | "claude-stream-json"
  /** Codex `app-server`: JSON-RPC 2.0 with Codex's own method names. */
  | "codex-app-server"
  /** Agent Client Protocol — JSON-RPC 2.0, shared by Cursor, Grok, OpenCode. */
  | "acp";

export interface AgentDefinition {
  id: AgentId;
  label: string;
  /** Executable names that launch this agent, in preference order. */
  binaries: string[];
  /** Fixed arguments that put the CLI into its headless protocol mode. */
  headlessArgs: string[];
  protocol: AgentProtocol;
  /** Accent used for the agent's badge and streaming chrome. */
  accent: string;
  /** Two-letter mark drawn in the badge. */
  mark: string;
  /**
   * Subcommands and flags that mean "do not take this over". They ask for
   * something other than an interactive session — a one-shot run, a login
   * flow, help output — and the real CLI is the right answer for all of them.
   */
  passthrough: string[];
}

/**
 * The agents T3 Code drives, and the commands that put each into the JSON mode
 * the custom UI reads. These were verified against the installed CLIs rather
 * than taken from documentation: `opencode acp` and `grok agent stdio` both
 * answer an ACP `initialize`, and `codex app-server` answers a JSON-RPC one.
 */
export const AGENTS: Record<AgentId, AgentDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    binaries: ["claude"],
    headlessArgs: [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Makes bypassPermissions available to the in-session access picker
      // without enabling it. The initial mode still comes from Claude's own
      // settings unless the user explicitly selects Full access.
      "--allow-dangerously-skip-permissions",
      // Claude's child agents otherwise stay hidden behind the parent Task
      // tool call. This preserves their text/thinking blocks on stream-json,
      // tagged with parent_tool_use_id by the CLI, so the transcript can show
      // real subagent activity instead of synthesising it.
      "--forward-subagent-text",
      // Routes tool approvals back over the same stream as control requests
      // instead of failing them, which is what makes the UI's approve/deny
      // prompt possible at all.
      "--permission-prompt-tool",
      "stdio",
    ],
    protocol: "claude-stream-json",
    accent: "#d97757",
    mark: "CC",
    passthrough: [
      "-p",
      "--print",
      "-h",
      "--help",
      "-v",
      "--version",
      "mcp",
      "config",
      "update",
      "doctor",
      "agents",
      "install",
      "setup-token",
      "migrate-installer",
      "plugin",
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    headlessArgs: ["app-server"],
    protocol: "codex-app-server",
    accent: "#8f9aa6",
    mark: "CX",
    passthrough: [
      "exec",
      "e",
      "review",
      "login",
      "logout",
      "mcp",
      "mcp-server",
      "app-server",
      "app",
      "remote-control",
      "completion",
      "update",
      "doctor",
      "sandbox",
      "debug",
      "apply",
      "a",
      "archive",
      "delete",
      "unarchive",
      "cloud",
      "exec-server",
      "features",
      "help",
      "plugin",
      "-h",
      "--help",
      "-V",
      "--version",
    ],
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    binaries: ["cursor-agent"],
    headlessArgs: ["acp"],
    protocol: "acp",
    accent: "#c7c7c7",
    mark: "CU",
    passthrough: [
      "acp",
      "login",
      "logout",
      "status",
      "update",
      "upgrade",
      "mcp",
      "ls",
      "resume",
      "-p",
      "--print",
      "-h",
      "--help",
      "-v",
      "--version",
    ],
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    binaries: ["grok"],
    headlessArgs: ["agent", "stdio"],
    protocol: "acp",
    accent: "#7ea6ff",
    mark: "GR",
    passthrough: [
      "agent",
      "login",
      "logout",
      "auth",
      "mcp",
      "update",
      "upgrade",
      "help",
      "completion",
      "-h",
      "--help",
      "-V",
      "--version",
      "--json-schema",
      "--output-format",
    ],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    binaries: ["opencode"],
    headlessArgs: ["acp"],
    protocol: "acp",
    accent: "#9ae66e",
    mark: "OC",
    passthrough: [
      "acp",
      "run",
      "serve",
      "web",
      "attach",
      "auth",
      "providers",
      "agent",
      "models",
      "stats",
      "export",
      "import",
      "github",
      "pr",
      "session",
      "plugin",
      "plug",
      "db",
      "debug",
      "mcp",
      "upgrade",
      "uninstall",
      "completion",
      "-h",
      "--help",
      "-v",
      "--version",
    ],
  },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** Every executable name the launch parser recognises. */
export const AGENT_BINARIES: string[] = AGENT_IDS.flatMap((id) => AGENTS[id].binaries);

/**
 * How the custom UI brands a session in the header / empty state.
 *
 * Wrappers that speak a known protocol still get their own name and chrome so a
 * pane running `claudex` is not labelled "Claude Code" with Anthropic models.
 */
export interface AgentPresentation {
  label: string;
  mark: string;
  accent: string;
}

/**
 * Presentation for a launch. `program` is the typed executable (e.g. `claudex`);
 * when it is just the catalog binary the agent's own branding is used.
 */
export function agentPresentation(agent: AgentId, program: string): AgentPresentation {
  if (program === "claudex") {
    return {
      label: "Claudex",
      mark: "DX",
      // Warm custom color shared by the Claudex icon and all activity states.
      accent: "#dcc09d",
    };
  }
  const definition = AGENTS[agent];
  return {
    label: definition.label,
    mark: definition.mark,
    accent: definition.accent,
  };
}
