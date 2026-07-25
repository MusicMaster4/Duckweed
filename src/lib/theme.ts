import type { ITheme } from "@xterm/xterm";

/**
 * Low-contrast dark palette: the foreground is deliberately not white and the
 * ANSI colours are desaturated, so long sessions stay easy on the eyes and the
 * few saturated accents in the UI are the things that draw attention.
 */
export const terminalTheme: ITheme = {
  background: "#131419",
  foreground: "#c0c5d0",
  cursor: "#8b83e6",
  cursorAccent: "#131419",
  selectionBackground: "#2b2f3d",
  selectionForeground: "#d6dae3",

  black: "#3b3f4a",
  red: "#c98b93",
  green: "#84a98c",
  yellow: "#c3a068",
  blue: "#8298c4",
  magenta: "#a98fc0",
  cyan: "#7ba8a6",
  white: "#b0b5c0",

  brightBlack: "#5b606d",
  brightRed: "#d9a0a7",
  brightGreen: "#9dbfa4",
  brightYellow: "#d5b681",
  brightBlue: "#9db0d6",
  brightMagenta: "#c0a8d4",
  brightCyan: "#96bfbc",
  brightWhite: "#d5d9e2",
};
