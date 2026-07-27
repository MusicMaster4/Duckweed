import { AGENTS, AGENT_IDS } from "./catalog";
import type { AgentId } from "./types";

/**
 * A command the custom UI should answer instead of the shell.
 */
export interface AgentLaunch {
  agent: AgentId;
  /** Everything typed after the executable, unquoted. */
  args: string[];
  /** A bare positional argument — the opening prompt. */
  prompt: string | null;
  /** `-m` / `--model`, when the user asked for one. */
  model: string | null;
  /**
   * `--effort` / `--reasoning-effort`, or Codex's
   * `-c model_reasoning_effort=…`: how hard the model should think.
   */
  effort: string | null;
  /** `-c` / `--continue`, or `--resume` with no id: pick up where they left off. */
  resume: boolean;
}

/**
 * Executables that launch each agent, including the profile-wrapper prefixes
 * duckweed already recognises elsewhere (`codex-work`, `claude-personal`).
 */
const EXECUTABLES: Record<string, AgentId> = {
  claude: "claude",
  "claude-code": "claude",
  omc: "claude",
  codex: "codex",
  omx: "codex",
  "cursor-agent": "cursor",
  cursor: "cursor",
  grok: "grok",
  "grok-build": "grok",
  opencode: "opencode",
  "opencode-ai": "opencode",
};

const PREFIXES: [RegExp, AgentId][] = [
  [/^(claude|cc|omc)-/, "claude"],
  [/^(codex|omx)-/, "codex"],
  [/^cursor-agent-/, "cursor"],
  [/^grok-/, "grok"],
  [/^opencode-/, "opencode"],
];

/**
 * Shell syntax that means the user wants the shell, not us. A pipeline, a
 * redirect, a background job, or a chained command all imply the CLI's real
 * stdout matters — replacing it with a UI would silently change what runs.
 */
const SHELL_OPERATORS = /(^|\s)(\||&&|\|\||;|&\s*$|>>?|2>|<)/;

/** Split a command line into words, honouring single and double quotes. */
export function tokenize(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let quoted = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      // Only `\"` escapes. A bare backslash stays literal so a quoted Windows
      // path — `"C:\Users\me\bin\claude.cmd"` — survives tokenizing intact.
      else if (char === "\\" && quote === '"' && command[i + 1] === '"') {
        i += 1;
        current += '"';
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || quoted) words.push(current);
      current = "";
      quoted = false;
      continue;
    }
    current += char;
  }
  if (current || quoted) words.push(current);
  return words;
}

/** Strip a path and any executable suffix: `C:\bin\claude.cmd` → `claude`. */
function executableName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function resolveAgent(word: string): AgentId | null {
  const name = executableName(word);
  const direct = EXECUTABLES[name];
  if (direct) return direct;
  for (const [pattern, id] of PREFIXES) {
    if (pattern.test(name)) return id;
  }
  return null;
}

/** Flags that take a value, so the next word is never a prompt. */
const VALUE_FLAGS = new Set([
  "-m",
  "--model",
  "--agent",
  "--agents",
  "--cwd",
  "--add-dir",
  "--allow",
  "--deny",
  "--allowedtools",
  "--allowed-tools",
  "--disallowedtools",
  "--disallowed-tools",
  "--append-system-prompt",
  "--system-prompt",
  "--settings",
  "--mcp-config",
  "--session-id",
  "--resume",
  "-s",
  "--session",
  "--effort",
  "--reasoning-effort",
  "-c",
  "--config",
  "--profile",
  "--sandbox",
  "--prompt",
  "--plugin-dir",
  "--agent-profile",
]);

/**
 * `-c` means "continue" to Claude, Grok, and OpenCode, but "config override"
 * to Codex — the same two characters, opposite parsing.
 */
function takesValue(agent: AgentId, flag: string): boolean {
  const lower = flag.toLowerCase();
  if (lower === "-c") return agent === "codex";
  if (lower === "--config") return agent === "codex";
  return VALUE_FLAGS.has(lower);
}

function isContinue(agent: AgentId, flag: string): boolean {
  const lower = flag.toLowerCase();
  if (lower === "--continue") return true;
  return lower === "-c" && agent !== "codex";
}

function isEffortFlag(flag: string): boolean {
  const lower = flag.toLowerCase();
  return lower === "--effort" || lower === "--reasoning-effort";
}

