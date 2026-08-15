import { mergeCommands } from "./slashCatalog";
import type {
  AgentAccessMode,
  AgentFileChange,
  AgentGoal,
  AgentImageAttachment,
  AgentItem,
  AgentModelChoice,
  AgentPendingPrompt,
  AgentPermission,
  AgentPlanStep,
  AgentPlanType,
  AgentSessionState,
  AgentSideQuestion,
  AgentStatus,
  AgentUsage,
  SubagentMeta,
  ToolKind,
  ToolStatus,
} from "./types";

/**
 * What an adapter reports, independent of the protocol it read it from.
 *
 * Adapters never touch session state directly: they translate their protocol
 * into these, and {@link applyEvent} is the only thing that decides what the
 * transcript looks like. That split is what keeps three very different wire
 * formats rendering as one UI, and it makes an adapter testable as a pure
 * `line in, events out` function.
 */
export type AgentEvent =
  /** Identity the agent reported once it was ready. */
  | {
      type: "session";
      sessionId?: string;
      model?: string;
      /**
       * `null` clears a previously known effort (e.g. OpenCode model with no
       * thought_level option). `undefined` leaves the current value alone.
       */
      effort?: string | null;
      /** `null` clears a provider service-tier override. */
      serviceTier?: string | null;
      /** Permission level selected in the custom UI. */
      accessMode?: AgentAccessMode;
      cwd?: string;
      commands?: { name: string; description: string }[];
      /** Replaces the switchable-model list when the adapter learns it. */
      models?: AgentModelChoice[];
    }
  | { type: "status"; status: AgentStatus; error?: string }
  /** A provider is loading a stored conversation, not running an agent turn. */
  | { type: "history-loading"; loading: boolean }
  /** Set, update, finish, or clear the provider's long-running objective. */
  | { type: "goal"; goal: AgentGoal | null }
  /** The user's own message, echoed into the transcript. */
  | {
      type: "user";
      text: string;
      images?: AgentImageAttachment[];
      /** This message steered the active turn instead of starting a new one. */
      sameTurn?: boolean;
    }
  | { type: "assistant-delta"; id: string; text: string }
  /**
   * The provider's settled copy of an assistant block. Replacing the partial
   * stream here lets a fast final frame catch the UI up immediately instead
   * of waiting for every already-generated delta to be painted.
   */
  | { type: "assistant-snapshot"; id: string; text: string }
  | { type: "assistant-end"; id: string }
  | { type: "thinking-delta"; id: string; text: string }
  | { type: "thinking-end"; id: string }
  /** Create or update one tool call. Absent fields are left as they were. */
  | {
      type: "tool";
      callId: string;
      name?: string;
      tool?: ToolKind;
      title?: string;
      status?: ToolStatus;
      command?: string | null;
      /** Replaces the collected output. */
      output?: string;
      /** Appends to the collected output. */
      outputDelta?: string;
      changes?: AgentFileChange[];
      /** Optional structured identity and live context for delegated work. */
      subagent?: SubagentMeta;
      /** One nested child item to append or update by id. */
      subagentItem?: AgentItem;
    }
  | { type: "plan"; planType?: AgentPlanType; steps: AgentPlanStep[] }
  | { type: "notice"; text: string; tone: "info" | "error"; transient?: boolean }
  /** Replace or dismiss the ephemeral response shown beside the transcript. */
  | { type: "side-question"; sideQuestion: AgentSideQuestion | null }
  | { type: "exit-armed"; armed: boolean }
  /** Remove picker confirmations and double-Ctrl+C hints without touching errors. */
  | { type: "dismiss-transient-notices" }
  /**
   * The selected conversation is replacing the pane's current transcript.
   * Protocols that replay their own history use the empty form first; agents
   * whose CLI only resumes context can restore normalized on-disk items.
   */
  | { type: "transcript"; items?: AgentItem[] }
  /**
   * A past conversation was picked up. Marks the transcript so what follows
   * reads as a continuation rather than a first turn, whether or not the
   * agent could replay the history behind it.
   */
  | { type: "resumed"; sessionId: string; title: string }
  | { type: "permission"; permission: AgentPermission | null }
  | { type: "usage"; usage: Partial<AgentUsage> }
  /** A follow-up the user sent while a turn was still running. */
  | { type: "queue"; prompt: AgentPendingPrompt }
  /** A queued follow-up has been sent, cancelled, or restored for editing. */
  | { type: "unqueue"; id: string }
  /** The turn finished; the composer takes the keyboard back. */
  | { type: "turn-end" };

