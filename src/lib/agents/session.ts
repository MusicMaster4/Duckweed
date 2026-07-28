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
import { AGENTS, agentPresentation } from "./catalog";
import {
  applyEvent,
  didStatusEnterIdle,
  isAnnounceableTurn,
  isTurnEnd,
  type AgentEvent,
} from "./events";
import { latest as latestSession, transcript as sessionTranscript } from "./history";
import { AGENT_PROGRAMS, type AgentLaunch } from "./launch";
import { loadClaudeSettingsDefaults } from "./claudeSettings";
import {
  rememberPreferences,
  withRememberedPreferences,
} from "./preferences";
import {
  claudexDefaultModel,
  fallbackCommands,
  fallbackModels,
  formatSessionUsage,
  isClaudexProgram,
} from "./slashCatalog";
import {
  emptyUsage,
  type AgentAccessMode,
  type AgentId,
  type AgentFollowupMode,
  type AgentImageAttachment,
  type AgentItem,
  type AgentPrompt,
  type AgentQuestionAnswer,
  type AgentSessionState,
} from "./types";

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
  /** Prompts submitted before the handshake finished or while a turn runs. */
  queued: Array<{ id: string; prompt: AgentPrompt; echoed: boolean }>;
  /** Unsent composer content, so a pane remount never loses a draft. */
  draft: string;
  draftImages: AgentImageAttachment[];
  /**
   * Prompts submitted in this pane only (oldest first). Used by ↑/↓ history
   * in the custom agent composer — same idea as the shell's per-pane history.
   */
  promptHistory: string[];
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
  /**
   * A user prompt opened the current working stretch. Cleared when the turn
   * returns to idle so a later synthetic working→idle (resume, load) cannot
   * reuse the flag and fire a completion for work nobody asked for.
   */
  userInitiatedTurn: boolean;
  /** A picker command is negotiating with the CLI without becoming a chat turn. */
  configuring: boolean;
  /** Increments whenever real user work starts, invalidating late picker notices. */
  interactionEpoch: number;
  /** Claude/Grok mirror their TUI's two-press exit gesture. */
  exitArmedUntil: number;
  disposed: boolean;
}

const sessions = new Map<string, Session>();
let followupMode: AgentFollowupMode = "queue";
let queuedPromptSequence = 0;

function nextQueuedPromptId(): string {
  queuedPromptSequence += 1;
  return `queued-${Date.now().toString(36)}-${queuedPromptSequence.toString(36)}`;
}

export function setFollowupMode(mode: AgentFollowupMode): void {
  followupMode = mode;
}

export function getFollowupMode(): AgentFollowupMode {
  return followupMode;
}
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
const turnStartListeners = new Set<(termId: string) => void>();

/**
 * "This pane finished a turn, or is now blocked on the user."
 *
 * The protocol says so directly here — no log tailing, no heuristics — which
 * makes it the most precise completion signal in the app. `terminals` turns it
 * into the same sound and unread marker a raw CLI pane gets. Only announceable
 * ends are forwarded — see {@link isAnnounceableTurn}.
 */
export function subscribeTurnEnd(callback: (termId: string) => void): () => void {
  turnEndListeners.add(callback);
  return () => turnEndListeners.delete(callback);
}

/**
 * "This pane just began working on a user-facing turn."
 *
 * Used to start the completion-duration clock per turn rather than once at
 * session launch — otherwise a short `/effort` after a long session looks like
 * a job that ran for the whole session.
 */
export function subscribeTurnStart(callback: (termId: string) => void): () => void {
  turnStartListeners.add(callback);
  return () => turnStartListeners.delete(callback);
}

function announceTurnEnd(session: Session): void {
  for (const listener of turnEndListeners) listener(session.termId);
}

function announceTurnStart(session: Session): void {
  for (const listener of turnStartListeners) listener(session.termId);
}

/**
 * Facts about the turn that just became idle, read from the transcript.
 *
 * Walks back from the newest item to the latest user message — that stretch is
 * the turn. Notices alone are not tools; `/effort`-style handlers use them to
 * confirm, and those stays silent via {@link isMetaSlashCommand}.
 */
function inspectTurn(items: AgentItem[]): {
  usedTools: boolean;
  userText: string | null;
} {
  let usedTools = false;
  let userText: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "user") {
      userText = item.text;
      break;
    }
    if (item.kind === "tool") usedTools = true;
  }
  return { usedTools, userText };
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