/**
 * Codex's `-c key=value` carries TOML overrides; two of them name the same
 * knobs the other CLIs expose as first-class flags.
 */
function readCodexConfig(value: string): { model?: string; effort?: string } {
  const match = /^(model_reasoning_effort|model)\s*=\s*(.+)$/.exec(value);
  if (!match) return {};
  const parsed = match[2].trim().replace(/^["']|["']$/g, "");
  return match[1] === "model_reasoning_effort" ? { effort: parsed } : { model: parsed };
}

/**
 * Decide whether a typed command is a plain interactive agent launch.
 *
 * The custom UI replaces the CLI's own interface, so it may only ever claim
 * commands whose whole purpose is that interface. Anything asking for a
 * one-shot run, a login, help text, or a subcommand goes to the shell
 * untouched — the answer there is text the user expects to see, or to pipe.
 */
export function parseAgentLaunch(command: string): AgentLaunch | null {
  const text = command.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!text || SHELL_OPERATORS.test(text)) return null;
  // A multi-line paste is a heredoc or a script, never a bare launch.
  if (/[\r\n]/.test(text)) return null;

  const words = tokenize(text);
  let at = 0;
  // Environment assignments and `sudo`/`env` prefixes still launch the agent.
  while (at < words.length && (words[at] === "sudo" || words[at] === "env" || /^\w+=/.test(words[at]))) {
    at += 1;
  }
  if (["npx", "bunx"].includes(words[at])) at += 1;
  else if (
    ["npm", "pnpm", "yarn"].includes(words[at]) &&
    ["exec", "x", "dlx"].includes(words[at + 1])
  ) {
    at += 2;
  }
  // `npx -y claude` — runner flags sit between the runner and the package.
  while (at < words.length && words[at]?.startsWith("-")) at += 1;

  const executable = words[at];
  if (!executable) return null;
  const agent = resolveAgent(executable);
  if (!agent) return null;

  const definition = AGENTS[agent];
  const args = words.slice(at + 1);
  const passthrough = new Set(definition.passthrough.map((flag) => flag.toLowerCase()));

  let prompt: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let resume = false;

  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const lower = word.toLowerCase();
    if (passthrough.has(lower)) return null;

    if (word.startsWith("-")) {
      // `--model=opus` — one word carrying its own value.
      const equals = word.indexOf("=");
      if (equals > 0) {
        const flag = lower.slice(0, equals);
        if (passthrough.has(flag)) return null;
        if (flag === "--model" || flag === "-m") model = word.slice(equals + 1);
        if (isEffortFlag(flag)) effort = word.slice(equals + 1);
        if (agent === "codex" && (flag === "-c" || flag === "--config")) {
          const config = readCodexConfig(word.slice(equals + 1));
          model = config.model ?? model;
          effort = config.effort ?? effort;
        }
        continue;
      }
      if (isContinue(agent, word)) {
        resume = true;
        continue;
      }
      if (takesValue(agent, word)) {
        const value = args[i + 1];
        // `--resume` is the one flag whose value is optional: with a session id
        // it consumes it, bare it just means "the last one".
        const hasValue = value !== undefined && !value.startsWith("-");
        if (lower === "-m" || lower === "--model") model = hasValue ? value : null;
        if (isEffortFlag(lower)) effort = hasValue ? value : null;
        if (hasValue && agent === "codex" && (lower === "-c" || lower === "--config")) {
          const config = readCodexConfig(value);
          model = config.model ?? model;
          effort = config.effort ?? effort;
        }
        if (lower === "--resume" && !hasValue) resume = true;
        if (hasValue) i += 1;
        continue;
      }
      continue;
    }

    // The first bare word is either a subcommand we refuse or the prompt.
    // Anything short, lowercase, and single-word is ambiguous enough that the
    // shell should decide — a real prompt is a sentence.
    if (prompt === null) {
      prompt = word;
      continue;
    }
    // A second positional means a subcommand took an argument. Not ours.
    return null;
  }

  return { agent, args, prompt, model, effort, resume };
}

/** True when `agent` is one the custom UI knows how to drive. */
export function isSupportedAgent(value: string): value is AgentId {
  return (AGENT_IDS as string[]).includes(value);
}
