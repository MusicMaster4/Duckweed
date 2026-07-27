import { Channel } from "@tauri-apps/api/core";

import {
  agentProcCloseStdin,
  agentProcProbe,
  agentProcSend,
  agentProcStart,
  agentProcStop,
  type AgentFrame,
} from "../ipc";
import type { AdapterContext, AgentAdapter } from "./adapter";
import { createAcpAdapter } from "./adapters/acp";
import { createClaudeAdapter } from "./adapters/claude";
import { createCodexAdapter } from "./adapters/codex";
import { AGENTS, AGENT_IDS } from "./catalog";
import { applyEvent, type AgentEvent } from "./events";
import type { AgentLaunch } from "./launch";
import { fallbackCommands } from "./slashCatalog";
import { emptyUsage, type AgentId, type AgentSessionState } from "./types";

/**
 * One agent session per terminal.
 *
 * A session outlives the React tree that renders it — panes remount on every
 * split, drag, and zoom, exactly like the terminals this module sits beside —
 * so the state lives here and components subscribe to it. That is the same
 * arrangement `terminals.ts` uses for xterm, for the same reason.
 */

const TAURI_RUNTIME = "__TAURI_INTERNALS__" in window;

interface Session {
  termId: string;
  state: AgentSessionState;
  adapter: AgentAdapter;
  context: AdapterContext;
  launch: AgentLaunch;
  listeners: Set<() => void>;
  /** Diagnostics kept only to explain a start that never got anywhere. */
  stderr: string[];
  /** Prompts submitted before the handshake finished. */
  queued: string[];
  /** Unsent composer text, so a pane remount never loses a draft. */
  draft: string;
  /** Coalesces streamed deltas into one notification per frame. */
  notifyHandle: number | null;
  disposed: boolean;
}

const sessions = new Map<string, Session>();
const globalListeners = new Set<() => void>();

/** Subscribe to "any session appeared, changed, or ended". */
export function subscribeAll(callback: () => void): () => void {
  globalListeners.add(callback);
  return () => globalListeners.delete(callback);
}

export function subscribe(termId: string, callback: () => void): () => void {
  const session = sessions.get(termId);
  if (!session) {
    // The pane can subscribe before the session exists (or after it ended);
    // the global channel still tells it when that changes.
    return subscribeAll(callback);
  }
  session.listeners.add(callback);
  return () => {
    session.listeners.delete(callback);
  };
}

export function get(termId: string): AgentSessionState | null {
  return sessions.get(termId)?.state ?? null;
}

export function isActive(termId: string): boolean {
  return sessions.has(termId);
}

/** Every terminal currently showing the custom agent UI. */
export function activeTermIds(): string[] {
  return [...sessions.keys()];
}

export function getDraft(termId: string): string {
  return sessions.get(termId)?.draft ?? "";
}

export function setDraft(termId: string, text: string): void {
  const session = sessions.get(termId);
  if (session) session.draft = text;
}

function notify(session: Session): void {
  if (session.notifyHandle !== null) return;
  session.notifyHandle = window.requestAnimationFrame(() => {
    session.notifyHandle = null;
    for (const listener of session.listeners) listener();
    for (const listener of globalListeners) listener();
  });
}

/** Flush any pending notification immediately — used when a session ends. */
function notifyNow(session: Session): void {
  if (session.notifyHandle !== null) {
    window.cancelAnimationFrame(session.notifyHandle);
    session.notifyHandle = null;
  }
  for (const listener of session.listeners) listener();
  for (const listener of globalListeners) listener();
}

function createAdapter(agent: AgentId): AgentAdapter {
  switch (AGENTS[agent].protocol) {
    case "claude-stream-json":
      return createClaudeAdapter();
    case "codex-app-server":
      return createCodexAdapter();
    case "acp":
      return createAcpAdapter();
  }
}

/**
 * Which agents are installed.
 *
 * Probed once and cached: the answer gates whether typing `claude` opens the
 * custom UI, so it has to be available synchronously by the time a command is
 * submitted, and a PATH lookup does not change while the app is open.
 */
let availabilityProbe: Promise<Set<AgentId>> | null = null;
let availableAgents: Set<AgentId> = new Set();
let availabilityKnown = false;

export function probeAvailability(): Promise<Set<AgentId>> {
  if (availabilityProbe) return availabilityProbe;
  if (!TAURI_RUNTIME) {
    availabilityProbe = Promise.resolve(new Set());
    return availabilityProbe;
  }
  const names = AGENT_IDS.flatMap((id) => AGENTS[id].binaries);
  availabilityProbe = agentProcProbe(names)
    .then((found) => {
      const installed = new Set(
        found.filter((entry) => entry.path !== null).map((entry) => entry.name),
      );
      availableAgents = new Set(
        AGENT_IDS.filter((id) => AGENTS[id].binaries.some((binary) => installed.has(binary))),
      );
      availabilityKnown = true;
      return availableAgents;
    })
    .catch(() => new Set<AgentId>());
  return availabilityProbe;
}

/**
 * Whether the custom UI should claim a launch of `agent`, decided
 * synchronously because a command submit cannot wait.
 *
 * Until the probe lands the answer is yes: a failed spawn falls back to the
 * shell with an explanation, which is a far better outcome than a race in
 * which typing `claude` two seconds after the app opens quietly behaves
 * differently from typing it later.
 */
export function isAvailable(agent: AgentId): boolean {
  return availabilityKnown ? availableAgents.has(agent) : true;
}