/** Keep a tool's collected output bounded — panes render it, not tail it. */
const MAX_TOOL_OUTPUT = 20_000;

/** Cap a streamed block so one runaway response cannot grow without bound. */
const MAX_TEXT = 400_000;

function clampEnd(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}

function nextId(state: AgentSessionState): string {
  return `i${state.items.length}-${Date.now().toString(36)}`;
}

function workTimingAfterStatus(
  state: AgentSessionState,
  status: AgentStatus,
  now = Date.now(),
): Pick<AgentSessionState, "workStartedAt" | "lastWorkedForMs"> {
  if (
    status === "working" &&
    state.status !== "working" &&
    !(state.status === "waiting" && state.workStartedAt !== null)
  ) {
    return {
      workStartedAt: now,
      lastWorkedForMs: state.lastWorkedForMs,
    };
  }

  if (status === "idle" && state.workStartedAt !== null) {
    return {
      workStartedAt: null,
      lastWorkedForMs: Math.max(0, now - state.workStartedAt),
    };
  }

  return {
    workStartedAt: state.workStartedAt,
    lastWorkedForMs: state.lastWorkedForMs,
  };
}

/** Everything a status change needs to say whether the user is owed a nudge. */
export interface TurnEndInput {
  before: AgentStatus;
  after: AgentStatus;
  /** The new status came with a permission prompt the user has to answer. */
  permission: boolean;
  /** A prompt queued during the turn left immediately after it. */
  releasingQueued: boolean;
  /** The user stopped this turn themselves. */
  interrupted: boolean;
}

/**
 * Extra facts about *what* ended, so a finished config tweak is not treated
 * like a finished coding task.
 *
 * `isTurnEnd` only asks "did a turn end?"; `isAnnounceableTurn` asks "is the
 * user owed a sound/highlight for it?".
 */
export interface TurnAnnounceInput extends TurnEndInput {
  /** A tool call ran during the turn that just finished. */
  usedTools: boolean;
  /**
   * Text of the user message that opened this turn, when there was one.
   * Local slash handlers that never start a turn leave this null.
   */
  userText: string | null;
  /**
   * True when this working stretch began because the user submitted a prompt
   * (including a slash that went to the agent). Resume/load handshakes and
   * other synthetic working periods leave this false.
   */
  userInitiated: boolean;
}

/**
 * Slash commands that only change settings, inspect state, or manage the
 * session. Finishing one is not a task completion — the user already saw the
 * notice in the transcript.
 *
 * Anything that might launch real work (`/review`, `/compact` on some agents,
 * skills the CLI treats as prompts) is *not* listed: those still announce.
 */
const META_SLASH =
  /^\/(effort|model|help|status|cost|usage|stats|context|config|settings|permissions|theme|color|vim|login|logout|exit|quit|clear|compact|doctor|init|memory|export|hooks|mcp|plugin|agents|skills|bashes|extra-usage|privacy-settings|output-style|rename|sandbox|terminal-setup|install-github-app|release-notes|upgrade|mobile|chrome|ide|fast|plan|ultracode|loop|bugs)\b/i;

/** True when the submitted text is a local / status slash command, not a task. */
export function isMetaSlashCommand(text: string | null | undefined): boolean {
  if (!text) return false;
  return META_SLASH.test(text.trim());
}

