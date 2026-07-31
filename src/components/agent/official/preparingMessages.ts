import { createCooldownPicker } from "../../../lib/cooldownPicker";

/**
 * Short stand-in lines shown while thinking has started but no trace text has
 * arrived yet. Same job as the old fixed "Preparing response" label.
 *
 * Keep them short: the thinking row is already busy with the pulse and label.
 */
export const PREPARING_MESSAGES: readonly string[] = [
  "Preparing response",
  "Crafting a reply",
  "Forming an answer",
  "Gathering thoughts",
  "Composing a reply",
  "Putting it together",
  "Drafting an answer",
  "Building a response",
  "Assembling thoughts",
  "Shaping a reply",
  "Lining up an answer",
  "Spinning up a reply",
  "Framing a response",
  "Cooking up a reply",
  "Sorting the answer",
  "Loading a response",
  "Winding up a reply",
  "Aligning thoughts",
  "Sketching a reply",
  "Teeing up a response",
  "Settling on a reply",
  "Weaving a response",
  "Packing a reply",
  "Readying a response",
  "Staging the answer",
  "Queuing a reply",
  "Tuning a response",
  "Mapping an answer",
  "Warming up a reply",
  "Threading a response",
  "Nailing an answer",
  "Ordering the words",
  "Drawing up a reply",
  "Plotting a response",
  "Setting the answer",
  "Cueing up a reply",
  "Standing by to reply",
  "Holding for a reply",
  "Closing in on reply",
  "Filling the answer",
  "Pulling a reply up",
  "Bracing a response",
  "Locking the answer",
  "Making room to reply",
  "Almost ready to reply",
  "Getting words ready",
  "Words on the way",
  "Reply taking shape",
  "Answer coming up",
  "Response loading",
];

const pickPreparingMessage = createCooldownPicker(
  PREPARING_MESSAGES,
  PREPARING_MESSAGES[0]!,
  Math.random,
  {
    poolId: "preparing-messages",
    keyOf: (message) => message,
  },
);

/** Shared across panes, matching the greeting half-pool cooldown. */
export function nextPreparingMessage(): string {
  return pickPreparingMessage();
}

/** Enough for any plausible number of live thinking clusters. */
const REGISTRY_LIMIT = 128;

/**
 * Preparing labels remount with their thinking row on tab switch / pane split.
 * Hold the pick by cluster id so the same wait keeps the same stand-in line.
 */
const messageAssignments = new Map<string, string>();

/** Same preparing line for the same cluster across remounts. */
export function preparingMessageFor(clusterId: string): string {
  const existing = messageAssignments.get(clusterId);
  if (existing) return existing;

  const message = nextPreparingMessage();
  if (messageAssignments.size >= REGISTRY_LIMIT) {
    const oldest = messageAssignments.keys().next().value;
    if (oldest !== undefined) messageAssignments.delete(oldest);
  }
  messageAssignments.set(clusterId, message);
  return message;
}