/**
 * Send a prompt the session is ready for. Slash commands get first refusal:
 * an adapter that can run one itself (a model switch over RPC, a local
 * answer) says so, and anything else flows on as a normal prompt for agents
 * that read slash text themselves.
 */
function dispatch(session: Session, text: string): void {
  if (text.startsWith("/") && session.adapter.command?.(text, session.context) === "handled") {
    return;
  }
  session.adapter.prompt(text, session.context);
}

function emit(session: Session, event: AgentEvent): void {
  if (session.disposed) return;
  const next = applyEvent(session.state, event);
  if (next === session.state) return;
  session.state = next;
  // A prompt sent before the handshake landed, or while a turn was still
  // running, waits here. Exactly one is released per idle moment: every
  // protocol we speak runs one turn at a time, so pushing the whole backlog
  // would just make the agent reject the rest.
  if (next.status === "idle" && session.queued.length > 0) {
    const text = session.queued.shift() as string;
    session.state = applyEvent(session.state, { type: "unqueue" });
    dispatch(session, text);
  }
  notify(session);
}

function handleFrame(session: Session, frame: AgentFrame): void {
  if (session.disposed) return;
  switch (frame.kind) {
    case "stdout":
      session.adapter.receive(frame.line, session.context);
      return;
    case "stderr":
      session.stderr.push(frame.line);
      if (session.stderr.length > 50) session.stderr.shift();
      return;
    case "exit": {
      const ready = session.state.status !== "starting" && session.state.status !== "error";
      if (!ready) {
        // Never got going: the stderr tail is the only explanation there is.
        const detail = session.stderr.slice(-6).join("\n").trim();
        emit(session, {
          type: "status",
          status: "error",
          error:
            detail ||
            `${session.state.label} exited${frame.code === null ? "" : ` with code ${frame.code}`} before it was ready.`,
        });
      } else {
        emit(session, { type: "status", status: "exited" });
      }
      notifyNow(session);
      return;
    }
  }
}

/**
 * Replace a terminal's shell command with a live agent session.
 *
 * Resolves to null once the agent is running, or to the reason it could not
 * start. The caller falls back to running the command in the shell — an agent
 * the custom UI cannot drive must never become a command that silently did
 * nothing — and the reason is what stops that fallback from hiding a bug.
 */
export async function start(
  termId: string,
  launch: AgentLaunch,
  cwd: string,
): Promise<string | null> {
  if (sessions.has(termId)) return null;
  if (!TAURI_RUNTIME) return "the custom agent UI needs the desktop app";

  const definition = AGENTS[launch.agent];
  const adapter = createAdapter(launch.agent);

  const session: Session = {
    termId,
    adapter,
    launch,
    listeners: new Set(),
    stderr: [],
    queued: [],
    draft: "",
    notifyHandle: null,
    disposed: false,
    state: {
      termId,
      agent: launch.agent,
      label: definition.label,
      status: "starting",
      cwd,
      model: launch.model,
      effort: launch.effort,
      sessionId: null,
      items: [],
      pending: [],
      permission: null,
      usage: emptyUsage(),
      error: null,
      // Live advertisements merge over this list as they arrive; the composer
      // never has to wait on the protocol to answer `/`.
      commands: fallbackCommands(launch.agent),
      started: false,
    },
    context: {
      cwd,
      launch,
      send: (message) => {
        void agentProcSend(termId, JSON.stringify(message)).catch(() => {
          // The agent is gone; the exit frame is already on its way and will
          // put the pane into its ended state.
        });
      },
      emit: (event) => emit(session, event),
    },
  };

  sessions.set(termId, session);
  for (const listener of globalListeners) listener();

  const channel = new Channel<AgentFrame>();
  channel.onmessage = (frame) => handleFrame(session, frame);

  try {
    await agentProcStart(
      termId,
      {
        program: definition.binaries[0],
        args: [...definition.headlessArgs, ...adapter.args(launch)],
        cwd,
      },
      channel,
    );
  } catch (error) {
    sessions.delete(termId);
    for (const listener of globalListeners) listener();
    return error instanceof Error ? error.message : String(error);
  }

  adapter.start(session.context);
  if (launch.prompt) submit(termId, launch.prompt);
  return null;
}

export function submit(termId: string, text: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  session.draft = "";
  if (session.state.status === "exited" || session.state.status === "error") return;
  if (session.state.status !== "idle") {
    // Still handshaking, or mid-turn. Hold it and show it holding, so the
    // pane never looks like it swallowed a prompt.
    session.queued.push(trimmed);
    emit(session, { type: "queue", text: trimmed });
    return;
  }
  dispatch(session, trimmed);
}

export function interrupt(termId: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  session.adapter.interrupt(session.context);
}

export function respond(termId: string, permissionId: string, optionId: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  session.adapter.respond(permissionId, optionId, session.context);
}

/** End the session and hand the pane back to its terminal. */
export function stop(termId: string): void {
  const session = sessions.get(termId);
  if (!session) return;
  session.disposed = true;
  sessions.delete(termId);
  if (TAURI_RUNTIME) {
    // Agents that end on EOF get the chance to shut down cleanly; the kill
    // that follows is the backstop for the ones that do not.
    if (session.adapter.endsOnStdinClose) void agentProcCloseStdin(termId).catch(() => {});
    void agentProcStop(termId).catch(() => {});
  }
  notifyNow(session);
}

export function stopAll(): void {
  for (const termId of [...sessions.keys()]) stop(termId);
}
