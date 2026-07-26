export interface ProcessState {
  busy: boolean;
  exited: boolean;
  /** Increments when a persistent CLI agent finishes a turn or needs attention. */
  completionSeq: number;
  /** Recognised coding agent currently responsible for the terminal activity. */
  agent: AgentKind | null;
  /** Wall-clock captured when a child process first became active. */
  processStartedAt: number | null;
}

/** True only on the edge where a child finishes or the terminal shell exits. */
export function didProcessFinish(previous: ProcessState, current: ProcessState): boolean {
  return (
    (previous.busy && !current.busy) ||
    (!previous.exited && current.exited) ||
    current.completionSeq > previous.completionSeq
  );
}

/** Ordinary terminal jobs must run longer than this before completion is signalled. */
export const PROCESS_COMPLETION_MIN_MS = 30_000;

/**
 * Coding-agent completions are always worth surfacing. Ordinary terminal
 * processes only earn the sound and visual marker after running for more than
 * 30 seconds.
 */
export function shouldSignalCompletion(
  previous: ProcessState,
  current: ProcessState,
  now = Date.now(),
): boolean {
  if (!didProcessFinish(previous, current)) return false;
  if (
    current.completionSeq > previous.completionSeq ||
    previous.agent !== null ||
    current.agent !== null
  ) {
    return true;
  }

  const startedAt = previous.processStartedAt ?? current.processStartedAt;
  return startedAt !== null && now - startedAt > PROCESS_COMPLETION_MIN_MS;
}

export type AgentKind =
  | "codex"
  | "claude"
  | "grok"
  | "opencode"
  | "gemini"
  | "antigravity"
  | "qwen"
  | "copilot"
  | "aider";

const DIRECT_AGENTS: Record<string, AgentKind> = {
  codex: "codex",
  omx: "codex",
  claude: "claude",
  "claude-code": "claude",
  omc: "claude",
  grok: "grok",
  "grok-build": "grok",
  opencode: "opencode",
  "opencode-ai": "opencode",
  gemini: "gemini",
  "gemini-cli": "gemini",
  agy: "antigravity",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
  qwen: "qwen",
  "qwen-code": "qwen",
  copilot: "copilot",
  "github-copilot": "copilot",
  aider: "aider",
  "aider-chat": "aider",
};

/**
 * Detect agents from the command that launched them. Prefix support covers
 * profile wrappers such as `codex-work`, `claude-personal`, and `grok-fast`.
 */
export function detectAgent(command: string): AgentKind | null {
  const words = command
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, "").toLowerCase());
  let at = 0;
  while (
    at < words.length &&
    (words[at] === "&" || words[at] === "sudo" || words[at] === "env" || /^\w+=/.test(words[at]))
  ) {
    at += 1;
  }
  if (["npx", "bunx"].includes(words[at])) at += 1;
  else if (
    ["npm", "pnpm", "yarn"].includes(words[at]) &&
    ["exec", "x", "dlx"].includes(words[at + 1])
  ) {
    at += 2;
  }
  while (words[at]?.startsWith("-")) at += 1;
  const word = words[at] ?? "";
  const executable = word.split(/[\\/@]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "") ?? word;
  const direct = DIRECT_AGENTS[executable];
  if (direct) return direct;
  if (/^(codex|omx)-/.test(executable)) return "codex";
  if (/^(claude|cc|omc)-/.test(executable)) return "claude";
  if (/^grok-/.test(executable)) return "grok";
  if (/^opencode-/.test(executable)) return "opencode";
  if (/^gemini-/.test(executable)) return "gemini";
  if (/^(agy|antigravity)-/.test(executable)) return "antigravity";
  if (/^qwen-/.test(executable)) return "qwen";
  if (/^(copilot|github-copilot)-/.test(executable)) return "copilot";
  if (/^aider-/.test(executable)) return "aider";
  return null;
}

export interface StructuredAgentEvent {
  agent: AgentKind | null;
  needsAttention: boolean;
}

/** Parse Warp-compatible `warp://cli-agent` JSON carried inside OSC 777. */
export function parseAgentOsc777(payload: string): StructuredAgentEvent | null {
  const sentinel = "warp://cli-agent;";
  const at = payload.indexOf(sentinel);
  if (at < 0) return null;
  try {
    const raw = JSON.parse(payload.slice(at + sentinel.length)) as {
      agent?: unknown;
      event?: unknown;
    };
    const agent = typeof raw.agent === "string" ? detectAgent(raw.agent) : null;
    const event = typeof raw.event === "string" ? raw.event.toLowerCase() : "";
    return {
      agent,
      needsAttention: [
        "stop",
        "stop_failure",
        "idle_prompt",
        "permission_request",
        "question_asked",
      ].includes(event),
    };
  } catch {
    return null;
  }
}

/** Gemini and several terminal tools use the standard `777;notify;title;body` form. */
export function isGenericOsc777Notification(payload: string): boolean {
  return /^notify;[^;]+(?:;.*)?$/i.test(payload.trim());
}
