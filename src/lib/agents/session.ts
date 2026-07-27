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
import { applyEvent, isTurnEnd, type AgentEvent } from "./events";
import { latest as latestSession } from "./history";
import type { AgentLaunch } from "./launch";
import { loadClaudeSettingsDefaults } from "./claudeSettings";
import { fallbackCommands, fallbackModels } from "./slashCatalog";
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
  /** Diagnostics kept only to explain a start that never got anywhere. */
  stderr: string[];
  /** Prompts submitted before the handshake finished. */
  queued: string[];
  /** Unsent composer text, so a pane remount never loses a draft. */
  draft: string;
  /**
   * A conversation to pick up as soon as the handshake finishes. Resuming
   * before the agent is ready would be answered with "no session", and the
   * user may have asked for it (`--continue`) before there was a protocol to
   * ask on.
   */
  pendingResume: { id: string; title: string } | null;
  /** Coalesces streamed deltas into one notification per frame. */
  notifyHandle: number | null;
  /**
   * The user interrupted the turn in flight. The idle that follows is them
   * stopping the agent, not the agent finishing, so it must not be announced.
   */
  interrupted: boolean;
  disposed: boolean;
}

const sessions = new Map<string, Session>();
/**
 * Subscribers per pane, kept outside the session they watch.
 *
 * Resuming a Claude conversation means relaunching the CLI, which replaces the
 * `Session` object behind a pane that never unmounted. Listeners stored on the
 * session would go with it and the pane would freeze on the old transcript, so
 * they live here — keyed by terminal id, which is the thing that persists.
 */
const paneListeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();
const turnEndListeners = new Set<(termId: string) => void>();

/**
 * "This pane finished a turn, or is now blocked on the user."
 *
 * The protocol says so directly here — no log tailing, no heuristics — which
 * makes it the most precise completion signal in the app. `terminals` turns it
 * into the same sound and unread marker a raw CLI pane gets.
 */
export function subscribeTurnEnd(callback: (termId: string) => void): () => void {
  turnEndListeners.add(callback);
  return () => turnEndListeners.delete(callback);
}

function announceTurnEnd(session: Session): void {
  for (const listener of turnEndListeners) listener(session.termId);
}

/** Subscribe to "any session appeared, changed, or ended". */
export function subscribeAll(callback: () => void): () => void {
  globalListeners.add(callback);
  return () => globalListeners.delete(callback);
}

export function subscribe(termId: string, callback: () => void): () => void {
  let listeners = paneListeners.get(termId);
  if (!listeners) {
    listeners = new Set();
    paneListeners.set(termId, listeners);
  }
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) paneListeners.delete(termId);
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

function announce(termId: string): void {
  const listeners = paneListeners.get(termId);
  if (listeners) for (const listener of [...listeners]) listener();
  for (const listener of globalListeners) listener();
}

function notify(session: Session): void {
  if (session.notifyHandle !== null) return;
  session.notifyHandle = window.requestAnimationFrame(() => {
    session.notifyHandle = null;
    announce(session.termId);
  });
}

/** Flush any pending notification immediately — used when a session ends. */
function notifyNow(session: Session): void {
  if (session.notifyHandle !== null) {
    window.cancelAnimationFrame(session.notifyHandle);
    session.notifyHandle = null;
  }
  announce(session.termId);
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
  // Whatever the last turn's ending was, this one is the user's own request.
  session.interrupted = false;
  if (text.startsWith("/") && session.adapter.command?.(text, session.context) === "handled") {
    return;
  }
  session.adapter.prompt(text, session.context);
}

