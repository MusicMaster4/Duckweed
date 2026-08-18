import type {
  MobileConversationSnapshot,
  MobileTerminalSnapshot,
  MobileWorkspaceSnapshot,
} from "./ipc";
import type { AgentStatus } from "./agents/types";
import type { AgentItem } from "./agents/types";
import type { MobileAgentActivitySnapshot } from "./ipc";

// The relay accepts up to 320,000 base64url ciphertext characters. Keeping the
// serialized workspace below this smaller budget leaves room for AES-GCM,
// base64 expansion, and the relay request envelope.
export const MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES = 220_000;
export const MOBILE_WORKSPACE_CONVERSATION_BUDGET_BYTES = 180_000;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Truncate at a UTF-8 boundary without splitting a surrogate pair. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;

  const marker = "…";
  const markerBytes = utf8ByteLength(marker);
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes) end -= 1;
  while (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) {
    end -= 1;
  }

  const prefix = value.slice(0, end);
  return markerBytes <= maxBytes && utf8ByteLength(prefix) + markerBytes <= maxBytes
    ? `${prefix}${marker}`
    : prefix;
}

/** Keep the newest terminal screen/scrollback without cutting UTF-8 text. */
export function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;

  const marker = "\u2026\n";
  const markerBytes = utf8ByteLength(marker);
  if (maxBytes < markerBytes) return "";
  const contentBudget = maxBytes - markerBytes;
  let start = Math.max(0, value.length - contentBudget);
  while (start < value.length && utf8ByteLength(value.slice(start)) > contentBudget) {
    start += 1;
  }
  // A JS index can land between a UTF-16 surrogate pair.
  if (start < value.length && /[\uDC00-\uDFFF]/.test(value[start] ?? "")) start += 1;
  return `${marker}${value.slice(start)}`;
}

export interface MobileTerminalActivity {
  exited: boolean;
  agent: string | null;
  busy: boolean;
  pendingAgentTurn: boolean;
  structuredStatus: AgentStatus | null;
}

/**
 * Translate desktop process state into honest mobile language.
 *
 * A persistent raw agent keeps a child process open while it waits at its
 * prompt. That is an idle terminal, not a thinking agent. Structured startup
 * is also its own state so opening an agent UI never looks like a submitted
 * turn.
 */
export function mobileTerminalStatus(
  activity: MobileTerminalActivity,
): MobileTerminalSnapshot["status"] {
  const status = activity.structuredStatus;
  if (status) {
    if (status === "starting") return "starting";
    if (status === "working") return "working";
    if (status === "waiting") return "waiting";
    if (status === "exited" || status === "error") return "exited";
    return "idle";
  }
  if (activity.exited) return "exited";
  if (activity.agent) return activity.pendingAgentTurn ? "working" : "idle";
  return activity.busy ? "working" : "idle";
}

/**
 * Flatten the provider's live transcript chrome into a compact phone-friendly
 * activity feed. Final assistant prose stays in `conversation`; this list is
 * only the step-by-step work that used to be visible on desktop alone.
 */
export function mobileAgentActivity(
  items: readonly AgentItem[],
  limit = 8,
): MobileAgentActivitySnapshot[] {
  const activity: MobileAgentActivitySnapshot[] = [];
  for (const item of items) {
    if (item.kind === "thinking") {
      const text = item.text.trim();
      if (text) {
        activity.push({
          id: item.id,
          at: item.at,
          kind: "thinking",
          title: "Reasoning",
          detail: truncateUtf8(text, 1_200),
          status: item.streaming ? "running" : "done",
        });
      }
    } else if (item.kind === "tool") {
      activity.push({
        id: item.id,
        at: item.at,
        kind: "tool",
        title: truncateUtf8(item.title.trim() || item.name, 240),
        detail: truncateUtf8((item.output || item.command || "").trim(), 1_200) || null,
        status:
          item.status === "error"
            ? "error"
            : item.status === "running" || item.status === "pending"
              ? item.status
              : "done",
      });
    } else if (item.kind === "plan") {
      item.steps.forEach((step, index) => {
        activity.push({
          id: `${item.id}:${index}`,
          at: item.at + index,
          kind: "plan",
          title: truncateUtf8(step.text.trim(), 320),
          detail: null,
          status: step.status,
        });
      });
    }
  }
  return activity.slice(-Math.max(0, limit));
}

