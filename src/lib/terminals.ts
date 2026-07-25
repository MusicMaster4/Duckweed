import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { createCursorSettler, type CursorSettler } from "./cursor";
import {
  createFrameBuffer,
  stabilizeCursorDuringFrame,
  SYNC_MODE,
  type FrameBuffer,
  type FrameWrite,
} from "./frames";
import { createHighlighter, type Highlighter } from "./highlight";
import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "./ipc";
import { GREEN, terminalTheme } from "./theme";

export interface TermMeta {
  /** Title reported by the shell via OSC 0/2, or the shell name. */
  title: string;
  /** Working directory as reported by OSC 7 / OSC 9;9, when the shell emits it. */
  cwd: string;
  shellLabel: string;
  exited: boolean;
  exitCode: number | null;
  cols: number;
  rows: number;
}

interface Session extends TermMeta {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** The element xterm renders into; it is moved between panes, never recreated. */
  host: HTMLDivElement;
  container: HTMLElement | null;
  observer: ResizeObserver | null;
  unlisten: UnlistenFn[];
  spawned: boolean;
  /** Set once the spawn handshake starts; a second start would collide server-side. */
  starting: boolean;
  /** Bytes typed before the PTY was ready. */
  pending: string[];
  /** Decodes PTY bytes; `stream: true` so multi-byte chars can span chunks. */
  decoder: TextDecoder;
  /** Reassembles synchronized-output frames so xterm only paints finished ones. */
  frames: FrameBuffer;
  /** Last cursor visibility requested by the shell, independent of redraw hiding. */
  cursorVisible: boolean;
  /** Cursor painted independently from xterm, like Warp's grid renderer. */
  visualCursor: HTMLDivElement;
  cursorSettler: CursorSettler;
  cursorFocused: boolean;
  /** Debounce timer that resumes blinking after typing pauses. */
  typingIdleTimer: number | null;
  highlighter: Highlighter;
}

const sessions = new Map<string, Session>();
const listeners = new Set<() => void>();

let fontSize = 13.5;
let highlightEnabled = true;
const FONT_FAMILY =
  '"CaskaydiaCove Nerd Font", "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace';

const measureCanvas = document.createElement("canvas").getContext("2d");

/**
 * Measure a font size exactly the way xterm does, so the cell size worked out
 * here is the cell size it will use: canvas TextMetrics for the advance and the
 * font's own bounding box, with xterm's fallback (a 32-character run measured
 * through the DOM) for engines without `fontBoundingBoxAscent`.
 */
function measureFont(size: number): { width: number; height: number } {
  if (measureCanvas) {
    measureCanvas.font = `${size}px ${FONT_FAMILY}`;
    const m = measureCanvas.measureText("W");
    const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    if (m.width > 0 && height > 0) return { width: m.width, height };
  }
  const el = document.createElement("span");
  el.style.cssText =
    "position:absolute;top:-10000px;left:-10000px;white-space:pre;" +
    `line-height:normal;font-family:${FONT_FAMILY};font-size:${size}px`;
  el.textContent = "W".repeat(32);
  document.body.appendChild(el);
  const width = el.offsetWidth / 32;
  const height = el.offsetHeight;
  el.remove();
  return { width, height };
}

const metricsCache = new Map<string, { fontSize: number; lineHeight: number }>();

/**
 * Pick the font size and line height that make block-drawing art come out
 * right, which is what most TUI splash screens and progress bars are built from.
 *
 * Two things go wrong if you just hand xterm a size:
 *  - xterm derives its cell width straight from the measured advance, so a
 *    fractional device width puts every column on a sub-pixel boundary and
 *    leaves hairline seams through what should be solid blocks. Nudging the
 *    size onto a whole device pixel removes them.
 *  - block art is half-block based: one cell is two "pixels" stacked, so those
 *    pixels are only square when the cell is exactly twice as tall as it is
 *    wide. A generous line height stretches the art vertically — a 1.28 line
 *    height is what made the Claude Code mascot look pulled out of shape.
 */