/**
 * True when a pane just became worth returning to.
 *
 * Precision is the whole point of this predicate — a sound and a highlight for
 * a turn that did not end is worse than none at all — so every ending that is
 * not the agent handing work back to the user is excluded:
 *
 * - `starting` → `idle` is the handshake, not a turn.
 * - `exited` / `error` is the user quitting the CLI, or a crash the pane
 *   already shows.
 * - An interrupt is the user's own keystroke; they are already looking.
 * - A queued follow-up leaves as the turn ends, so the agent is still working.
 */
export function isTurnEnd(input: TurnEndInput): boolean {
  if (input.interrupted) return false;
  if (input.after === "waiting") {
    return input.permission && input.before !== "waiting";
  }
  if (input.after !== "idle") return false;
  if (input.before !== "working" && input.before !== "waiting") return false;
  return !input.releasingQueued;
}

/**
 * True only when an event actually moves the session into idle.
 *
 * Transcript events can update an already-idle session. In particular, every
 * adapter echoes the user's prompt before it reports `working`. Treating that
 * idle-to-idle item update as a return to idle discards ownership of the turn
 * before it has even started, so its later completion looks synthetic.
 */
export function didStatusEnterIdle(before: AgentStatus, after: AgentStatus): boolean {
  return before !== "idle" && after === "idle";
}

/**
 * True when a finished turn is worth a completion sound or unread flash.
 *
 * Config and status slash commands (`/effort`, `/model`, …) still end a turn
 * for the protocol, but they are not work the user was waiting on — they
 * already read the confirmation. Permission prompts and real prompts always
 * count. Synthetic ends (session load/resume, handshake) stay silent because
 * they never set `userInitiated`.
 */
export function isAnnounceableTurn(input: TurnAnnounceInput): boolean {
  if (!isTurnEnd(input)) return false;
  // Blocked on the user: they need to come back regardless of how they got there.
  if (input.after === "waiting" && input.permission) return true;
  // Resume/load and other synthetic working stretches never earned a nudge.
  if (!input.userInitiated) return false;
  // A settings slash with no tool work is not a task. Tools on a slash-looking
  // prompt (rare) still count as real work.
  if (isMetaSlashCommand(input.userText) && !input.usedTools) return false;
  return true;
}

function mergeSubagentMeta(
  current: SubagentMeta | undefined,
  patch: SubagentMeta | undefined,
  nestedItem: AgentItem | undefined,
): SubagentMeta | undefined {
  if (!current && !patch && !nestedItem) return undefined;
  const baseItems = patch?.items ?? current?.items ?? [];
  if (!nestedItem) {
    return { ...current, ...patch };
  }

  const items = baseItems.slice();
  const index = items.findIndex((item) => item.id === nestedItem.id);
  if (index < 0) {
    items.push(nestedItem);
  } else {
    items[index] = { ...items[index], ...nestedItem } as AgentItem;
  }
  return { ...current, ...patch, items };
}

/**
 * Fold one event into the session.
 *
 * Returns the same object when nothing changed so React can skip a render;
 * every other path returns a new object with a new `items` array, because
 * that is what `useSyncExternalStore` compares.
 */
