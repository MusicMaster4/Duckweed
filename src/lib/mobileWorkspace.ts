import type {
  MobileConversationSnapshot,
  MobileTerminalSnapshot,
  MobileWorkspaceSnapshot,
} from "./ipc";
import type { AgentStatus } from "./agents/types";

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