export function getDraftImages(termId: string): AgentImageAttachment[] {
  return sessions.get(termId)?.draftImages ?? [];
}

export function setDraftImages(termId: string, images: AgentImageAttachment[]): void {
  const session = sessions.get(termId);
  if (session) session.draftImages = [...images];
}

/** Max prompts kept for per-pane ↑/↓ history in the agent composer. */
const MAX_PROMPT_HISTORY = 200;

/**
 * Record a submitted prompt for ↑/↓ navigation. Consecutive duplicates collapse
 * to a single newest entry (shell-style). Empty/whitespace-only is ignored.
 */
function recordPromptHistory(session: Session, text: string): void {
  const trimmed = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (!trimmed.trim()) return;
  const last = session.promptHistory[session.promptHistory.length - 1];
  if (last === trimmed) return;
  session.promptHistory = [...session.promptHistory, trimmed].slice(-MAX_PROMPT_HISTORY);
}

/**
 * Prompts submitted in this agent pane, oldest first — for ↑/↓ history.
 * Distinct from the follow-up queue and from the transcript items.
 */
export function localPromptHistory(termId: string): readonly string[] {
  return sessions.get(termId)?.promptHistory ?? [];
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
let availabilityProbe: Promise<Set<string>> | null = null;
let availablePrograms: Set<string> = new Set();
let availabilityKnown = false;

export function probeAvailability(): Promise<Set<string>> {
  if (availabilityProbe) return availabilityProbe;
  if (!TAURI_RUNTIME) {
    availabilityProbe = Promise.resolve(new Set());
    return availabilityProbe;
  }
  availabilityProbe = agentProcProbe([...AGENT_PROGRAMS])
    .then((found) => {
      availablePrograms = new Set(
        found.filter((entry) => entry.path !== null).map((entry) => entry.name),
      );
      availabilityKnown = true;
      return availablePrograms;
    })
    .catch(() => new Set<string>());
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
export function isAvailable(launch: AgentLaunch): boolean {
  if (!availabilityKnown) return true;
  // Explicit paths cannot be known during the startup probe. Let the backend
  // resolve the exact path and fall back to the shell if it no longer exists.
  if (/[\\/]/.test(launch.program) || /\.(?:exe|cmd|bat|ps1)$/i.test(launch.program)) return true;
  return availablePrograms.has(launch.program.toLowerCase());
}

/**
 * Send a prompt the session is ready for. Slash commands get first refusal:
 * an adapter that can run one itself (a model switch over RPC, a local
 * answer) says so, and anything else flows on as a normal prompt for agents
 * that read slash text themselves.
 */
function contextWithoutUserEcho(session: Session): AdapterContext {
  return {
    ...session.context,
    emit: (event) => {
      if (event.type !== "user") session.context.emit(event);
    },
  };
}

function dispatch(session: Session, prompt: AgentPrompt, echoUser = true): void {
  // Whatever the last turn's ending was, this one is the user's own request.
  session.interrupted = false;
  const context = echoUser ? session.context : contextWithoutUserEcho(session);
  if (prompt.images.length === 0 && /^\/usage$/i.test(prompt.text.trim())) {
    emit(session, {
      type: "notice",
      tone: "info",
      text: formatSessionUsage(session.state.usage),
    });
    return;
  }
  if (
    prompt.images.length === 0 &&
    prompt.text.startsWith("/") &&
    session.adapter.command?.(prompt.text, context) === "handled"
  ) {
    // Local answer only (notice, model switch over RPC). No working stretch,
    // so nothing to announce when it "finishes".
    return;
  }
  // Everything that reaches `prompt` is a user-opened turn, including slash
  // text the CLI will interpret (`/effort high` on Claude, advertised ACP
  // commands). Announceability still filters pure meta slashes later.
  session.userInitiatedTurn = true;
  session.interactionEpoch += 1;
  session.adapter.prompt(prompt, context);
}

function emit(session: Session, event: AgentEvent): void {
  if (session.disposed) return;

  // Claude applies /effort as a tiny protocol turn. Keep that implementation
  // detail out of the UI: no red Stop flicker, no working badge, and no
  // completion sound. A prompt submitted meanwhile waits a few milliseconds
  // and is released as soon as the result frame closes the config turn.
  if (session.configuring) {
    if (event.type === "user") return;
    if (event.type === "status" && event.status === "working") return;
    if (event.type === "notice") event = { ...event, transient: true };
    if (event.type === "turn-end") {
      session.configuring = false;
      const queued = session.queued.shift();
      if (queued) {
        if (!queued.echoed) {
          session.state = applyEvent(session.state, { type: "unqueue", id: queued.id });
        }
        dispatch(session, queued.prompt, !queued.echoed);
      }
      notify(session);
      return;
    }
  }

  const before = session.state.status;
  const next = applyEvent(session.state, event);
  if (next === session.state) return;
  if (
    event.type === "session" &&
    (next.model !== session.state.model ||
      next.effort !== session.state.effort ||
      next.accessMode !== session.state.accessMode)
  ) {
    rememberPreferences(session.launch, {
      model: next.model,
      effort: next.effort,
      accessMode: next.accessMode ?? "default",
    });
  }
  session.state = next;

  // A resume waiting on the handshake goes first: a prompt released into the
  // new session must land in the conversation the user asked to continue.
  if (next.status === "idle" && session.pendingResume) {
    const wanted = session.pendingResume;
    session.pendingResume = null;
    notify(session);
    void applyResume(session, wanted.id, wanted.title);
    return;
  }

  // Fresh work starts the completion clock. `waiting` → `working` is the user
  // answering a permission prompt mid-turn, not a new job.
  if (
    next.status === "working" &&
    (before === "idle" || before === "starting")
  ) {
    announceTurnStart(session);
  }

  // A prompt sent before the handshake landed, or while a turn was still
  // running, waits here. Exactly one is released per idle moment: every
  // protocol we speak runs one turn at a time, so pushing the whole backlog
  // would just make the agent reject the rest.
  const releasingQueued = next.status === "idle" && session.queued.length > 0;
  const turnEnd = {
    before,
    after: next.status,
    permission: next.permission !== null,
    releasingQueued,
    interrupted: session.interrupted,
    userInitiated: session.userInitiatedTurn,
    ...inspectTurn(next.items),
  };
  const ended = isTurnEnd(turnEnd);

  // Spend the flags that belonged to the turn which just became idle before
  // releasing a queued prompt. `dispatch` starts the next turn synchronously
  // and gives it fresh flags; clearing them afterwards would make that real
  // user turn look like a synthetic resume/load when it eventually finishes.
  if (didStatusEnterIdle(before, next.status)) {
    session.interrupted = false;
    session.userInitiatedTurn = false;
  }

  if (releasingQueued) {
    const queued = session.queued.shift() as {
      id: string;
      prompt: AgentPrompt;
      echoed: boolean;
    };
    if (!queued.echoed) {
      session.state = applyEvent(session.state, { type: "unqueue", id: queued.id });
    }
    dispatch(session, queued.prompt, !queued.echoed);
  }
  notify(session);

  // Config slash commands and synthetic idles still end the turn for the
  // protocol — they just do not earn a sound or unread flash.
  if (ended && isAnnounceableTurn(turnEnd)) {
    announceTurnEnd(session);
  }
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

  // Explicit launch flags win field by field and become the next remembered
  // choice. Everything omitted inherits the last choice for this exact CLI.
  rememberPreferences(launch, {
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort ? { effort: launch.effort } : {}),
  });
  launch = withRememberedPreferences(launch);

  const definition = AGENTS[launch.agent];
  const adapter = createAdapter(launch.agent);
  const presentation = agentPresentation(launch.agent, launch.program);
  // Claudex injects a default model when none was typed; surface that before
  // the first turn so the header/picker match the process that actually runs.
  const seedModel =
    launch.model ??
    (isClaudexProgram(launch.program) ? claudexDefaultModel(launch.wrapperArgs) : null);

  const session: Session = {
    termId,
    adapter,
    launch,
    stderr: [],
    queued: [],
    draft: "",
    draftImages: [],
    promptHistory: [],
    pendingResume: null,
    notifyHandle: null,
    interrupted: false,
    userInitiatedTurn: false,
    configuring: false,
    interactionEpoch: 0,
    exitArmedUntil: 0,
    disposed: false,
    state: {
      termId,
      agent: launch.agent,
      program: launch.program,
      label: presentation.label,
      mark: presentation.mark,
      accent: presentation.accent,
      status: "starting",
      workStartedAt: null,
      lastWorkedForMs: null,
      cwd,
      model: seedModel,
      effort: launch.effort,
      accessMode: launch.accessMode ?? "default",
      // Live model lists from the adapter replace this; Claude/Claudex start
      // with their known aliases so the picker works before the first turn.
      models: fallbackModels(launch.agent, launch.program),
      sessionId: null,
      items: [],
      pending: [],
      permission: null,
      usage: emptyUsage(),
      error: null,
      // Live advertisements merge over this list as they arrive; the composer
      // never has to wait on the protocol to answer `/`.
      commands: fallbackCommands(launch.agent, launch.program),
      started: false,
      exitArmed: false,
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
        // Prefer the typed executable so wrappers like `claudex` still set their
        // proxy env before re-execing Claude Code. Canonical binaries remain the
        // fallback when a profile alias was resolved to one.
        program: launch.program,
        // Wrapper flags (`claudex --g`) must precede headless protocol args so
        // the wrapper can strip them before handing the rest to Claude.
        args: [
          ...launch.wrapperArgs,
          ...launch.forwardArgs,
          ...definition.headlessArgs,
          ...adapter.args(launch),
        ],
        cwd,
        env: Object.keys(launch.env).length ? launch.env : null,
      },
      channel,
    );
  } catch (error) {
    if (sessions.get(termId) !== session) return null;
    sessions.delete(termId);
    announce(termId);
    return error instanceof Error ? error.message : String(error);
  }

  if (session.disposed || sessions.get(termId) !== session) {
    await agentProcStop(termId).catch(() => {});
    return null;
  }

  adapter.start(session.context);

  // Claude only reports model/effort on the first turn's system/init. Until
  // then, seed the header and pickers from the same settings file the real
  // TUI reads (`~/.claude/settings.json`), overridden by launch flags.
  // Claudex deliberately skips that file: plain-Claude model aliases there
  // (opus/sonnet/…) are wrong for the proxy, and the wrapper restores them
  // on exit so a Claudex session must not adopt them as defaults either.
  if (launch.agent === "claude" && !isClaudexProgram(launch.program)) {
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
          void applyResume(session, found.id, found.title);
        }
      });
    }
  }

  if (launch.prompt) submit(termId, launch.prompt);
  return null;
}