function emit(session: Session, event: AgentEvent): void {
  if (session.disposed) return;
  const before = session.state.status;
  const next = applyEvent(session.state, event);
  if (next === session.state) return;
  session.state = next;

  // A resume waiting on the handshake goes first: a prompt released into the
  // new session must land in the conversation the user asked to continue.
  if (next.status === "idle" && session.pendingResume) {
    const wanted = session.pendingResume;
    session.pendingResume = null;
    notify(session);
    applyResume(session, wanted.id, wanted.title);
    return;
  }

  // A prompt sent before the handshake landed, or while a turn was still
  // running, waits here. Exactly one is released per idle moment: every
  // protocol we speak runs one turn at a time, so pushing the whole backlog
  // would just make the agent reject the rest.
  const releasingQueued = next.status === "idle" && session.queued.length > 0;
  const ended = isTurnEnd({
    before,
    after: next.status,
    permission: next.permission !== null,
    releasingQueued,
    interrupted: session.interrupted,
  });
  if (releasingQueued) {
    const text = session.queued.shift() as string;
    session.state = applyEvent(session.state, { type: "unqueue" });
    dispatch(session, text);
  }
  notify(session);

  // The interrupt is spent on the idle it produced, so the next real turn end
  // is announced normally.
  if (next.status === "idle") session.interrupted = false;
  if (ended) announceTurnEnd(session);
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
    stderr: [],
    queued: [],
    draft: "",
    pendingResume: null,
    notifyHandle: null,
    interrupted: false,
    disposed: false,
    state: {
      termId,
      agent: launch.agent,
      label: definition.label,
      status: "starting",
      cwd,
      model: launch.model,
      effort: launch.effort,
      // Live model lists from the adapter replace this; Claude starts with
      // its known aliases so the picker works before the first turn.
      models: fallbackModels(launch.agent),
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
  announce(termId);

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
    announce(termId);
    return error instanceof Error ? error.message : String(error);
  }

  adapter.start(session.context);

  // Claude only reports model/effort on the first turn's system/init. Until
  // then, seed the header and pickers from the same settings file the real
  // TUI reads (`~/.claude/settings.json`), overridden by launch flags.
  if (launch.agent === "claude") {
    void loadClaudeSettingsDefaults().then((defaults) => {
      if (session.disposed) return;
      const model = launch.model ?? defaults.model;
      const effort = launch.effort ?? defaults.effort;
      if (!model && !effort) return;
      // Don't clobber values the adapter already learned from the wire.
      const nextModel = session.state.model ?? model;
      const nextEffort = session.state.effort ?? effort;
      if (nextModel === session.state.model && nextEffort === session.state.effort) return;
      emit(session, {
        type: "session",
        ...(nextModel ? { model: nextModel } : {}),
        ...(nextEffort ? { effort: nextEffort } : {}),
      });
    });
  }

  // `--continue` / `--resume <id>` for the agents that resume over their
  // protocol. Claude took the same request as a launch flag above, so it is
  // already resuming and must not be asked twice.
  if (adapter.resume && (launch.resumeId || launch.resume)) {
    if (launch.resumeId) {
      session.pendingResume = { id: launch.resumeId, title: "" };
    } else {
      void latestSession(launch.agent, cwd).then((found) => {
        if (session.disposed || !found) return;
        // The handshake may already be done; `pendingResume` is only read on
        // the transition into idle, so a late answer applies itself.
        if (session.state.status === "starting") {
          session.pendingResume = { id: found.id, title: found.title };
        } else {
          applyResume(session, found.id, found.title);
        }
      });
    }
  }

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

/**
 * Hand a stored conversation to a running agent, in whatever way it accepts
 * one. Emits the transcript marker only once the agent has taken it.
 */
function applyResume(session: Session, sessionId: string, title: string): void {
  if (session.adapter.resume?.(sessionId, session.context)) {
    emit(session, { type: "resumed", sessionId, title });
    return;
  }
  // An ACP agent that never advertised `loadSession`, and no CLI flag to fall
  // back on in its headless mode. Saying so beats a picker that does nothing.
  emit(session, {
    type: "notice",
    tone: "error",
    text: `${session.state.label} cannot resume a session from the custom UI.`,
  });
}

/**
 * Continue a past conversation in this pane.
 *
 * Two shapes, decided by the adapter: Codex and the ACP agents swap threads
 * over their protocol, so the process (and everything it has already learned)
 * survives. Claude has no such method — its resume is a launch flag — so the
 * CLI is relaunched with `--resume <id>` and the pane starts a fresh
 * transcript against the same conversation.
 *
 * Resolves to null on success, or the reason it could not happen.
 */
export async function resume(
  termId: string,
  sessionId: string,
  title = "",
): Promise<string | null> {
  const session = sessions.get(termId);
  if (!session || session.disposed) return "this pane has no agent session";
  if (!sessionId) return "no session was chosen";

  // Swapping the conversation under a running turn would strand it — the
  // agent would go on working against a thread nothing is listening to.
  if (session.state.status === "working" || session.state.status === "waiting") {
    emit(session, {
      type: "notice",
      tone: "error",
      text: "Stop the current turn before resuming another session.",
    });
    return null;
  }

  if (session.adapter.resume) {
    if (session.state.status === "starting") {
      // Not ready to be told anything yet; the handshake picks this up.
      session.pendingResume = { id: sessionId, title };
      return null;
    }
    applyResume(session, sessionId, title);
    return null;
  }

  // Relaunch path (Claude). Everything typed at launch is kept except the
  // opening prompt, which already ran in the session being replaced.
  const { launch } = session;
  const cwd = session.state.cwd;
  // Awaited, not fired and forgotten: the backend refuses a second process
  // under the same pane id, so the old one has to be gone first. Nothing is
  // announced in between either — a pane that blinked back to its shell and
  // then to the agent would read as a crash.
  session.disposed = true;
  sessions.delete(termId);
  if (TAURI_RUNTIME) {
    if (session.adapter.endsOnStdinClose) {
      await agentProcCloseStdin(termId).catch(() => {});
    }
    await agentProcStop(termId).catch(() => {});
  }
  const failure = await start(
    termId,
    { ...launch, prompt: null, resume: false, resumeId: sessionId },
    cwd,
  );
  if (failure) {
    announce(termId);
    return failure;
  }
  const restarted = sessions.get(termId);
  if (restarted) emit(restarted, { type: "resumed", sessionId, title });
  return null;
}

export function interrupt(termId: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  session.interrupted = true;
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
