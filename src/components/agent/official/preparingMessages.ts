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
  "Pinning the reply",
  "Honing a response",
  "Stacking the answer",
  "Routing a reply",
  "Dialing in a reply",
  "Catching a thought",
  "Priming a response",
  "Zeroing on a reply",
  "Folding in the idea",
  "Buffering a reply",
  "Snapping a response",
  "Calibrating a reply",
  "Threading the idea",
  "Seeding a response",
  "Gearing up a reply",
  "Focusing the answer",
  "Whittling a reply",
  "Anchoring a response",
  "Rounding out a reply",
  "Settling the words",
  "Firing up a reply",
  "Sifting the answer",
  "Harnessing a reply",
  "Parsing the thought",
  "Booting a response",
  "Carving out a reply",
  "Tacking on the idea",
  "Bridging a response",
  "Raising a reply",
  "Clocking the answer",
  "Molding a response",
  "Steering a reply",
  "Banking the answer",
  "Chasing a response",
  "Latching a reply",
  "Spooling the answer",
  "Hatching a response",
  "Pressing a reply",
  "Yielding the answer",
  "Stirring a response",
  "Staking a reply",
  "Wiring the answer",
  "Cycling a response",
  "Landing a reply",
  "Syncing the answer",
  "Opening a response",
  "Closing on a reply",
  "Fetching the answer",
  "Rounding a response",
  "Planting a reply",
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

/** Shared across panes, matching the greeting 70% pool cooldown. */
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
