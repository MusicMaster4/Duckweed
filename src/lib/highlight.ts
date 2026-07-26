/**
 * Syntax highlighting for terminal output that arrives with no colour of its own.
 *
 * Plenty of tools print plain text — `dir`, `where`, most `--help` screens,
 * stack traces, config dumps — and a wall of one-colour text is exactly what
 * this is here to fix. Tools that *do* emit colour (Claude Code, Codex, git,
 * npm) are left completely alone; they already know what they want to look
 * like, and repainting over them is how you break a TUI.
 *
 * The safety rules are deliberately strict. A chunk is only ever touched when:
 *
 *   1. nothing is drawing its own screen — the alternate screen is the obvious
 *      case, and mouse reporting catches the TUIs that run inline instead;
 *   2. the chunk contains no ESC byte at all, so there is no escape sequence to
 *      land inside and corrupt;
 *   3. no carriage return appears without a following newline, which is the
 *      signature of a progress bar or spinner redrawing a line in place;
 *   4. the SGR state left behind by earlier chunks is clean, so the colours we
 *      emit cannot leak into or out of somebody else's styling.
 *
 * When all four hold, injecting SGR is safe: the sequences occupy no cells, so
 * wrapping, cursor position and selection are unaffected.
 */

import { incompleteTailStart } from "./frames";
import { highlightColors } from "./theme";

const ESC = "\x1b";

