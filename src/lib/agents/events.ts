import { mergeCommands } from "./slashCatalog";
import type {
  AgentFileChange,
  AgentPermission,
  AgentPlanStep,
  AgentSessionState,
  AgentStatus,
  AgentUsage,
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
      effort?: string;
      cwd?: string;
      commands?: { name: string; description: string }[];
    }
  | { type: "status"; status: AgentStatus; error?: string }
  /** The user's own message, echoed into the transcript. */
  | { type: "user"; text: string }
  | { type: "assistant-delta"; id: string; text: string }
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
    }
  | { type: "plan"; steps: AgentPlanStep[] }
  | { type: "notice"; text: string; tone: "info" | "error" }
  | { type: "permission"; permission: AgentPermission | null }
  | { type: "usage"; usage: Partial<AgentUsage> }
  /** A follow-up the user sent while a turn was still running. */
  | { type: "queue"; text: string }
  /** The oldest queued follow-up has just been sent. */
  | { type: "unqueue" }
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
        effort: event.effort ?? state.effort,
        cwd: event.cwd ?? state.cwd,
        commands: event.commands ? mergeCommands(state.commands, event.commands) : state.commands,
      };

    case "status":
      if (state.status === event.status && !event.error) return state;
      return {
        ...state,
        status: event.status,
        error: event.error ?? (event.status === "error" ? state.error : null),
      };

    case "user":
      return {
        ...state,
        started: true,
        items: [
          ...state.items,
          { kind: "user", id: nextId(state), at: Date.now(), text: event.text },
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
      };
      return { ...state, items };
    }

    case "plan": {
      // A plan is a live checklist, not a log: the agent rewrites it every
      // time it ticks a box, so the existing item is replaced in place rather
      // than stacking a dozen near-identical lists down the transcript.
      const index = lastIndexOfKind(state, "plan");
      if (index < 0) {
        return {
          ...state,
          started: true,
          items: [
            ...state.items,
            { kind: "plan", id: nextId(state), at: Date.now(), steps: event.steps },
          ],
        };
      }
      const items = state.items.slice();
      items[index] = { ...items[index], steps: event.steps } as never;
      return { ...state, items };
    }

    case "notice":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "notice", id: nextId(state), at: Date.now(), text: event.text, tone: event.tone },
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
      return { ...state, started: true, pending: [...state.pending, event.text] };

    case "unqueue":
      return state.pending.length === 0 ? state : { ...state, pending: state.pending.slice(1) };

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

function lastIndexOfKind(state: AgentSessionState, kind: "plan"): number {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i].kind === kind) return i;
  }
  return -1;
}