function metricsFor(size: number): { fontSize: number; lineHeight: number } {
  const dpr = window.devicePixelRatio || 1;
  const key = `${size}@${dpr}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;

  let best = size;
  let bestError = Infinity;
  // ±1.2px is roughly ±9% — imperceptible as a size change, and wide enough that
  // a whole-pixel advance always falls inside it. Nearest size wins, so the
  // search walks outwards from the one that was asked for.
  for (let delta = 0; delta <= 1.2 && bestError > 0.005; delta += 0.02) {
    for (const candidate of delta === 0 ? [size] : [size - delta, size + delta]) {
      const device = measureFont(candidate).width * dpr;
      const error = Math.abs(device - Math.round(device));
      if (error < bestError) {
        best = candidate;
        bestError = error;
      }
    }
  }

  const { width, height } = measureFont(best);
  const cellWidth = Math.round(width * dpr);
  const charHeight = Math.ceil(height * dpr);
  // xterm floors `charHeight * lineHeight`; the half-pixel lands the result on
  // 2×cellWidth instead of one short of it.
  const square = (2 * cellWidth + 0.5) / charHeight;
  // Clamped so a font with unusually tall metrics can't crush the text: at the
  // bottom of the range ascenders and descenders still have room.
  const metrics = { fontSize: best, lineHeight: Math.min(1.25, Math.max(0.95, square)) };
  metricsCache.set(key, metrics);
  return metrics;
}

/** The pixel ratio the mounted terminals were sized for. */
let metricsDpr = 0;

/** Size every terminal for the current font size and pixel ratio. */
function applyMetrics(): void {
  const metrics = metricsFor(fontSize);
  metricsDpr = window.devicePixelRatio || 1;
  for (const session of sessions.values()) {
    session.term.options.fontSize = metrics.fontSize;
    session.term.options.lineHeight = metrics.lineHeight;
  }
}

/** Off-screen parking spot so xterm keeps a live layout while unmounted. */
function limbo(): HTMLElement {
  let el = document.getElementById("xterm-limbo");
  if (!el) {
    el = document.createElement("div");
    el.id = "xterm-limbo";
    el.style.cssText =
      "position:fixed;left:-10000px;top:0;width:900px;height:600px;pointer-events:none;visibility:hidden;";
    document.body.appendChild(el);
  }
  return el;
}

function notify() {
  for (const cb of listeners) cb();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getMeta(id: string): TermMeta | null {
  const s = sessions.get(id);
  if (!s) return null;
  return {
    title: s.title,
    cwd: s.cwd,
    shellLabel: s.shellLabel,
    exited: s.exited,
    exitCode: s.exitCode,
    cols: s.cols,
    rows: s.rows,
  };
}

export function newTermId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Windows shells report their full executable path as the window title, which
 * is useless in a 200px header. Keep just the command name in that case.
 */
function prettyTitle(raw: string, fallback: string): string {
  const title = raw.trim();
  if (!title) return fallback;
  if (/[\\/]/.test(title) && /\.(exe|cmd|bat|com)$/i.test(title)) {
    const base = title.split(/[\\/]/).pop() ?? title;
    return base.replace(/\.(exe|cmd|bat|com)$/i, "");
  }
  return title;
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** How long after the last keystroke before the caret returns to idle blinking. */
const TYPING_IDLE_MS = 600;

/** Send bytes to the shell, queueing them if the PTY is not up yet. */
function send(session: Session, data: string): void {
  if (session.spawned) void ptyWrite(session.id, data);
  else session.pending.push(data);
}

function isTyping(session: Session): boolean {
  return session.typingIdleTimer !== null;
}

/**
 * Hold the caret solid while the user is actively typing or deleting.
 *
 * Driven from `onData` (not keydown): xterm handles keys in the capture phase and
 * some printable input only becomes data on the `input` event, so keydown alone
 * misses characters inside full-screen CLIs. `onData` is every byte the user
 * actually sends — keys, backspace, enter, and paste.
 */
function markTyping(session: Session): void {
  session.visualCursor.dataset.typing = "true";
  session.visualCursor.classList.remove("is-blinking");
  if (session.typingIdleTimer !== null) window.clearTimeout(session.typingIdleTimer);
  session.typingIdleTimer = window.setTimeout(() => {
    delete session.visualCursor.dataset.typing;
    session.typingIdleTimer = null;
    // Resume blinking with the cursor visible, not mid-off-phase: restart the
    // animation so it begins in its "on" segment.
    session.visualCursor.classList.remove("is-blinking");
    void session.visualCursor.offsetWidth;
    session.visualCursor.classList.add("is-blinking");
  }, TYPING_IDLE_MS);
}

function clearTyping(session: Session): void {
  if (session.typingIdleTimer !== null) {
    window.clearTimeout(session.typingIdleTimer);
    session.typingIdleTimer = null;
  }
  delete session.visualCursor.dataset.typing;
}

function disarmCursor(session: Session): void {
  session.cursorSettler.cancel();
}

function hideVisualCursor(session: Session): void {
  disarmCursor(session);
  session.visualCursor.hidden = true;
}

/** Paint the visual cursor from xterm's fully-parsed buffer snapshot. */
function paintVisualCursor(session: Session): void {
  const { term, visualCursor } = session;
  const buffer = term.buffer.active;
  if (
    !session.cursorVisible ||
    !session.cursorFocused ||
    !session.container ||
    buffer.viewportY !== buffer.baseY
  ) {
    visualCursor.hidden = true;
    return;
  }

  const screen = session.host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || screen.clientWidth <= 0 || screen.clientHeight <= 0) {
    visualCursor.hidden = true;
    return;
  }

  const hostRect = session.host.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const column = Math.min(buffer.cursorX, term.cols - 1);
  const row = Math.min(buffer.cursorY, term.rows - 1);
  const x = screenRect.left - hostRect.left + column * cellWidth;
  const y = screenRect.top - hostRect.top + row * cellHeight;

  visualCursor.style.setProperty("--terminal-cell-width", `${cellWidth}px`);
  visualCursor.style.setProperty("--terminal-cell-height", `${cellHeight}px`);
  visualCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  visualCursor.dataset.style = term.options.cursorStyle ?? "block";
  visualCursor.hidden = false;
}

/**
 * Update the cursor independently from terminal grid writes.
 *
 * Short same-row movement remains immediate for responsive typing. A row change
 * or large horizontal jump is held for one render cycle: Codex's next tiny
 * update moves the buffer cursor back to its composer and cancels a provisional
 * status/footer position.
 */
function scheduleVisualCursor(session: Session, forceSettle = false): void {
  if (!session.cursorFocused || !session.container) {
    hideVisualCursor(session);
    return;
  }

  // TUI harnesses (Codex, Claude Code, …) often hide mode 25 while repainting
  // the composer after each keystroke. If we blank the caret then, it looks
  // like idle blink even though the user is still typing. Keep the last solid
  // position until the program puts the cursor back.
  if (!session.cursorVisible) {
    if (isTyping(session)) return;
    hideVisualCursor(session);
    return;
  }

  const buffer = session.term.buffer.active;
  if (buffer.viewportY !== buffer.baseY) {
    hideVisualCursor(session);
    return;
  }

  session.cursorSettler.schedule(
    { row: buffer.cursorY, column: buffer.cursorX },
    () => paintVisualCursor(session),
    forceSettle,
  );
}

/** Hand assembled output to xterm, colourised if that is switched on. */
function draw(session: Session, chunk: FrameWrite): void {
  // The highlighter needs to see every chunk, even while highlighting is off,
  // so its escape-sequence state stays in sync with the stream.
  const painted = session.highlighter(chunk.text);
  const output = highlightEnabled ? painted : chunk.text;
  const stabilized = stabilizeCursorDuringFrame(
    output,
    session.cursorVisible,
    chunk.synchronized,
    chunk.complete,
  );
  session.cursorVisible = stabilized.cursorVisible;
  // While typing, leave the solid caret in place across brief mode-25 hides
  // that full-screen CLIs emit mid-redraw; scheduleVisualCursor re-evaluates.
  if (!session.cursorVisible && !isTyping(session)) hideVisualCursor(session);
  session.term.write(stabilized.text, () => scheduleVisualCursor(session));
}

function create(id: string, opts: { cwd?: string | null; shell?: string | null }): Session {
  const metrics = metricsFor(fontSize);
  metricsDpr = window.devicePixelRatio || 1;
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: FONT_FAMILY,
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    letterSpacing: 0,
    scrollback: 20000,
    smoothScrollDuration: 0,
    theme: terminalTheme,
    macOptionIsMeta: true,
    // ConPTY rewrites the screen instead of emitting real newlines; telling
    // xterm about it keeps reflow and selection correct on Windows.
    ...(navigator.userAgent.includes("Windows")
      ? { windowsPty: { backend: "conpty" as const } }
      : {}),
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon());
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = "11";

  const host = document.createElement("div");
  host.className = "xterm-host";
  limbo().appendChild(host);
  term.open(host);
  // xterm parses the grid, but the cursor is a separate overlay controlled
  // below. Keep its native cursor off from the very first paint.
  term.write("\x1b[?25l");

  const visualCursor = document.createElement("div");
  visualCursor.className = "terminal-visual-cursor is-blinking";
  visualCursor.style.setProperty("--terminal-cursor-color", GREEN);
  visualCursor.hidden = true;
  host.appendChild(visualCursor);

  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // WebGL is optional; the DOM renderer is the fallback.
  }

  const session: Session = {
    id,
    term,
    fit,
    search,
    host,
    container: null,
    observer: null,
    unlisten: [],
    spawned: false,
    starting: false,
    pending: [],
    decoder: new TextDecoder(),
    // `session` is only read when a frame completes, long after this returns.
    frames: createFrameBuffer((chunk) => draw(session, chunk)),
    cursorVisible: true,
    visualCursor,
    cursorSettler: createCursorSettler(),
    cursorFocused: false,
    typingIdleTimer: null,
    highlighter: createHighlighter(),
    title: "shell",
    cwd: opts.cwd ?? "",
    shellLabel: "",
    exited: false,
    exitCode: null,
    cols: term.cols,
    rows: term.rows,
  };
  sessions.set(id, session);

  term.onData((data) => {
    markTyping(session);
    send(session, data);
  });
  term.onScroll(() => scheduleVisualCursor(session, true));
  term.textarea?.addEventListener("focus", () => {
    session.cursorFocused = true;
    scheduleVisualCursor(session, true);
  });
  term.textarea?.addEventListener("blur", () => {
    session.cursorFocused = false;
    clearTyping(session);
    hideVisualCursor(session);
  });

  // DECRQM for mode 2026. xterm.js does not know the mode and would answer "not
  // recognised", which is exactly how a program decides synchronized output is
  // unavailable and goes back to redrawing in pieces. Registered last so it runs
  // first — every other mode returns false and falls through to xterm's own
  // handler, which still owns them.
  // Mode 25 is the exception: report the separately painted cursor's state.
  term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
    const mode = params[0];
    if (mode === 25) {
      send(session, `\x1b[?25;${session.cursorVisible ? 1 : 2}$y`);
      return true;
    }
    if (mode !== SYNC_MODE) return false;
    // DECRPM: 1 = currently set, 2 = currently reset. Either one answers the
    // question the program is actually asking, which is whether we know the mode.
    send(session, `\x1b[?${SYNC_MODE};${session.frames.isFraming() ? 1 : 2}$y`);
    return true;
  });

  term.onTitleChange((title) => {
    const clean = prettyTitle(title, session.shellLabel || session.title);
    if (clean && clean !== session.title) {
      session.title = clean;
      notify();
    }
  });

  term.onResize(({ cols, rows }) => {
    session.cols = cols;
    session.rows = rows;
    if (session.spawned) void ptyResize(id, cols, rows);
    notify();
  });

  // OSC 7 — file://host/path — the de-facto cwd reporting sequence.
  term.parser.registerOscHandler(7, (payload) => {
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(payload);
    if (match) {
      let p = decodeURIComponent(match[1]);
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replace(/\//g, "\\");
      session.cwd = p;
      notify();
    }
    return true;
  });

  // OSC 9;9;<path> — what Windows Terminal / PowerShell profiles emit.
  term.parser.registerOscHandler(9, (payload) => {
    const match = /^9;(.+)$/.exec(payload);
    if (match) {
      session.cwd = match[1].replace(/^"|"$/g, "");
      notify();
    }
    return false;
  });

  void start(session, opts);
  return session;
}

async function start(session: Session, opts: { cwd?: string | null; shell?: string | null }) {
  const { id } = session;
  // A session starts exactly once. This only matters if `create` ever runs twice
  // for the same id — the backend would answer the second spawn with
  // "already exists" and the pane would die with that message.
  if (session.starting || session.spawned) return;
  session.starting = true;

  // Subscribe before spawning so no output can slip through.
  const offData = await listen<string>(`pty:data:${id}`, (event) => {
    // Decoding moves here from xterm because everything downstream — frame
    // reassembly and the highlighter — works on text. `stream` keeps a UTF-8
    // character split across two PTY reads intact.
    const text = session.decoder.decode(decodeBase64(event.payload), { stream: true });
    session.frames.push(text);
  });
  const offExit = await listen<{ code: number | null }>(`pty:exit:${id}`, (event) => {
    // A program killed mid-redraw leaves a frame open; draw it before the notice
    // so the last thing it managed to print stays above its own epitaph.
    session.frames.flush();
    session.cursorVisible = false;
    clearTyping(session);
    hideVisualCursor(session);
    session.exited = true;
    session.exitCode = event.payload.code ?? null;
    const code = session.exitCode;
    session.term.write(
      `\r\n\x1b[38;5;244m[process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`,
    );
    notify();
  });
  session.unlisten.push(offData, offExit);

  try {
    const args = {
      id,
      cwd: opts.cwd ?? null,
      shell: opts.shell ?? null,
      cols: session.term.cols,
      rows: session.term.rows,
    };
    let result;
    try {
      result = await ptySpawn(args);
    } catch (error) {
      // A webview reload (Vite HMR, manual refresh) leaves the backend PTY
      // alive while this side starts from scratch — the restored pane asks for
      // an id the backend still owns. Kill the orphan and spawn again.
      if (!String(error).includes("already exists")) throw error;
      await ptyKill(id);
      result = await ptySpawn(args);
    }
    session.shellLabel = result.shell_label;
    session.title = result.shell_label;
    if (!session.cwd) session.cwd = result.cwd;
    session.spawned = true;
    // The pane may have been resized while the spawn was in flight; resizes are
    // dropped before the PTY exists, so re-assert the current geometry.
    void ptyResize(id, session.term.cols, session.term.rows);
    for (const chunk of session.pending) void ptyWrite(id, chunk);
    session.pending = [];
    notify();
  } catch (error) {
    session.exited = true;
    session.term.write(`\r\n\x1b[31mfailed to start shell: ${String(error)}\x1b[0m\r\n`);
    notify();
  }
}

/**
 * Move the terminal for `id` into `container`, creating it on first use.
 * Safe to call repeatedly — React remounts panes whenever the layout changes.
 */
export function attach(
  id: string,
  container: HTMLElement,
  opts: { cwd?: string | null; shell?: string | null } = {},
): void {
  const session = sessions.get(id) ?? create(id, opts);

  if (session.container !== container) {
    container.appendChild(session.host);
    session.container = container;
  }

  session.observer?.disconnect();
  const observer = new ResizeObserver(() => refit(id));
  observer.observe(container);
  session.observer = observer;

  refit(id);
  scheduleVisualCursor(session, true);
}

/** Park the terminal off-screen; its scrollback and process stay alive. */
export function detach(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.observer?.disconnect();
  session.observer = null;
  session.container = null;
  hideVisualCursor(session);
  limbo().appendChild(session.host);
}

export function refit(id: string): void {
  const session = sessions.get(id);
  if (!session || !session.container) return;
  const { clientWidth, clientHeight } = session.container;
  if (clientWidth < 20 || clientHeight < 20) return;
  try {
    session.fit.fit();
    scheduleVisualCursor(session, true);
  } catch {
    // Fit can throw while the pane is mid-animation; the observer retries.
  }
}

/** Re-measure every mounted terminal — used after window resize/fullscreen. */
export function refitAll(): void {
  // Moving the window to a display with a different scale factor arrives here as
  // a resize, and it invalidates the cell size the metrics were picked for.
  if ((window.devicePixelRatio || 1) !== metricsDpr) applyMetrics();
  for (const id of sessions.keys()) refit(id);
}

export function focus(id: string): void {
  sessions.get(id)?.term.focus();
}

export function dispose(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.observer?.disconnect();
  session.frames.dispose();
  clearTyping(session);
  hideVisualCursor(session);
  for (const off of session.unlisten) off();
  void ptyKill(id);
  session.term.dispose();
  session.host.remove();
  sessions.delete(id);
  notify();
}

export function disposeAll(): void {
  for (const id of [...sessions.keys()]) dispose(id);
}

export function setFontSize(size: number): void {
  // The requested size is what's kept and stepped from; each terminal renders at
  // the nudged size metricsFor picks so the steps don't compound.
  fontSize = Math.min(28, Math.max(8, size));
  applyMetrics();
  for (const id of sessions.keys()) refit(id);
  notify();
}

export function getFontSize(): number {
  return fontSize;
}

/**
 * Turn the colouriser for uncoloured output on or off. It only affects output
 * written from here on — scrollback keeps whatever colours it was drawn with.
 */
export function setHighlight(enabled: boolean): void {
  highlightEnabled = enabled;
  notify();
}

export function getHighlight(): boolean {
  return highlightEnabled;
}

export function clear(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.term.clear();
}

export function selection(id: string): string {
  return sessions.get(id)?.term.getSelection() ?? "";
}

export function paste(id: string, text: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.term.paste(text);
}

export function findNext(id: string, query: string): void {
  sessions.get(id)?.search.findNext(query, { incremental: false, decorations: searchDecorations });
}

export function findPrevious(id: string, query: string): void {
  sessions.get(id)?.search.findPrevious(query, { decorations: searchDecorations });
}

export function clearSearch(id: string): void {
  sessions.get(id)?.search.clearDecorations();
}

const searchDecorations = {
  matchBackground: "#2f5e1f",
  matchBorder: "#4a9b32",
  matchOverviewRuler: "#4a9b32",
  activeMatchBackground: "#7be05a",
  activeMatchBorder: "#d6ffc4",
  activeMatchColorOverviewRuler: "#d6ffc4",
};
