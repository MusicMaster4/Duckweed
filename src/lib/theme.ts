import type { ITheme } from "@xterm/xterm";

/**
 * Duckweed's terminal palette.
 *
 * The surfaces stay near-black, but the ANSI colours are fully saturated: the
 * previous desaturated set made colour-heavy CLIs (Claude Code, Codex, git,
 * npm) read as a single wash of grey-blue, which defeats the point of them
 * emitting colour at all. Green is the house colour, so ANSI green doubles as
 * the accent and every other hue is tuned to sit beside it without clashing.
 */

/** The one green everything else is derived from — UI accent and ANSI green. */
export const GREEN = "#7be05a";
/** Lighter step used for bright green and for text that must beat the accent. */
export const GREEN_BRIGHT = "#9df07d";
/** Deep step for fills and borders that should read as green but recede. */
export const GREEN_DEEP = "#4a9b32";

export const terminalTheme: ITheme = {
  background: "#131614",
  foreground: "#e4eae6",
  cursor: GREEN,
  cursorAccent: "#131614",
  // Alpha keeps the selected text in its own colour instead of flattening it.
  selectionBackground: "#7be05a38",

  black: "#39413b",
  red: "#f2686f",
  green: GREEN,
  yellow: "#f0c052",
  blue: "#5fa8f5",
  magenta: "#c98bf0",
  cyan: "#45cec4",
  white: "#d6ddd8",

  // The workhorse for "dimmed" text in CLIs (Claude Code's hints, git's
  // context lines). Too dark and half of every tool's output disappears, so it
  // sits well above the surface rather than just above the background.
  brightBlack: "#8a948c",
  brightRed: "#ff8a90",
  brightGreen: GREEN_BRIGHT,
  brightYellow: "#ffd772",
  brightBlue: "#8cc4ff",
  brightMagenta: "#e0adff",
  brightCyan: "#72e6de",
  brightWhite: "#eef3ef",
};

/**
 * Colours the syntax highlighter paints with. They are drawn from the palette
 * above rather than invented so highlighted output and genuinely-coloured
 * output look like the same terminal.
 */
export const highlightColors = {
  string: terminalTheme.green!,
  number: terminalTheme.magenta!,
  path: terminalTheme.blue!,
  url: terminalTheme.brightCyan!,
  flag: terminalTheme.yellow!,
  key: terminalTheme.cyan!,
  error: terminalTheme.red!,
  warn: terminalTheme.yellow!,
  ok: terminalTheme.brightGreen!,
  muted: terminalTheme.brightBlack!,
  added: terminalTheme.green!,
  removed: terminalTheme.red!,
} as const;