type FollowupDelivery = "default" | "alternate";

function queuePrompt(session: Session, prompt: AgentPrompt, echoed = false): string {
  const id = nextQueuedPromptId();
  session.queued.push({ id, prompt, echoed });
  if (!echoed) {
    emit(session, {
      type: "queue",
      prompt: { id, text: prompt.text, images: [...prompt.images] },
    });
  }
  return id;
}

function restoreAfterFailedSteer(session: Session, prompt: AgentPrompt): void {
  if (session.disposed) return;
  if (session.adapter.steer) {
    emit(session, {
      type: "notice",
      tone: "error",
      text: "The active turn could not be steered. The message was kept for the next turn.",
    });
  }
  if (session.state.status === "idle") {
    dispatch(session, prompt);
  } else if (session.state.status !== "exited" && session.state.status !== "error") {
    queuePrompt(session, prompt);
  }
}

function steerPrompt(session: Session, prompt: AgentPrompt): void {
  if (!session.adapter.steer) {
    restoreAfterFailedSteer(session, prompt);
    return;
  }
  void Promise.resolve(session.adapter.steer(prompt, session.context))
    .then((accepted) => {
      if (!accepted) restoreAfterFailedSteer(session, prompt);
    })
    .catch(() => restoreAfterFailedSteer(session, prompt));
}

