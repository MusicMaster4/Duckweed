/**
 * Lines for the empty-pane state.
 *
 * A fresh pane has nothing to show — the shell has only printed its prompt, and
 * Warp hides that until you actually run something. What fills the gap is one
 * short line, picked once per pane so it stays put instead of flickering on
 * every render.
 */

const GREETINGS: readonly string[] = [
  "Let's get started.",
  "A blank prompt is the best kind.",
  "Nothing running. Everything possible.",
  "The shell is listening.",
  "Type something reckless.",
  "Fresh session, clean history.",
  "Ready when you are.",
  "No output yet — that's the point.",
  "Somewhere, a process is waiting to be spawned.",
  "First command's the hardest.",
  "The cursor blinks. Your move.",
  "Empty buffer. Full potential.",
  "Every pipeline starts with one command.",
  "Nothing here but you and the machine.",
  "Say the word.",
  "Quiet terminal, loud ideas.",
  "This pane has no opinions yet.",
  "Warm shell, cold start.",
];

/** One greeting, chosen at random. */
export function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)] ?? GREETINGS[0];
}
