import type { AgentItem } from "./agents/types";

export interface MobileOutgoingMessage {
  id: string;
  at: number;
  text: string;
  state: string;
}

/** Place local sends in the transcript while waiting for the desktop echo. */
export function mobileConversationTimeline(items: AgentItem[], messages: MobileOutgoingMessage[]) {
  const outgoing = messages.filter(message =>
    !items.some(item => item.kind === "user" && item.text.trim() === message.text.trim() && item.at >= message.at - 10_000));
  const visibleItems: AgentItem[] = [
    ...items,
    ...outgoing.map(message => ({ kind: "user" as const, id: message.id, at: message.at, text: message.text })),
  ];
  // A response may reach the phone before its user-message confirmation. Local
  // sends must retain their chronological position instead of following it.
  // Prefer the prompt when both clocks resolve to the same millisecond.
  visibleItems.sort((a, b) => a.at - b.at || Number(b.kind === "user") - Number(a.kind === "user"));
  return { visibleItems, outgoing };
}