export function applyEvent(state: AgentSessionState, event: AgentEvent): AgentSessionState {
  switch (event.type) {
    case "session":
      return {
        ...state,
        sessionId: event.sessionId ?? state.sessionId,
        model: event.model ?? state.model,
        effort: event.effort !== undefined ? event.effort : state.effort,
        serviceTier:
          event.serviceTier !== undefined ? event.serviceTier : state.serviceTier,
        accessMode: event.accessMode ?? state.accessMode,
        cwd: event.cwd ?? state.cwd,
        commands: event.commands ? mergeCommands(state.commands, event.commands) : state.commands,
        // A non-empty list wins; adapters re-emit the full set whenever it
        // changes rather than patching individual rows.
        models: event.models && event.models.length ? event.models : state.models,
      };

    case "status": {
      if (state.status === event.status && !event.error) return state;
      // Adapters that go idle without a turn-end frame (Codex resume, Claude
      // start) would otherwise leave a streaming caret blinking on the last
      // unfinished assistant/thinking block.
      const settled =
        event.status === "idle" || event.status === "exited" || event.status === "error";
      const items =
        settled &&
        state.items.some(
          (item) =>
            (item.kind === "assistant" || item.kind === "thinking") && item.streaming,
        )
          ? state.items.map((item) =>
              (item.kind === "assistant" || item.kind === "thinking") && item.streaming
                ? { ...item, streaming: false }
                : item,
            )
          : state.items;
      return {
        ...state,
        ...workTimingAfterStatus(state, event.status),
        status: event.status,
        items,
        error: event.error ?? (event.status === "error" ? state.error : null),
      };
    }

    case "history-loading":
      return state.loadingHistory === event.loading
        ? state
        : {
            ...state,
            loadingHistory: event.loading,
            ...(!event.loading && state.status !== "working"
              ? { workStartedAt: null, lastWorkedForMs: null }
              : {}),
          };

    case "goal":
      return {
        ...state,
        goal: event.goal ? { ...event.goal } : null,
      };

    case "user":
      return {
        ...state,
        started: true,
        items: [
          ...state.items.filter((item) => item.kind !== "notice" || !item.transient),
          {
            kind: "user",
            id: nextId(state),
            at: Date.now(),
            text: event.text,
            images: event.images ? [...event.images] : [],
            sameTurn: event.sameTurn,
          },
        ],
      };

    case "assistant-delta":
    case "thinking-delta": {
      const kind = event.type === "assistant-delta" ? "assistant" : "thinking";
      const index = findStreaming(state, kind, event.id);
      if (index < 0) {
        return {
          ...state,
          started: true,
          items: [
            ...state.items,
            {
              kind,
              id: event.id,
              at: Date.now(),
              text: clampEnd(event.text, MAX_TEXT),
              streaming: true,
            },
          ],
        };
      }
      const items = state.items.slice();
      const current = items[index] as { text: string };
      items[index] = { ...items[index], text: clampEnd(current.text + event.text, MAX_TEXT) } as never;
      return { ...state, items };
    }

    case "assistant-snapshot": {
      const index = findStreaming(state, "assistant", event.id);
      if (index < 0) {
        return {
          ...state,
          started: true,
          items: [
            ...state.items,
            {
              kind: "assistant",
              id: event.id,
              at: Date.now(),
              text: clampEnd(event.text, MAX_TEXT),
              streaming: false,
            },
          ],
        };
      }
      const items = state.items.slice();
      items[index] = {
        ...items[index],
        text: clampEnd(event.text, MAX_TEXT),
        streaming: false,
      } as never;
      return { ...state, items };
    }

    case "assistant-end":
    case "thinking-end": {
      const kind = event.type === "assistant-end" ? "assistant" : "thinking";
      const index = findStreaming(state, kind, event.id);
      if (index < 0) return state;
      const items = state.items.slice();
      items[index] = { ...items[index], streaming: false } as never;
      return { ...state, items };
    }

    case "tool": {
      const index = state.items.findIndex(
        (item) => item.kind === "tool" && item.callId === event.callId,
      );
      if (index < 0) {
        const subagent = mergeSubagentMeta(
          undefined,
          event.subagent,
          event.subagentItem,
        );
        return {
          ...state,
          started: true,
          items: [
            ...state.items,
            {
              kind: "tool",
              id: `t-${event.callId}`,
              at: Date.now(),
              callId: event.callId,
              name: event.name ?? "tool",
              tool: event.tool ?? "other",
              title: event.title ?? event.name ?? "tool",
              status: event.status ?? "running",
              command: event.command ?? null,
              output: clampEnd(event.output ?? event.outputDelta ?? "", MAX_TOOL_OUTPUT),
              changes: event.changes ?? [],
              ...(subagent ? { subagent } : {}),
            },
          ],
        };
      }
      const items = state.items.slice();
      const current = items[index];
      if (current.kind !== "tool") return state;
      const output =
        event.output !== undefined
          ? event.output
          : event.outputDelta !== undefined
            ? current.output + event.outputDelta
            : current.output;
      items[index] = {
        ...current,
        name: event.name ?? current.name,
        tool: event.tool ?? current.tool,
        title: event.title ?? current.title,
        status: event.status ?? current.status,
        command: event.command === undefined ? current.command : event.command,
        output: clampEnd(output, MAX_TOOL_OUTPUT),
        changes: event.changes ?? current.changes,
        subagent: mergeSubagentMeta(
          current.subagent,
          event.subagent,
          event.subagentItem,
        ),
      };
      return { ...state, items };
    }

    case "plan": {
      // A plan is a live checklist, not a log: the agent rewrites it every
      // time it ticks a box. Only replace a checklist from this user turn,
      // though. Updating an older row in place would leave it before the latest
      // user message, where the current-turn workflow dock cannot see it.
      const index = lastIndexOfKindInCurrentTurn(state, "plan");
      if (index < 0) {
        return {
          ...state,
          started: true,
          items: [
            ...state.items,
            {
              kind: "plan",
              id: nextId(state),
              at: Date.now(),
              planType: event.planType ?? "tasks",
              steps: event.steps,
            },
          ],
        };
      }
      const items = state.items.slice();
      items[index] = {
        ...items[index],
        planType: event.planType ?? "tasks",
        steps: event.steps,
      } as never;
      return { ...state, items };
    }

    case "notice":
      return {
        ...state,
        // Notices are real transcript content. Without `started`, every experience
        // keeps rendering the empty welcome and the line is invisible — which is
        // exactly how app-owned `/usage` was swallowing its own reply.
        started: true,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId(state),
            at: Date.now(),
            text: event.text,
            tone: event.tone,
            transient: event.transient,
          },
        ],
      };

    case "side-question":
      return {
        ...state,
        sideQuestion: event.sideQuestion ? { ...event.sideQuestion } : null,
      };

    case "exit-armed":
      return state.exitArmed === event.armed ? state : { ...state, exitArmed: event.armed };

    case "dismiss-transient-notices": {
      const items = state.items.filter((item) => item.kind !== "notice" || !item.transient);
      return items.length === state.items.length ? state : { ...state, items };
    }

    case "transcript":
      return {
        ...state,
        started: true,
        goal: null,
        sideQuestion: null,
        items: event.items ?? [],
        lastWorkedForMs: null,
        pending: [],
        permission: null,
        error: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          contextUsed: null,
        },
      };

    case "resumed":
      return {
        ...state,
        sessionId: event.sessionId,
        // The empty state offers to start something new; a resumed pane is
        // the opposite of that even before its first reply lands.
        started: true,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId(state),
            at: Date.now(),
            tone: "info",
            text: event.title ? `Resumed “${event.title}”` : "Resumed the previous session",
          },
        ],
      };

    case "permission":
      return {
        ...state,
        permission: event.permission,
        status: event.permission ? "waiting" : state.status === "waiting" ? "working" : state.status,
      };

    case "usage":
      return { ...state, usage: { ...state.usage, ...event.usage } };

    case "queue":
      return { ...state, started: true, pending: [...state.pending, event.prompt] };

    case "unqueue":
      return state.pending.some((prompt) => prompt.id === event.id)
        ? { ...state, pending: state.pending.filter((prompt) => prompt.id !== event.id) }
        : state;

    case "turn-end": {
      // Anything still marked as streaming when the turn ends never got its
      // closing frame; leaving the caret blinking there would be a lie.
      const items = state.items.map((item) =>
        (item.kind === "assistant" || item.kind === "thinking") && item.streaming
          ? { ...item, streaming: false }
          : item,
      );
      return {
        ...state,
        ...workTimingAfterStatus(state, "idle"),
        items,
        permission: null,
        status: state.status === "exited" || state.status === "error" ? state.status : "idle",
      };
    }
  }
}

function findStreaming(
  state: AgentSessionState,
  kind: "assistant" | "thinking",
  id: string,
): number {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind === kind && item.id === id) return i;
  }
  return -1;
}

function lastIndexOfKindInCurrentTurn(
  state: AgentSessionState,
  kind: "plan",
): number {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i].kind === kind) return i;
    if (state.items[i].kind === "user") return -1;
  }
  return -1;
}