export function submit(
  termId: string,
  text: string,
  images: AgentImageAttachment[] = [],
  delivery: FollowupDelivery = "default",
): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) return;
  const prompt: AgentPrompt = { text: trimmed, images: [...images] };
  if (session.exitArmedUntil > 0) {
    session.exitArmedUntil = 0;
    emit(session, { type: "exit-armed", armed: false });
  }
  session.draft = "";
  session.draftImages = [];
  if (session.state.status === "exited" || session.state.status === "error") return;
  // Record before usage/queue/steer paths so ↑ can recall it like a shell command.
  recordPromptHistory(session, trimmed);
  if (images.length === 0 && /^\/usage$/i.test(trimmed)) {
    emit(session, {
      type: "notice",
      tone: "info",
      text: formatSessionUsage(session.state.usage),
    });
    return;
  }
  if (session.configuring) {
    queuePrompt(session, prompt);
    return;
  }
  if (session.state.status === "starting") {
    // Show the opening prompt immediately. The handshake still owns when it
    // can actually be sent, but the adapter's later echo is suppressed so the
    // optimistic bubble becomes the real turn instead of being duplicated.
    queuePrompt(session, prompt, true);
    emit(session, { type: "user", text: trimmed, images });
    return;
  }
  if (session.state.status !== "idle") {
    const requestedMode =
      delivery === "alternate"
        ? followupMode === "queue"
          ? "steer"
          : "queue"
        : followupMode;
    if (requestedMode === "steer") {
      steerPrompt(session, prompt);
      return;
    }
    // A turn is already running. Hold the follow-up and show it holding, so
    // the pane never looks like it swallowed a prompt.
    queuePrompt(session, prompt);
    return;
  }
  dispatch(session, prompt);
}

