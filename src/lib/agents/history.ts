import {
  agentSessionsList,
  agentSessionTranscript,
  type AgentSessionSummary,
} from "../ipc";
import type { AgentId, AgentItem } from "./types";

/**
 * Past conversations, per agent and folder.
 *
 * The listing itself is a backend read of the CLI's own session store (see
 * `agent_sessions.rs`); this module is the front-end's memory of it, so the
 * picker opens instantly on a second visit and a pane remount does not re-walk
 * a few hundred transcripts. Entries are re-fetched whenever the picker asks,
 * with the cached rows shown while that runs — a session list is never so
 * wrong that showing it briefly is worse than showing a spinner.
 */

export type { AgentSessionSummary };

// Guarded for the test runner, which has no DOM: the pure helpers here are
// worth exercising without one.
const TAURI_RUNTIME = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Agents whose past sessions Duckweed can both find and resume.
 *
 * Cursor Agent is the exception: its chats live in an undocumented SQLite
 * store and its ACP mode has no listing, so there is nothing honest to put in
 * a picker. It stays off this list rather than opening an empty one.
 */
const RESUMABLE: AgentId[] = ["claude", "codex", "grok", "opencode", "antigravity"];

export function canResume(agent: AgentId): boolean {
  return RESUMABLE.includes(agent);
}

const cache = new Map<string, AgentSessionSummary[]>();

export function historyKey(agent: AgentId, cwd: string): string {
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd);
  const normalized = windowsPath
    ? cwd.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
    : cwd.replace(/\/+$/, "");
  return `${agent}\0${normalized}`;
}

/** Rows from the last successful listing, or null when there has been none. */
export function cached(agent: AgentId, cwd: string): AgentSessionSummary[] | null {
  return cache.get(historyKey(agent, cwd)) ?? null;
}

/** Read the agent's session store. Resolves to `[]` when it has nothing. */
export async function list(agent: AgentId, cwd: string): Promise<AgentSessionSummary[]> {
  if (!TAURI_RUNTIME || !canResume(agent) || !cwd) return [];
  const sessions = await agentSessionsList(agent, cwd);
  cache.set(historyKey(agent, cwd), sessions);
  return sessions;
}

/** The most recent session, for `--continue` at launch. */
export async function latest(agent: AgentId, cwd: string): Promise<AgentSessionSummary | null> {
  const sessions = await list(agent, cwd).catch(() => []);
  return sessions[0] ?? null;
}

/** Visible historical turns for agents whose resume protocol does not replay them. */
export async function transcript(
  agent: AgentId,
  cwd: string,
  sessionId: string,
): Promise<AgentItem[]> {
  if (!TAURI_RUNTIME || !sessionId || !cwd) return [];
  return agentSessionTranscript(agent, cwd, sessionId);
}

/** "just now", "12m ago", "3d ago" — a picker row has no space for a date. */
export function timeAgo(millis: number, now = Date.now()): string {
  if (!millis) return "";
  const seconds = Math.max(0, Math.round((now - millis) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
