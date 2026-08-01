import type { AgentEvent } from "./events";
import type { AgentLaunch } from "./launch";
import type {
  AgentAccessMode,
  AgentImageAttachment,
  AgentPrompt,
  AgentQuestionAnswer,
} from "./types";

/** What an adapter is given to do its job. */
export interface AdapterContext {
  /** Folder the agent was launched in. */
  cwd: string;
  /** What the user typed, already parsed. */
  launch: AgentLaunch;
  /** Write one protocol message to the agent's stdin. */
  send: (message: unknown) => void;
  /** Report something the UI should show. */
  emit: (event: AgentEvent) => void;
}

/**
 * One protocol, translated.
 *
 * Adapters own their protocol's bookkeeping — request ids, session ids,
 * half-finished tool calls — and nothing else. They never see React, the
 * store, or the terminal they replaced.
 */
export interface AgentAdapter {
  /**
   * Arguments to append to the agent's headless invocation, derived from what
   * the user typed (`--model`, `--continue`, …). Agents that carry those in
   * their protocol instead return nothing here.
   */
  args: (launch: AgentLaunch) => string[];
  /** The process is up: send whatever handshake the protocol needs. */
  start: (ctx: AdapterContext) => void;
  /** One line from the agent's stdout. */
  receive: (line: string, ctx: AdapterContext) => void;
  /** The user submitted text and optional images. */
  prompt: (prompt: AgentPrompt, ctx: AdapterContext) => void;
  /**
   * Add input to the turn already in flight. Resolves false when the provider
   * rejects same-turn steering, so the session can safely put the prompt back
   * in its queue.
   */
  steer?: (prompt: AgentPrompt, ctx: AdapterContext) => Promise<boolean> | boolean;
  /** Send a message directly to a provider-owned child thread. */
  promptSubagent?: (
    threadId: string,
    prompt: AgentPrompt,
    ctx: AdapterContext,
  ) => Promise<boolean> | boolean;
  /**
   * The user submitted text starting with `/`. Returning `"handled"` means
   * the adapter ran the command itself (an RPC, a local answer); `"prompt"`
   * sends the text on as a normal message, which is how agents that interpret
   * slash text themselves (Claude, ACP) receive their commands.
   */
  command?: (text: string, ctx: AdapterContext) => "handled" | "prompt";
  /**
   * Whether a local command may bypass the follow-up queue while a turn is
   * running. This is reserved for control-plane operations such as Codex
   * `/goal pause`: queueing the command would make it impossible to stop the
   * automatic continuation it is meant to control.
   */
  commandAvailableDuringTurn?: (text: string) => boolean;
  /**
   * Apply a session-wide access level. `default` must remove Duckweed's
   * overrides so the agent's own configuration remains authoritative.
   */
  configureAccess?: (
    mode: AgentAccessMode,
    ctx: AdapterContext,
  ) => Promise<boolean> | boolean;
  /**
   * Continue a past conversation, in-protocol.
   *
   * Codex (`thread/resume`) and ACP agents that advertise `loadSession`
   * (`session/load`) can swap conversations without restarting. A fulfilled
   * promise reports whether the protocol accepted the requested session.
   * Returning `false`, or leaving this out as Claude does, means the running
   * adapter cannot resume through its protocol.
   */
  resume?: (sessionId: string, ctx: AdapterContext) => Promise<boolean> | false;
  /** The user asked the current turn to stop. */
  interrupt: (ctx: AdapterContext) => void;
  /** The user answered a permission prompt. */
  respond: (permissionId: string, optionId: string, ctx: AdapterContext) => void;
  /**
   * The user answered a question the agent asked. Only adapters that implement
   * this may emit a `question` permission: without it the card would collect an
   * answer with nowhere to send it.
   */
  answer?: (
    permissionId: string,
    answers: AgentQuestionAnswer[],
    ctx: AdapterContext,
  ) => void;
  /**
   * The session is closing. Adapters that end on stdin EOF rather than a kill
   * say so, and the session closes their stdin first.
   */
  endsOnStdinClose?: boolean;
}

/** Return the exact original image source, never its display-only thumbnail. */
export function imagePayloadDataUrl(image: AgentImageAttachment): string {
  return image.dataUrl;
}

/** Strip the original data-URL header for protocols that carry MIME separately. */
export function imagePayloadBase64(image: AgentImageAttachment): string {
  const dataUrl = imagePayloadDataUrl(image);
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Parse a protocol line, ignoring anything that is not JSON we can read. */
export function parseJson(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    // Agents interleave human-readable logs with protocol lines; a line we
    // cannot parse is almost always one of those, not a broken session.
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collapse a value to one display line: a command, a path, a short summary. */
export function oneLine(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