type ConversationRef = {
  terminal: { conversation: MobileConversationSnapshot[] };
  message: MobileConversationSnapshot;
};

function conversationRefs(snapshot: MobileWorkspaceSnapshot): ConversationRef[] {
  return snapshot.projects.flatMap((project) =>
    project.terminals.flatMap((terminal) =>
      terminal.conversation.map((message) => ({ terminal, message })),
    ),
  );
}

function terminalOutputRefs(snapshot: MobileWorkspaceSnapshot): MobileTerminalSnapshot[] {
  return snapshot.projects.flatMap((project) =>
    project.terminals.filter((terminal) => Boolean(terminal.terminalOutput)),
  );
}

function terminalMetadataRefs(snapshot: MobileWorkspaceSnapshot): MobileTerminalSnapshot[] {
  return snapshot.projects.flatMap((project) => project.terminals);
}

/**
 * Keep the snapshot below the encrypted payload budget after JSON escaping.
 * The snapshot is freshly built by the sync effect, so trimming it in place
 * does not mutate workspace state or affect the desktop UI.
 */
export function fitMobileWorkspaceSnapshot(
  snapshot: MobileWorkspaceSnapshot,
): MobileWorkspaceSnapshot {
  let serialized = JSON.stringify(snapshot);
  if (utf8ByteLength(serialized) <= MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) {
    return snapshot;
  }

  // Terminal output is a rolling tail and can be discarded from the front.
  // Preserve structured conversation history until those volatile buffers
  // have given up as much room as they can.
  for (const terminal of terminalOutputRefs(snapshot)) {
    if (utf8ByteLength(serialized) <= MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) break;
    const output = terminal.terminalOutput ?? "";
    const currentBytes = utf8ByteLength(output);
    const excess = utf8ByteLength(serialized) - MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES;
    terminal.terminalOutput = truncateUtf8Tail(output, Math.max(0, currentBytes - excess));
    if (!terminal.terminalOutput) delete terminal.terminalOutput;
    serialized = JSON.stringify(snapshot);
  }

  for (const ref of conversationRefs(snapshot)) {
    if (utf8ByteLength(serialized) <= MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) break;
    const currentBytes = utf8ByteLength(ref.message.text);
    const excess = utf8ByteLength(serialized) - MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES;
    const nextText = truncateUtf8(ref.message.text, Math.max(0, currentBytes - excess));
    ref.message.text = nextText;
    if (!nextText) {
      ref.terminal.conversation = ref.terminal.conversation.filter(
        (message) => message !== ref.message,
      );
    }
    serialized = JSON.stringify(snapshot);
  }

  // Live activity and completion catalogs are reconstructable on the next
  // publish. If a workspace has many open agents, trim their oldest/lowest
  // priority rows before allowing the relay envelope to exceed its limit.
  if (utf8ByteLength(serialized) > MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) {
    const terminals = terminalMetadataRefs(snapshot);
    let changed = true;
    while (changed && utf8ByteLength(serialized) > MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) {
      changed = false;
      for (const terminal of terminals) {
        if (terminal.activity.length > 0) {
          terminal.activity.shift();
          changed = true;
        }
        serialized = JSON.stringify(snapshot);
        if (utf8ByteLength(serialized) <= MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) break;
      }
    }
    changed = true;
    while (changed && utf8ByteLength(serialized) > MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) {
      changed = false;
      for (const terminal of terminals) {
        // /new, /model, and /effort were sorted to the front by the publisher.
        if (terminal.commands.length > 3) {
          terminal.commands.pop();
          changed = true;
        }
        serialized = JSON.stringify(snapshot);
        if (utf8ByteLength(serialized) <= MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) break;
      }
    }
  }

  // If unusually large project metadata remains, drop the oldest conversation
  // rows as a final safeguard. Normal snapshots fit in the first pass.
  if (utf8ByteLength(serialized) > MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) {
    for (const ref of conversationRefs(snapshot)) {
      if (utf8ByteLength(serialized) <= MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES) break;
      ref.terminal.conversation = ref.terminal.conversation.filter(
        (message) => message !== ref.message,
      );
      serialized = JSON.stringify(snapshot);
    }
  }

  return snapshot;
}
