import type { AgentItem } from "./types";

/**
 * Produce a portable transcript containing only the actual conversation.
 * Tool calls, private reasoning, plans, and app notices are intentionally
 * omitted so the result can be pasted into another chat or a document.
 */
export function conversationText(items: AgentItem[], agentLabel: string): string {
  const messages: string[] = [];

  for (const item of items) {
    if (item.kind === "user") {
      const content = [
        item.text.trim(),
        ...(item.images ?? []).map((image) => `[Image: ${image.name}]`),
      ]
        .filter(Boolean)
        .join("\n");
      if (content) messages.push(`You:\n${content}`);
      continue;
    }

    if (item.kind === "assistant") {
      const content = item.text.trim();
      if (content) messages.push(`${agentLabel}:\n${content}`);
    }
  }

  return messages.join("\n\n");
}