/** Whether the current provider exposes same-turn steering. */
export function canSteer(termId: string): boolean {
  const session = sessions.get(termId);
  return Boolean(session && !session.disposed && session.adapter.steer);
}

/** Remove one waiting follow-up without affecting the turn in flight. */
export function cancelQueued(termId: string, id: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  const index = session.queued.findIndex((queued) => queued.id === id && !queued.echoed);
  if (index < 0) return;
  session.queued.splice(index, 1);
  emit(session, { type: "unqueue", id });
}

/** Pull the newest queued follow-up back into the composer for editing. */
export function editLastQueued(termId: string): AgentPrompt | null {
  const session = sessions.get(termId);
  if (!session || session.disposed) return null;
  for (let index = session.queued.length - 1; index >= 0; index -= 1) {
    const queued = session.queued[index];
    if (queued.echoed) continue;
    session.queued.splice(index, 1);
    emit(session, { type: "unqueue", id: queued.id });
    return {
      text: queued.prompt.text,
      images: [...queued.prompt.images],
    };
  }
  return null;
}

/** Send one queued follow-up into the active turn, keeping it queued on failure. */
export function sendQueuedNow(termId: string, id: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed || !session.adapter.steer) return;
  if (session.state.status !== "working" && session.state.status !== "waiting") return;
  const index = session.queued.findIndex((queued) => queued.id === id && !queued.echoed);
  if (index < 0) return;
  const [queued] = session.queued.splice(index, 1);
  emit(session, { type: "unqueue", id });
  steerPrompt(session, queued.prompt);
}

/**
 * Apply a composer dropdown choice without turning implementation syntax such
 * as `/effort high` into a user chat bubble.
 */
export function configure(
  termId: string,
  kind: "model" | "effort" | "access",
  value: string,
): void {
  const session = sessions.get(termId);
  if (!session || session.disposed || !value.trim()) return;
  if (session.state.status !== "idle") {
    emit(session, {
      type: "notice",
      tone: "error",
      text: `Wait for the current ${session.state.label} turn to finish before changing ${kind}.`,
    });
    return;
  }

  const epoch = session.interactionEpoch;
  const baseContext = contextWithoutUserEcho(session);
  const context: AdapterContext = {
    ...baseContext,
    emit: (event) => {
      // An ACP setter may resolve after the user has already started real
      // work. Its stale confirmation must not materialize inside that turn.
      if (event.type === "notice") {
        if (session.interactionEpoch !== epoch) return;
        baseContext.emit({ ...event, transient: true });
        return;
      }
      baseContext.emit(event);
    },
  };

  if (kind === "access") {
    const mode = value.trim() as AgentAccessMode;
    if (!["default", "read-only", "workspace", "full-access"].includes(mode)) return;
    const configured = session.adapter.configureAccess?.(mode, context);
    if (configured === undefined || configured === false) {
      emit(session, {
        type: "notice",
        tone: "error",
        text: `${session.state.label} does not expose a session-wide access level here.`,
      });
      return;
    }
    if (configured instanceof Promise) {
      void configured.catch(() => {
        emit(session, {
          type: "notice",
          tone: "error",
          text: `${session.state.label} could not change its access level.`,
        });
      });
    }
    return;
  }

  const command = `/${kind} ${value.trim()}`;
  const handled = session.adapter.command?.(command, context);
  if (handled === "prompt") {
    session.configuring = true;
    session.adapter.prompt({ text: command, images: [] }, context);
  } else if (handled !== "handled") {
    emit(session, {
      type: "notice",
      tone: "error",
      text: `${session.state.label} does not support changing ${kind} here.`,
    });
  }
}