/** `\x1b[38;2;R;G;Bm` — 24-bit foreground, which COLORTERM=truecolor promises. */
function fg(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${ESC}[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** Reset foreground only; bold/italic set by the program stay untouched. */
const RESET = `${ESC}[39m`;

const PAINT: Record<string, string> = Object.fromEntries(
  Object.entries(highlightColors).map(([name, hex]) => [name, fg(hex)]),
);

const paint = (kind: keyof typeof highlightColors, text: string) =>
  `${PAINT[kind]}${text}${RESET}`;

/*
 * CLIs shout (`ERROR`), whisper (`error`) and capitalise (`Error`) with no
 * consistency, so the vocabulary has to match all three. A plain `i` flag is
 * not an option: it would leak into the hex rules and start dimming ordinary
 * words that happen to spell out in a–f. Expanding each letter to a character
 * class keeps case-insensitivity scoped to exactly these words.
 */
const ci = (word: string) => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const anyOf = (words: readonly string[]) => words.map(ci).join("|");

const ERROR_WORDS = [
  "error", "errors", "erro", "fatal", "fail", "failed", "failing", "failure",
  "failures", "panic", "panicked", "exception", "traceback", "denied", "refused",
  "unauthorized", "forbidden", "invalid", "missing", "cannot", "unable", "rejected",
] as const;

const WARN_WORDS = [
  "warn", "warns", "warning", "warnings", "deprecated", "deprecation", "skipped",
  "skipping", "pending", "retry", "retrying", "timeout", "timed-out",
] as const;

const OK_WORDS = [
  "ok", "okay", "success", "successful", "successfully", "passed", "passing",
  "pass", "done", "ready", "created", "installed", "complete", "completed",
  "up-to-date", "compiled",
] as const;

/** Language literals, coloured like numbers because that is what they are. */
const LITERAL_WORDS = ["true", "false", "null", "nil", "undefined", "NaN"] as const;

/** Words that must never be treated as a `key:` label — severity wins. */
const RESERVED = new Set<string>(
  [...ERROR_WORDS, ...WARN_WORDS, ...OK_WORDS, ...LITERAL_WORDS].map((w) => w.toLowerCase()),
);

/*
 * One alternation, tried left to right, so an earlier rule always wins the
 * bytes it matched and rules can never overlap. Ordering is the whole design:
 * URLs before paths (a URL contains slashes), quoted strings before their
 * contents, words before the numbers embedded in them.
 */
const TOKENS = new RegExp(
  [
    // URLs, including bare www. hosts.
    String.raw`(?<url>\b(?:https?|ftp|file):\/\/[^\s'"<>|]+|\bwww\.[^\s'"<>|]+)`,
    // Double-quoted and backticked strings. Single quotes are left out on
    // purpose — apostrophes in ordinary prose would swallow half a line.
    String.raw`(?<string>"[^"\n]{0,400}"|` + "`[^`\\n]{0,400}`)",
    // Windows drive paths and UNC shares.
    String.raw`(?<winpath>\b[A-Za-z]:[\\\/][^\s'"<>|*?]*|\\\\[^\s'"<>|*?]+)`,
    // POSIX-ish paths: must start at a boundary with /, ./, ../ or ~/ so words
    // like "and/or" are not mistaken for one.
    String.raw`(?<path>(?<=^|[\s'"(\[=:])(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]*)*)`,
    // Failure vocabulary. Whole words only, any casing.
    String.raw`(?<error>\b(?:${anyOf(ERROR_WORDS)})\b|[✗✖×])`,
    // Caution vocabulary.
    String.raw`(?<warn>\b(?:${anyOf(WARN_WORDS)})\b|[⚠])`,
    // Success vocabulary.
    String.raw`(?<ok>\b(?:${anyOf(OK_WORDS)})\b|[✓✔√])`,
    // Language literals — the same colour as numbers, since they read as values.
    String.raw`(?<number1>\b(?:${anyOf(LITERAL_WORDS)})\b)`,
    // git object ids and UUIDs, dimmed — they are reference material, not signal.
    String.raw`(?<muted>\b[0-9a-f]{7,40}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)`,
    // CLI flags: -v, --colour, /F (the Windows convention).
    String.raw`(?<flag>(?<=^|[\s'"(\[])(?:--?[A-Za-z][\w-]*|\/[A-Z]\b))`,
    // Numbers, including hex, versions, sizes and percentages.
    String.raw`(?<number>\b0[xX][0-9a-fA-F]+\b|\b\d+(?:[.:]\d+)*(?:[eE][+-]?\d+)?(?:%|[KMGT]i?B|m?s|ms|px|em)?\b)`,
  ].join("|"),
  "gu",
);

/** `key:` / `KEY =` at the start of a line — the shape of config and status output. */
const LINE_KEY = /^(\s*)([A-Za-z_][\w.-]{0,60})(\s*[:=]\s)/;

/** Unified-diff and log-level line prefixes, coloured whole-line. */
const DIFF_ADD = /^(?:\+(?!\+)|>\s)/;
const DIFF_DEL = /^(?:-(?!-)|<\s)/;
const DIFF_HUNK = /^(?:@@|diff --git|index [0-9a-f]{7,})/;

function highlightLine(line: string): string {
  if (!line) return line;

  // Whole-line rules first: a diff line is one semantic unit, and tokenising
  // inside it would fight the line's own colour.
  if (DIFF_HUNK.test(line)) return paint("key", line);
  if (DIFF_ADD.test(line)) return paint("added", line);
  if (DIFF_DEL.test(line)) return paint("removed", line);

  let head = "";
  let body = line;
  const kv = LINE_KEY.exec(line);
  // `ERROR: ...` is a severity line, not a key/value pair — let the vocabulary
  // rules have it rather than painting it as a neutral label.
  if (kv && !RESERVED.has(kv[2].toLowerCase())) {
    head = kv[1] + paint("key", kv[2]) + kv[3];
    body = line.slice(kv[0].length);
  }

  TOKENS.lastIndex = 0;
  const painted = body.replace(TOKENS, (match, ...rest) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    for (const kind of Object.keys(groups)) {
      if (groups[kind] === undefined) continue;
      // Group names carry the colour. `winpath` aliases `path`, and a trailing
      // digit (`number1`) marks an extra alternative sharing an earlier colour —
      // regexes reject duplicate group names, so the suffix is how they coexist.
      const key = (kind === "winpath" ? "path" : kind.replace(/\d+$/, "")) as
        keyof typeof highlightColors;
      return paint(key, match);
    }
    return match;
  });

  return head + painted;
}

/**
 * Mouse reporting — the tracking modes, not the encodings, which say nothing on
 * their own. Only a program painting its own screen turns these on, and unlike
 * the alternate screen they also catch the ones that draw inline: Codex and
 * Claude Code both render into the normal buffer, where the alt-screen test
 * would happily wave their frames through to be repainted.
 */
const MOUSE_ON = /\x1b\[\?(?:1000|1002|1003)h/;
const MOUSE_OFF = /\x1b\[\?(?:1000|1002|1003)l/;

/**
 * A per-session colouriser. It has to be stateful because the decision to
 * highlight depends on escape sequences seen in *earlier* chunks: alt-screen
 * mode, leftover SGR and split sequences all persist across writes.
 */
export function createHighlighter() {
  let altScreen = false;
  /** A program is tracking the mouse, so it is drawing and we are not. */
  let mouse = false;
  /** True when the last SGR seen was something other than a full reset. */
  let styled = false;
  /** The previous chunk ended mid-sequence, so this one starts inside it. */
  let continuing = false;

  /** Track the modes that decide whether a later plain chunk is safe to paint. */
  function observe(chunk: string): void {
    if (chunk.includes("?1049h") || chunk.includes("?47h")) altScreen = true;
    if (chunk.includes("?1049l") || chunk.includes("?47l")) altScreen = false;
    if (MOUSE_ON.test(chunk)) mouse = true;
    if (MOUSE_OFF.test(chunk)) mouse = false;

    // Only the final SGR in the chunk matters — it is the state the next chunk
    // inherits. `\x1b[m`, `\x1b[0m` and `\x1b[00m` all mean "back to default".
    let last: string | null = null;
    for (const m of chunk.matchAll(/\x1b\[([0-9;]*)m/g)) last = m[1];
    if (last !== null) styled = !/^0*(;0*)*$/.test(last);
  }

  /** Returns the chunk to hand to xterm — untouched unless every rule allows it. */
  return function process(chunk: string, enabled = true): string {
    if (!chunk) return chunk;

    if (continuing || chunk.includes(ESC)) {
      observe(chunk);
      // A sequence split across chunks is rare enough that the tail is assumed
      // to complete inside the very next chunk; the cost of being wrong is one
      // uncoloured chunk, never a corrupted one.
      // Frame reassembly holds a split sequence back until the rest of it lands,
      // so this only trips on a payload too long to be worth waiting for.
      continuing = incompleteTailStart(chunk) >= 0;
      return chunk;
    }
    // Highlighting can be disabled while mode/SGR tracking must stay current.
    // Plain chunks need no vocabulary/token pass in that state.
    if (!enabled) return chunk;
    if (altScreen || mouse || styled) return chunk;
    // Bare CR means an in-place redraw (spinners, progress bars); colouring a
    // line that is about to be overwritten just makes it flicker.
    if (/\r(?!\n)/.test(chunk)) return chunk;

    // Split on newlines so line-level rules see whole lines. A chunk can end
    // mid-line, but the tail is still a valid prefix to tokenise and every SGR
    // we emit is closed before the chunk ends, so nothing leaks.
    return chunk
      .split("\n")
      .map((line) =>
        line.endsWith("\r") ? highlightLine(line.slice(0, -1)) + "\r" : highlightLine(line),
      )
      .join("\n");
  };
}

export type Highlighter = ReturnType<typeof createHighlighter>;
