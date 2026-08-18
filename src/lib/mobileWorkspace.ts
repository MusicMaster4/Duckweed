import type {
  MobileConversationSnapshot,
  MobileWorkspaceSnapshot,
} from "./ipc";

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