/**
 * Hand a stored conversation to a running agent, in whatever way it accepts
 * one. Emits the transcript marker only once the agent has taken it.
 */
async function applyResume(session: Session, sessionId: string, title: string): Promise<void> {
  const attempt = session.adapter.resume?.(sessionId, session.context);
  if (attempt === false || attempt === undefined) {
    // An ACP agent that never advertised `loadSession`, and no CLI flag to fall
    // back on in its headless mode. Saying so beats a picker that does nothing.
    emit(session, {
      type: "notice",
      tone: "error",
      text: `${session.state.label} cannot resume a session from the custom UI.`,
    });
    return;
  }
  if (await attempt) {
    emit(session, { type: "resumed", sessionId, title });
  }
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
    await applyResume(session, sessionId, title);
    return null;
  }

  // Relaunch path (Claude). Everything typed at launch is kept except the
  // opening prompt, which already ran in the session being replaced.
  const { launch } = session;
  const cwd = session.state.cwd;
  // Claude resumes model context but stream-json does not replay old messages.
  // Read its durable transcript before the process is replaced so the selected
  // conversation can be restored as soon as the new harness exists.
  const transcript = await sessionTranscript(session.state.agent, cwd, sessionId).catch(
    () => [],
  );
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
  if (restarted) {
    if (transcript.length) emit(restarted, { type: "transcript", items: transcript });
    emit(restarted, { type: "resumed", sessionId, title });
  }
  return null;
}

/**
 * Replace the current conversation with a blank one in the same pane.
 *
 * Relaunching is the one operation every supported protocol agrees on. It
 * also guarantees that provider-side context is gone, instead of only
 * clearing Duckweed's visible transcript while the agent still remembers it.
 * The launch settings are retained, but resume flags and the original opening
 * prompt are deliberately removed.
 */
export async function newChat(termId: string): Promise<string | null> {
  const session = sessions.get(termId);
  if (!session || session.disposed) return "this pane has no agent session";

  if (
    session.state.status === "starting" ||
    session.state.status === "working" ||
    session.state.status === "waiting" ||
    session.configuring
  ) {
    emit(session, {
      type: "notice",
      tone: "error",
      text:
        session.state.status === "starting" || session.configuring
          ? "Wait for the agent to become ready before starting a new chat."
          : "Stop the current turn before starting a new chat.",
    });
    return null;
  }

  const { launch } = session;
  const cwd = session.state.cwd;
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
    { ...launch, prompt: null, resume: false, resumeId: null },
    cwd,
  );
  if (failure) announce(termId);
  return failure;
}

export function interrupt(termId: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  session.interrupted = true;
  session.adapter.interrupt(session.context);
}

/**
 * Ctrl+C from a custom UI means "leave the harness", matching its terminal
 * gesture instead of merely stopping the current turn. Claude and Grok guard
 * exits with a quick second press; the other harnesses close immediately.
 */
export function requestExit(termId: string): "armed" | "close" | "none" {
  const session = sessions.get(termId);
  if (!session || session.disposed) return "none";
  if (session.state.agent !== "claude" && session.state.agent !== "grok") return "close";

  const now = Date.now();
  if (session.exitArmedUntil >= now) {
    session.exitArmedUntil = 0;
    return "close";
  }

  session.exitArmedUntil = now + 1800;
  emit(session, { type: "exit-armed", armed: true });
  window.setTimeout(() => {
    if (session.disposed || session.exitArmedUntil > Date.now()) return;
    session.exitArmedUntil = 0;
    emit(session, { type: "exit-armed", armed: false });
  }, 1900);
  return "armed";
}

export function respond(termId: string, permissionId: string, optionId: string): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  session.adapter.respond(permissionId, optionId, session.context);
}

/** Send the user's reply to a question the agent asked. */
export function answer(
  termId: string,
  permissionId: string,
  answers: AgentQuestionAnswer[],
): void {
  const session = sessions.get(termId);
  if (!session || session.disposed) return;
  session.adapter.answer?.(permissionId, answers, session.context);
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
