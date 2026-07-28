import { AGENTS, AGENT_IDS } from "./catalog";
import type { AgentId } from "./types";

/**
 * A command the custom UI should answer instead of the shell.
 */
export interface AgentLaunch {
  agent: AgentId;
  /**
   * Executable actually launched. Usually the typed name (`claude`, `claudex`,
   * `codex`); profile wrappers like `claude-work` fall back to the agent's
   * canonical binary because those names are often shell aliases that PATH
   * resolution cannot find.
   */
  program: string;
  /** Environment assignments typed before the executable. */
  env: Record<string, string>;
  /**
   * Wrapper-only flags that must precede the headless protocol args.
   * Claudex uses `--g` / `--o` (and long forms) to pick a proxied backend
   * before it re-execs Claude Code — those must not be dropped or reordered.
   */
  wrapperArgs: string[];
  /** Supported CLI options preserved before the headless protocol arguments. */
  forwardArgs: string[];
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
  /**
   * A specific past session to resume: `--resume <id>`, or OpenCode's
   * `--session <id>`. Also set by the in-app session picker, which is the
   * usual way one gets here.
   */
  resumeId: string | null;
}

/**
 * Executables that launch each agent, including the profile-wrapper prefixes
 * duckweed already recognises elsewhere (`codex-work`, `claude-personal`).
 *
 * `claudex` is a local Claude Code wrapper that points the real CLI at a
 * CLIProxyAPI backend (OpenAI/Grok/OpenRouter). It speaks the same protocol as
 * `claude`, so the custom UI drives it as Claude — but the process must still
 * be `claudex`, or the proxy env never gets set.
 */
const EXECUTABLES: Record<string, AgentId> = {
  claude: "claude",
  "claude-code": "claude",
  claudex: "claude",
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

/** Direct executable names worth probing before a command is submitted. */
export const AGENT_PROGRAMS = Object.freeze(Object.keys(EXECUTABLES));

/**
 * Flags Claudex strips before handing the rest to Claude Code. They select a
 * proxied model backend and must be forwarded on the spawned command line.
 */
const CLAUDEX_WRAPPER_FLAGS = new Set([
  "--g",
  "--grok",
  "--o",
  "--pick-openrouter",
]);

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

/**
 * Resolve a typed executable to the agent it drives and the program to spawn.
 *
 * Exact catalog names (`claude`, `claudex`, `omc`, …) keep that name as the
 * program so wrappers that set env / proxy before re-execing still run.
 * Prefix profile wrappers (`claude-work`) fall back to the agent's canonical
 * binary — those names are usually shell aliases, not PATH entries.
 */
function resolveAgent(word: string): { agent: AgentId; program: string } | null {
  const name = executableName(word);
  const direct = EXECUTABLES[name];
  if (direct) return { agent: direct, program: word };
  for (const [pattern, id] of PREFIXES) {
    if (pattern.test(name)) return { agent: id, program: AGENTS[id].binaries[0] };
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
  const env: Record<string, string> = {};
  const takeAssignment = (word: string): boolean => {
    const match = /^([A-Za-z_]\w*)=(.*)$/.exec(word);
    if (!match) return false;
    env[match[1]] = match[2];
    return true;
  };

  // Keep simple environment assignments when replacing the shell launch.
  while (at < words.length && takeAssignment(words[at])) {
    at += 1;
  }
  if (words[at] === "env") {
    at += 1;
    while (at < words.length && takeAssignment(words[at])) at += 1;
    // Options such as `env -u NAME` need the real shell utility.
    if (words[at]?.startsWith("-")) return null;
  }
  // Privilege and environment-preservation behavior belongs to sudo itself.
  if (words[at] === "sudo") return null;
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
  const resolved = resolveAgent(executable);
  if (!resolved) return null;
  const { agent, program } = resolved;

  const definition = AGENTS[agent];
  const args = words.slice(at + 1);
  const passthrough = new Set(definition.passthrough.map((flag) => flag.toLowerCase()));

  let prompt: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let resume = false;
  let resumeId: string | null = null;
  const wrapperArgs: string[] = [];
  const forwardArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const lower = word.toLowerCase();
    if (passthrough.has(lower)) return null;

    if (word.startsWith("-")) {
      // Claudex's backend pickers are not Claude flags — capture them so the
      // spawn line can put them before the headless protocol args.
      if (program === "claudex" && CLAUDEX_WRAPPER_FLAGS.has(lower)) {
        wrapperArgs.push(word);
        continue;
      }
      // `--model=opus` — one word carrying its own value.
      const equals = word.indexOf("=");
      if (equals > 0) {
        const flag = lower.slice(0, equals);
        if (passthrough.has(flag)) return null;
        let consumed = false;
        if (flag === "--model" || flag === "-m") {
          model = word.slice(equals + 1);
          consumed = true;
        }
        if (isEffortFlag(flag)) {
          effort = word.slice(equals + 1);
          consumed = true;
        }
        if (agent === "codex" && (flag === "-c" || flag === "--config")) {
          const config = readCodexConfig(word.slice(equals + 1));
          model = config.model ?? model;
          effort = config.effort ?? effort;
          consumed = config.model !== undefined || config.effort !== undefined;
        }
        if (!consumed) forwardArgs.push(word);
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
        let consumed = false;
        if (lower === "-m" || lower === "--model") {
          model = hasValue ? value : null;
          consumed = true;
        }
        if (isEffortFlag(lower)) {
          effort = hasValue ? value : null;
          consumed = true;
        }
        if (hasValue && agent === "codex" && (lower === "-c" || lower === "--config")) {
          const config = readCodexConfig(value);
          model = config.model ?? model;
          effort = config.effort ?? effort;
          consumed = config.model !== undefined || config.effort !== undefined;
        }
        if (lower === "--resume") {
          if (hasValue) resumeId = value;
          else resume = true;
          consumed = true;
        }
        // `-s` is OpenCode's "continue this session"; Grok spells the same two
        // characters `--session-id` and means "start a new one with this id".
        if (hasValue && agent === "opencode" && (lower === "-s" || lower === "--session")) {
          resumeId = value;
          consumed = true;
        }
        if (!consumed) {
          forwardArgs.push(word);
          if (hasValue) forwardArgs.push(value);
        }
        if (hasValue) i += 1;
        continue;
      }
      forwardArgs.push(word);
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

  return {
    agent,
    program,
    env,
    wrapperArgs,
    forwardArgs,
    args,
    prompt,
    model,
    effort,
    resume,
    resumeId,
  };
}

/** True when `agent` is one the custom UI knows how to drive. */
export function isSupportedAgent(value: string): value is AgentId {
  return (AGENT_IDS as string[]).includes(value);
}
