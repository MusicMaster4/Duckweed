/**
 * Warp-style history autosuggestions (ghost text).
 *
 * Warp ranks shell history with:
 * - buffer as a strict prefix of the candidate
 * - preference for commands run in the current working directory
 * - recency when other scores tie
 *
 * Full accept: Right (cursor at end) / Ctrl+F.
 * Partial accept: Ctrl+Right (one path/word component).
 *
 * Completions menus and path/flag engines are out of scope — history only.
 *
 * Ranking also *unlearns*: ghosts the user is shown and never accepts (Tab/→)
 * are demoted and eventually skipped (see {@link ./suggestFeedback}).
 */

import type { HistoryEntry } from "./commandHistory";
import * as suggestFeedback from "./suggestFeedback";

export interface SuggestOptions {
  /** Current pane cwd; same-cwd history ranks higher when set. */
  cwd?: string | null;
  /** Ranking cost for an ignored command; defaults to the learned table. */
  demotion?: (command: string) => number;
  /** Whether a command has been unlearned; defaults to the learned table. */
  suppressed?: (command: string) => boolean;
}

/**
 * Best history command that strictly extends `buffer`, or null.
 * Empty buffer yields no suggestion (type to ghost-complete).
 */
export function suggest(
  buffer: string,
  history: readonly HistoryEntry[],
  options: SuggestOptions = {},
): string | null {
  if (!buffer) return null;

  const suppressed = options.suppressed ?? suggestFeedback.isSuppressed;
  const demotion = options.demotion ?? suggestFeedback.demotion;

  let best: HistoryEntry | null = null;
  let bestScore = -Infinity;

  for (const entry of history) {
    if (entry.command === buffer) continue;
    if (!entry.command.startsWith(buffer)) continue;
    // Fully unlearned — the user has ignored this one too many times.
    if (suppressed(entry.command)) continue;

    const score = rankEntry(entry, options.cwd ?? null) - demotion(entry.command);
    // Prefer higher score; on ties keep the later entry (more recently recorded).
    if (score >= bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best?.command ?? null;
}

/**
 * Unmatched suffix to render as muted ghost text, or "" when none.
 */
export function ghostSuffix(buffer: string, suggestion: string | null): string {
  if (!suggestion || !suggestion.startsWith(buffer) || suggestion === buffer) return "";
  return suggestion.slice(buffer.length);
}

/**
 * Accept the next path/word component of `full` given current `buffer`.
 * Returns the new buffer value (always a prefix of `full`).
 *
 * Components split on whitespace and path separators (`/`, `\`). A trailing
 * path separator after a segment is included so the next accept takes the
 * following directory name — matching Warp/fish partial-accept feel.
 */
export function acceptPartialComponent(buffer: string, full: string): string {
  if (!full.startsWith(buffer)) return buffer;
  if (buffer.length >= full.length) return full;

  let i = buffer.length;
  const isSpace = (c: string) => c === " " || c === "\t";
  const isPath = (c: string) => c === "/" || c === "\\";
  const isSep = (c: string) => isSpace(c) || isPath(c);

  // If we're sitting on separators, consume them first (one space run or path seps).
  if (i < full.length && isSep(full[i]!)) {
    if (isPath(full[i]!)) {
      while (i < full.length && isPath(full[i]!)) i++;
    } else {
      while (i < full.length && isSpace(full[i]!)) i++;
    }
  }

  // Then take one run of non-separator characters.
  while (i < full.length && !isSep(full[i]!)) i++;

  // Include a trailing path separator so "foo/" is one component for paths.
  if (i < full.length && isPath(full[i]!)) i++;

  if (i <= buffer.length) return full;
  return full.slice(0, i);
}

/** Full accept — replace buffer with the full suggestion. */
export function acceptFull(buffer: string, suggestion: string | null): string {
  if (!suggestion || !suggestion.startsWith(buffer)) return buffer;
  return suggestion;
}

/**
 * Score for ranking. Higher is better.
 * Prefix is a hard filter; among matches: same-cwd >> recency (`at`) >>
 * shorter extension. Callers should still prefer the later list entry on a
 * true tie so insert order acts as a stable recency fallback.
 */
export function rankEntry(entry: HistoryEntry, cwd: string | null): number {
  let score = 0;
  // Recency from wall clock — primary signal when cwd does not decide.
  score += entry.at;
  // Same directory is a strong Warp-style signal (dominates recency).
  if (cwd && entry.cwd && pathsEqual(cwd, entry.cwd)) {
    score += 1e15;
  }
  // Prefer tighter completions slightly (less surprise for short buffers).
  score -= entry.command.length * 0.001;
  return score;
}

function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
