export interface ProcessState {
  busy: boolean;
  exited: boolean;
  /** Increments when a persistent CLI agent finishes a turn or needs attention. */
  completionSeq: number;
  /** Recognised coding agent currently responsible for the terminal activity. */
  agent: AgentKind | null;
  /** The custom agent UI owns this pane, so its shell is not what finishes. */
  agentUi: boolean;
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

/** Completion sound only after a job has been running for more than one minute. */
export const COMPLETION_SOUND_MIN_MS = 60_000;

/**
 * Real agent-turn completions (completionSeq) are always worth surfacing.
 * Ordinary terminal processes only earn the visual marker after running for
 * more than 30 seconds.
 *
 * A coding-agent process going idle or exiting is the user quitting the CLI
 * (Ctrl+C, /exit, …) — not a finished turn. Persistent agents report turns
 * via completionSeq from session logs, hooks, or OSC notifications. Treating
 * process exit as completion falsely played the sound and flash on quit, and
 * stacked with a late agent:complete for agents like Grok.
 *
 * The same holds under the custom agent UI, where the shell sitting behind the
 * pane is not what the user is waiting on at all.
 */
export function shouldSignalCompletion(
  previous: ProcessState,
  current: ProcessState,
  now = Date.now(),
): boolean {
  if (current.completionSeq > previous.completionSeq) return true;
  if (!didProcessFinish(previous, current)) return false;
  // Agent process left the tree (or the shell died while one was bound).
  if (previous.agent !== null || current.agent !== null) return false;
  if (previous.agentUi || current.agentUi) return false;

  const startedAt = previous.processStartedAt ?? current.processStartedAt;
  return startedAt !== null && now - startedAt > PROCESS_COMPLETION_MIN_MS;
}

/**
 * Sound is stricter than the visual marker: the job must have run for more
 * than one minute. Focus is checked separately so background panes stay quiet.
 * Agent process exit alone never counts — same rule as shouldSignalCompletion.
 *
 * The start time is read from `previous` first: App measures duration at the
 * completion edge, and a late notify that clears `processStartedAt` must not
 * make a long turn look timeless (or the other way around).
 */
export function shouldPlayCompletionSound(
  previous: ProcessState,
  current: ProcessState,
  now = Date.now(),
): boolean {
  if (!shouldSignalCompletion(previous, current, now)) return false;
  // Prefer the pre-edge start so a turn that just finished keeps its clock
  // even if the session module already prepared for the next one.
  const startedAt = previous.processStartedAt ?? current.processStartedAt;
  return startedAt !== null && now - startedAt > COMPLETION_SOUND_MIN_MS;
}

/**
 * True when raw terminal input is the user handing work to a bound agent.
 *
 * Enter submits a prompt in every CLI agent we recognise, and it is also how a
 * permission prompt is answered. Escape sequences are stripped first: xterm
 * answers ConPTY's device queries through the same channel, and full-screen
 * agents turn on mouse reporting, neither of which is the user asking for
 * anything. Over-counting only allows a notification the agent still has to
 * earn; under-counting would swallow a real one, so anything Enter-shaped
 * counts.
 */
export function isAgentPromptSubmission(data: string): boolean {
  const typed = data
    // CSI (mouse reports, cursor position replies, bracketed paste markers).
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC and other string sequences, up to their terminator.
    .replace(/\x1b][\s\S]*?(?:\x07|\x1b\\)/g, "");
  return /[\r\n]/.test(typed);
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
  claudex: "claude",
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

/**
 * Gemini (and a few other CLIs) use the standard `777;notify;title;body` form
 * for turn completion. Require completion-ish wording so progress/status
 * notifies do not look like a finished agent turn.
 */
export function isGenericOsc777Notification(payload: string): boolean {
  const text = payload.trim();
  if (!/^notify;[^;]+(?:;.*)?$/i.test(text)) return false;
  return /complete|finished|done|idle|responded|ready/i.test(text);
}
