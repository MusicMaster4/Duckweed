/**
 * Add syntax colours to unstyled terminal text. Control sequences are kept
 * byte-for-byte: ConPTY cursor updates and shell prompt markers often share a
 * PTY read with ordinary output. Styled text and interactive redraws own their
 * rendering and must pass through unchanged.
 */

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
  // Captures follow TOKENS' alternatives. Reading them directly avoids a
  // rest array, Object.keys and alias regex for every token in build output.
  const painted = body.replace(TOKENS, (
    match, url, quoted, winpath, path, error, warn, ok, literal, muted, flag, number,
  ) => {
    const kind = url !== undefined ? "url"
      : quoted !== undefined ? "string"
      : winpath !== undefined || path !== undefined ? "path"
      : error !== undefined ? "error"
      : warn !== undefined ? "warn"
      : ok !== undefined ? "ok"
      : literal !== undefined || number !== undefined ? "number"
      : muted !== undefined ? "muted"
      : flag !== undefined ? "flag"
      : null;
    return kind === null ? match : paint(kind, match);
  });

  return head + painted;
}

/** Locate a complete escape sequence without inspecting its payload as text. */
function escapeEnd(text: string, start: number): number {
  const kind = text[start + 1];
  if (kind === undefined) return -1;
  if (kind === "[") {
    const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(start));
    return match ? start + match[0].length : -1;
  }
  if ("]P_^X".includes(kind)) {
    for (let i = start + 2; i < text.length; i++) {
      if (text[i] === "\x07") return i + 1;
      if (text[i] === ESC && text[i + 1] === "\\") return i + 2;
    }
    return -1;
  }
  const match = /^\x1b[ -/]*[0-~]/.exec(text.slice(start));
  return match ? start + match[0].length : -1;
}

/** String payloads have no style/mode state, so retain only their terminator context. */
function sequenceCarry(sequence: string): string {
  if (sequence.length > 2 && "]P_^X".includes(sequence[1])) {
    return sequence.slice(0, 2) + (sequence.endsWith(ESC) ? ESC : "");
  }
  return sequence;
}

/** Track independent SGR attributes, including selective and extended resets. */
function observeStyle(sequence: string, styles: Set<number>): void {
  if (sequence === `${ESC}c`) { styles.clear(); return; }
  const match = /^\x1b\[([0-9;:]*)m$/.exec(sequence);
  if (!match) return;
  const params = match[1].split(";");
  for (let i = 0; i < params.length; i++) {
    const value = Number(params[i].split(":")[0]);
    if (value === 0) styles.clear();
    else if (value === 38 || value === 48 || value === 58) {
      styles.add(value);
      // RGB/palette values belong to this parameter, not separate attributes.
      if (!params[i].includes(":")) {
        const format = Number(params[++i]);
        i += format === 2 ? 3 : format === 5 ? 1 : 0;
      }
    } else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
      styles.add(38);
    } else if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) {
      styles.add(48);
    } else if (value === 39) styles.delete(38);
    else if (value === 49) styles.delete(48);
    else if (value === 59) styles.delete(58);
    else if (value === 22) { styles.delete(1); styles.delete(2); }
    else if (value === 23) { styles.delete(3); styles.delete(20); }
    else if (value === 24) { styles.delete(4); styles.delete(21); }
    else if (value === 25) { styles.delete(5); styles.delete(6); }
    else if (value === 27) styles.delete(7);
    else if (value === 28) styles.delete(8);
    else if (value === 29) styles.delete(9);
    else if (value === 10) {
      for (let font = 11; font <= 19; font++) styles.delete(font);
    } else if (value === 54) { styles.delete(51); styles.delete(52); }
    else if (value === 55) styles.delete(53);
    else if (value === 65) {
      for (let ideogram = 60; ideogram <= 64; ideogram++) styles.delete(ideogram);
    } else if (value === 75) { styles.delete(73); styles.delete(74); }
    else styles.add(value);
  }
}

function highlightText(text: string): string {
  return text.split("\n").map((line) =>
    line.endsWith("\r") ? highlightLine(line.slice(0, -1)) + "\r" : highlightLine(line),
  ).join("\n");
}

/** Each session keeps the program's style and screen modes across PTY reads. */
export function createHighlighter() {
  const modes = new Set<number>();
  const styles = new Set<number>();
  let pending = "";
  const ownsScreen = () => modes.size > 0;

  return function process(chunk: string, enabled = true): string {
    if (!chunk) return chunk;
    // Most reads contain only text. With no unfinished escape, no styles or
    // screen modes can change, so skip span objects and both scanning passes.
    if (!pending && !chunk.includes(ESC)) {
      return enabled && !ownsScreen() && styles.size === 0 && !/\r(?!\n)|\x08/.test(chunk)
        ? highlightText(chunk)
        : chunk;
    }
    const spans: { text: string; sequence?: string }[] = [];
    let at = 0;
    if (pending) {
      const combined = pending + chunk;
      const end = escapeEnd(combined, 0);
      if (end < 0) {
        pending = sequenceCarry(combined);
        return chunk;
      }
      at = end - pending.length;
      spans.push({ text: chunk.slice(0, at), sequence: combined.slice(0, end) });
      pending = "";
    }
    while (at < chunk.length) {
      const start = chunk.indexOf(ESC, at);
      if (start < 0) { spans.push({ text: chunk.slice(at) }); break; }
      if (start > at) spans.push({ text: chunk.slice(at, start) });
      const end = escapeEnd(chunk, start);
      if (end < 0) {
        const tail = chunk.slice(start);
        pending = sequenceCarry(tail);
        spans.push({ text: tail, sequence: pending });
        break;
      }
      const sequence = chunk.slice(start, end);
      spans.push({ text: sequence, sequence });
      at = end;
    }

    // A redraw can enter and leave a mode in one coalesced read. Suppress the
    // whole read, including text before its markers, while still tracking state.
    let redraw = ownsScreen() || /\r(?!\n)|\x08/.test(chunk);
    for (const span of spans) {
      if (!span.sequence) continue;
      if (span.sequence === `${ESC}c`) { modes.clear(); continue; }
      const match = /^\x1b\[\?([0-9;]*)([hl])$/.exec(span.sequence);
      if (!match) continue;
      for (const raw of match[1].split(";")) {
        const mode = Number(raw);
        if (![47, 1047, 1049, 1000, 1002, 1003, 2026].includes(mode)) continue;
        if (match[2] === "h") { modes.add(mode); redraw = true; }
        else modes.delete(mode);
      }
    }

    return spans.map((span) => {
      if (span.sequence) {
        observeStyle(span.sequence, styles);
        return span.text;
      }
      return enabled && !redraw && styles.size === 0 ? highlightText(span.text) : span.text;
    }).join("");
  };
}

export type Highlighter = ReturnType<typeof createHighlighter>;
