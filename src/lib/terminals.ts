import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { BlockTracker } from "./blocks";
import * as commandHistory from "./commandHistory";
import { createCursorSettler, type CursorSettler } from "./cursor";
import {
  createFrameBuffer,
  stabilizeCursorDuringFrame,
  SYNC_MODE,
  type FrameBuffer,
  type FrameWrite,
} from "./frames";
import { createHighlighter, type Highlighter } from "./highlight";
import {
  agentUnwatch,
  agentWatch,
  ptyAnyBusy,
  ptyIsBusy,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "./ipc";
import {
  detectAgent,
  isGenericOsc777Notification,
  parseAgentOsc777,
  type AgentKind,
} from "./processActivity";
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
  /** A child process currently owns this terminal. */
  busy: boolean;
  /** Wall-clock captured when the current child process first became active. */
  processStartedAt: number | null;
  /** Persistent CLI-agent turns completed while the process remains alive. */
  completionSeq: number;
  /** Recognised coding agent currently responsible for the terminal activity. */
  agent: AgentKind | null;
  /**
   * Something has been sent to the shell since the pane opened (or since the
   * last clear). Until then the grid holds only a prompt, which the pane hides
   * behind its empty state.
   */
  ran: boolean;
}

interface Session extends TermMeta {
  id: string;
  /** A user-supplied title stays put instead of being replaced by OSC 0/2. */
  titleLocked: boolean;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webgl: WebglAddon | null;
  /** The element xterm renders into; it is moved between panes, never recreated. */
  host: HTMLDivElement;
  container: HTMLElement | null;
  observer: ResizeObserver | null;
  unlisten: UnlistenFn[];
  dataChannel: Channel<ArrayBuffer> | null;
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
  /**
   * Prefer the Warp-style command editor over typing into the raw grid.
   * Cleared when a full-screen / interactive program needs the real PTY.
   */
  editorMode: boolean;
  /** Re-entry guard while we clear empty selections. */
  trimmingSelection: boolean;
  /**
   * Groups each submitted command and its output into a selectable block with
   * a hairline separator — the Warp "command blocks" primitive.
   */
  blocks: BlockTracker;
  /**
   * Wall-clock of the last non-empty command submission. Empty Ctrl+C still
   * interrupts for a short window after submit, before the busy poll flips.
   */
  lastSubmitAt: number;
  /**
   * Commands submitted in this pane only (oldest first). Used by ↑/↓ history
   * walk so each terminal recalls its own recent commands, not a global list.
   * Shared autosuggest history lives in {@link commandHistory}.
   */
  history: string[];
  /**
   * Unsent composer text for this session. Lives here (not in React state)
   * so a layout remount — first split, drag, zoom — does not wipe a draft
   * the user has not submitted yet.
   */
  draft: string;
  /** Deduplicates a log event and OSC notification for the same completed turn. */
  lastAgentCompletionAt: number;
  /** Command assembled while the conventional raw terminal owns shell input. */
  rawCommand: string;
}

/** Focus handlers for the per-pane command editor (Warp-style input). */
const inputFocusers = new Map<string, () => void>();
/** Paste handlers so right-click paste can land in the editor buffer. */
const inputPasters = new Map<string, (text: string) => void>();

const sessions = new Map<string, Session>();
const sessionListeners = new Map<string, Set<() => void>>();
const settingsListeners = new Set<() => void>();
let busyUnlisten: Promise<UnlistenFn> | null = null;
let agentUnlisten: Promise<UnlistenFn> | null = null;

/**
 * How keystrokes reach the shell, app-wide.
 *
 * `editor` is the Warp arrangement: a real text field below the grid that
 * submits whole commands. `raw` is a conventional terminal, where the grid owns
 * the keyboard. It is a setting rather than a per-pane mode you fall into,
 * because a modifier key that silently changes where your typing goes is a trap
 * — you find out you were in the other mode by what it did to your shell.
 *
 * Panes still hand the keyboard to the grid on their own while a child process
 * is running; that is not a mode, it is who the keystrokes belong to.
 */
export type InputMode = "editor" | "raw";

let inputMode: InputMode = "editor";
let fontSize = 13.5;
let highlightEnabled = true;
const TAURI_RUNTIME = "__TAURI_INTERNALS__" in window;
const FONT_FAMILY =
  '"CaskaydiaCove Nerd Font", "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace';
/**
 * One device pixel of breathing room prevents bold ANSI glyphs from painting
 * into the next cell. xterm floors the measured character advance for WebGL,
 * so at fractional font sizes the ink can otherwise be wider than the cell.
 */
const LETTER_SPACING = 1;

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
 * Pick line height (and keep font size) so block-drawing art stays square.
 *
 * Block art is half-block based: one cell is two "pixels" stacked, so those
 * pixels are only square when the cell is exactly twice as tall as it is wide.
 * A generous line height stretches the art vertically — a 1.28 line height is
 * what made the Claude Code mascot look pulled out of shape.
 *
 * Font size is the value the user asked for. An earlier version nudged it by
 * up to ±1.2px to land on a whole device-pixel advance; that made neighbouring
 * settings steps (12.5 vs 13.5) render as the same face, so the label moved and
 * the grid did not. Honour the request; only lineHeight is derived.
 */
function metricsFor(size: number): { fontSize: number; lineHeight: number } {
  const dpr = window.devicePixelRatio || 1;
  const key = `${size}@${dpr}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;

  const { width, height } = measureFont(size);
  const cellWidth = Math.max(1, Math.round(width * dpr));
  const charHeight = Math.max(1, Math.ceil(height * dpr));
  // xterm floors `charHeight * lineHeight`; the half-pixel lands the result on
  // 2×cellWidth instead of one short of it.
  const square = (2 * cellWidth + 0.5) / charHeight;
  // xterm rejects lineHeight < 1 (throws on options write). Floor at 1 so a
  // tall font never aborts setFontSize after only half the metrics applied.
  // Cap at 1.25 so the text is never stretched into the old "pulled" look.
  const metrics = {
    fontSize: size,
    lineHeight: Math.min(1.25, Math.max(1, square)),
  };
  metricsCache.set(key, metrics);
  return metrics;
}

/** The pixel ratio the mounted terminals were sized for. */
let metricsDpr = 0;

/**
 * Mirror the terminal font into CSS so the command editor (and anything else
 * that should match the grid) updates the moment the setting changes — not only
 * the xterm cells.
 */
function syncFontCss(): void {
  const root = document.documentElement;
  // Requested size, not the pixel-snapped render size: the composer is not a
  // cell grid, so the user-facing number is the right thing to show there.
  root.style.setProperty("--terminal-font-size", `${fontSize}px`);
  root.style.setProperty("--terminal-line-height", `${Math.round(fontSize * 1.63)}px`);
  root.style.setProperty(
    "--terminal-letter-spacing",
    `${LETTER_SPACING / (window.devicePixelRatio || 1)}px`,
  );
}

/** Size every terminal for the current font size and pixel ratio. */
function applyMetrics(): void {
  const metrics = metricsFor(fontSize);
  metricsDpr = window.devicePixelRatio || 1;
  for (const session of sessions.values()) {
    const { term } = session;
    try {
      term.options.fontSize = metrics.fontSize;
      term.options.lineHeight = metrics.lineHeight;
    } catch (error) {
      // xterm validates option writes; never let one bad value leave the grid
      // stuck at the previous size.
      console.error("failed to apply terminal font metrics", error);
      continue;
    }

    // Force a cell remeasure + WebGL atlas rebuild. Public option writes are
    // supposed to do this; this is belt-and-braces after rapid stepper clicks.
    const core = (
      term as unknown as {
        _core?: {
          _charSizeService?: { measure: () => void };
          _renderService?: { handleCharSizeChanged?: () => void };
        };
      }
    )._core;
    core?._charSizeService?.measure();
    core?._renderService?.handleCharSizeChanged?.();
    try {
      term.clearTextureAtlas();
    } catch {
      // DOM renderer has no atlas.
    }
    term.refresh(0, term.rows - 1);
  }
  syncFontCss();
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

function notifySession(id: string) {
  for (const cb of sessionListeners.get(id) ?? []) cb();
}

function notifySettings() {
  for (const cb of settingsListeners) cb();
}

export function subscribeSession(id: string, cb: () => void): () => void {
  let listeners = sessionListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    sessionListeners.set(id, listeners);
  }
  listeners.add(cb);
  return () => {
    listeners?.delete(cb);
    if (listeners?.size === 0) sessionListeners.delete(id);
  };
}

export function subscribeSettings(cb: () => void): () => void {
  settingsListeners.add(cb);
  return () => settingsListeners.delete(cb);
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
    busy: s.busy,
    processStartedAt: s.processStartedAt,
    completionSeq: s.completionSeq,
    agent: s.agent,
    ran: s.ran,
  };
}

/** Give a terminal a stable user-facing name. */
export function rename(id: string, title: string): void {
  const session = sessions.get(id);
  const clean = title.trim();
  if (!session || !clean) return;
  session.titleLocked = true;
  if (session.title === clean) return;
  session.title = clean;
  notifySession(id);
}

/**
 * Viewport row of the last line holding anything but blanks, or -1 when the
 * whole viewport is empty. Everything below it is dead space.
 */
function lastContentRow(term: Terminal): number {
  const buffer = term.buffer.active;
  for (let row = term.rows - 1; row >= 0; row--) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (line && /\S/.test(line.translateToString(true))) return row;
  }
  return -1;
}

/** Mark the pane as having real content, so the empty state steps aside. */
function markRan(session: Session): void {
  if (session.ran) return;
  session.ran = true;
  notifySession(session.id);
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

interface BusyPayload {
  id: string;
  busy: boolean;
}

interface AgentCompletionPayload {
  id: string;
  agent: AgentKind;
}

function markAgentComplete(session: Session): void {
  const now = Date.now();
  if (now - session.lastAgentCompletionAt < 1200) return;
  session.lastAgentCompletionAt = now;
  session.completionSeq += 1;
  notifySession(session.id);
}

function bindAgentKind(session: Session, agent: AgentKind): void {
  if (session.agent === agent) return;
  session.agent = agent;
  if (TAURI_RUNTIME) void agentWatch(session.id, agent, session.cwd);
}

function bindAgentCommand(session: Session, command: string): void {
  const agent = detectAgent(command);
  if (agent) bindAgentKind(session, agent);
}

function captureRawAgentCommand(session: Session, data: string): void {
  if (session.editorMode || session.busy || session.agent) return;
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      if (session.rawCommand.trim()) session.lastSubmitAt = Date.now();
      bindAgentCommand(session, session.rawCommand);
      session.rawCommand = "";
    } else if (char === "\x7f" || char === "\b") {
      session.rawCommand = session.rawCommand.slice(0, -1);
    } else if (char === "\x15") {
      session.rawCommand = "";
    } else if (char >= " " || char === "\x1b") {
      session.rawCommand = (session.rawCommand + char).slice(-2048);
    }
  }
}

function unbindAgent(session: Session): void {
  if (!session.agent) return;
  session.agent = null;
  session.rawCommand = "";
  if (TAURI_RUNTIME) void agentUnwatch(session.id);
}

/** One listener receives turn completion events from every watched agent log. */
function ensureAgentListener(): void {
  if (!TAURI_RUNTIME || agentUnlisten) return;
  agentUnlisten = listen<AgentCompletionPayload>("agent:complete", (event) => {
    const session = sessions.get(event.payload.id);
    if (!session) return;
    if (!session.agent) session.agent = event.payload.agent;
    markAgentComplete(session);
  });
}

/** One app-wide listener replaces the per-pane busy polling loops. */
function ensureBusyListener(): void {
  if (!TAURI_RUNTIME) return;
  if (busyUnlisten) return;
  busyUnlisten = listen<BusyPayload[]>("pty:busy", (event) => {
    for (const state of event.payload) {
      const session = sessions.get(state.id);
      if (!session || session.busy === state.busy) continue;
      const wasBusy = session.busy;
      session.busy = state.busy;
      if (state.busy) {
        const now = Date.now();
        // The native busy monitor samples twice a second. Prefer the command
        // submission time when it is recent so the 30-second threshold is not
        // shortened by that polling delay.
        session.processStartedAt =
          session.lastSubmitAt > 0 && now - session.lastSubmitAt < 5_000
            ? session.lastSubmitAt
            : now;
      }
      session.blocks.busyChanged(state.busy);
      notifySession(state.id);
      // Completion subscribers read these synchronously from the notification.
      // Clear them afterwards so they can still classify the process that ended.
      if (wasBusy && !state.busy) {
        session.processStartedAt = null;
        unbindAgent(session);
      }
    }
  });
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
  // In editor mode the caret lives in the command bar, not the grid.
  if (
    session.editorMode ||
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
  const painted = session.highlighter(chunk.text, highlightEnabled);
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
  session.term.write(stabilized.text, () => {
    scheduleVisualCursor(session);
    session.blocks.scheduleLayout();
  });
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
    letterSpacing: LETTER_SPACING,
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

  const session: Session = {
    id,
    term,
    fit,
    search,
    webgl: null,
    host,
    container: null,
    observer: null,
    unlisten: [],
    dataChannel: null,
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
    editorMode: true,
    trimmingSelection: false,
    blocks: null as unknown as BlockTracker,
    title: "shell",
    titleLocked: false,
    cwd: opts.cwd ?? "",
    shellLabel: "",
    exited: false,
    exitCode: null,
    cols: term.cols,
    rows: term.rows,
    busy: false,
    processStartedAt: null,
    completionSeq: 0,
    ran: false,
    lastSubmitAt: 0,
    history: [],
    draft: "",
    agent: null,
    lastAgentCompletionAt: 0,
    rawCommand: "",
  };
  sessions.set(id, session);
  ensureBusyListener();
  ensureAgentListener();
  // Selecting a chunk here drops chunk selection everywhere else so two panes
  // never show a selected block at the same time.
  session.blocks = new BlockTracker(term, host, () => clearOtherBlockSelections(id));

  term.onData((data) => {
    captureRawAgentCommand(session, data);
    markTyping(session);
    send(session, data);
  });

  // `onKey` rather than `onData`, because not everything the terminal sends is
  // something the user did: ConPTY queries the terminal on startup (cursor
  // position, device attributes) and xterm answers through `onData`. Treating
  // those replies as input marked every pane as used before it had run
  // anything, which is exactly what the empty state is there to hide.
  term.onKey(() => markRan(session));
  term.onScroll(() => {
    scheduleVisualCursor(session, true);
    session.blocks.scheduleLayout();
  });

  /** Keys the grid keeps in editor mode: they move the view, not the cursor. */
  const VIEWPORT_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "Shift", "Control", "Alt", "Meta"]);

  // Editor mode means the composer owns typing, and clicking output to copy it
  // must not quietly change that. Without this, a click on the grid moved DOM
  // focus to xterm and the next keystroke went straight down the PTY — the same
  // "your typing is somewhere else now" problem the Escape mode had.
  term.attachCustomKeyEventHandler((event) => {
    if (session.exited) return true;
    if (event.type !== "keydown") return true;

    const ctrl = event.ctrlKey || event.metaKey;
    // Ctrl+C on the grid: copy when there is a selection (select-then-copy),
    // otherwise only interrupt when something is running. Letting xterm turn
    // every idle Ctrl+C into \x03 makes PowerShell stack `PS …> ^C` lines.
    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
      let text = "";
      if (session.blocks.hasBlockSelection()) {
        text = session.blocks.copyText() ?? "";
      }
      if (!text) text = term.getSelection();
      if (/\S/.test(text)) {
        event.preventDefault();
        void navigator.clipboard.writeText(text);
        return false;
      }
      if (session.editorMode) {
        event.preventDefault();
        void interrupt(session.id);
        return false;
      }
      // Raw mode, no selection: real interrupt for the running program.
      return true;
    }

    // xterm encodes Shift+Enter exactly like Enter — a bare CR — so TUIs that
    // treat the two differently (Claude Code, Codex, aider) submit instead of
    // inserting a line break. ESC+CR is the sequence `/terminal-setup` installs
    // in VS Code and iTerm2 for precisely this.
    if (event.key === "Enter" && event.shiftKey && !ctrl && !event.altKey) {
      event.preventDefault();
      markTyping(session);
      send(session, "\x1b\r");
      return false;
    }

    if (!session.editorMode) return true;

    // Keyboard block navigation while focus sits on the grid (after a click
    // select). Ctrl+Up always selects the latest block; plain Up/Down walk.
    if (event.key === "ArrowUp" && ctrl && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      session.blocks.navigate("selectLast");
      return false;
    }
    if (session.blocks.hasNavSelection()) {
      if (event.key === "ArrowUp" && !ctrl && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        session.blocks.navigate("prev");
        return false;
      }
      if (event.key === "ArrowDown" && !ctrl && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        session.blocks.navigate("next");
        return false;
      }
      if (event.key === "Escape" && !ctrl && !event.altKey) {
        event.preventDefault();
        session.blocks.clearSelection();
        inputFocusers.get(session.id)?.();
        return false;
      }
    }

    // App shortcuts and remaining copy/paste are handled elsewhere.
    if (ctrl || event.altKey) return true;
    if (VIEWPORT_KEYS.has(event.key)) return true;
    const focusInput = inputFocusers.get(session.id);
    if (!focusInput) return true;

    // xterm only consults this handler; it does not stop the browser from
    // typing the character into its hidden textarea, which would reach the PTY
    // through the input event. Cancelling here is what actually holds it back.
    event.preventDefault();
    focusInput();
    // A printable key is the user starting a command — carry it across so the
    // first character is not the price of having clicked on the output.
    if (event.key.length === 1) inputPasters.get(session.id)?.(event.key);
    return false;
  });

  // Warp-style: the dead space under the last line of output holds no text, so
  // a drag that starts there can only ever select nothing. xterm would still
  // paint the whole rectangle green until the button came up — it fires
  // `onSelectionChange` on mouseup, not during the drag — so the trim below
  // cannot help. Refusing the press is what makes the empty area behave like
  // the empty area of a Warp block list: inert.
  //
  // Capture phase on the host, so the event never reaches xterm's own handler.
  host.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || event.shiftKey) return;
      // A program that asked for mouse reporting gets its clicks, wherever they
      // land — an empty-looking row is still a row it is drawing on. Same for
      // the alt buffer, which belongs to whatever full-screen thing is running.
      if (term.modes.mouseTrackingMode !== "none") return;
      if (term.buffer.active.type !== "normal") return;
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      if (rect.height <= 0) return;
      const row = Math.floor(((event.clientY - rect.top) / rect.height) * term.rows);
      if (row <= lastContentRow(term)) return;
      event.preventDefault();
      event.stopPropagation();
      // Clicking away still dismisses whatever was selected before.
      session.blocks.clearSelection();
      focus(id);
    },
    true,
  );

  // Selections that start in real content can still be dragged down past it.
  // Anything that comes out as pure whitespace is dropped once the button is
  // released, so it never becomes a copyable "selection" of nothing.
  //
  // Block (chunk) selection is tracked separately from xterm's free-range
  // selection so tall output can stay selected without selectLines locking the
  // viewport. A real free-range selection dismisses the block chrome.
  term.onSelectionChange(() => {
    if (session.trimmingSelection) return;
    if (session.blocks.isApplyingSelection()) return;
    if (!term.hasSelection()) return;
    const text = term.getSelection();
    if (/\S/.test(text)) {
      // User dragged a free-range selection — drop block highlight.
      session.blocks.dismissNavSelection();
      return;
    }
    session.trimmingSelection = true;
    try {
      term.clearSelection();
    } finally {
      session.trimmingSelection = false;
    }
  });

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
    if (session.titleLocked) return;
    const clean = prettyTitle(title, session.shellLabel || session.title);
    if (clean && clean !== session.title) {
      session.title = clean;
      notifySession(id);
    }
  });

  term.onResize(({ cols, rows }) => {
    session.cols = cols;
    session.rows = rows;
    if (session.spawned) void ptyResize(id, cols, rows);
    notifySession(id);
  });

  // OSC 7 — file://host/path — the de-facto cwd reporting sequence.
  term.parser.registerOscHandler(7, (payload) => {
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(payload);
    if (match) {
      let p = decodeURIComponent(match[1]);
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replace(/\//g, "\\");
      session.cwd = p;
      notifySession(id);
    }
    return true;
  });

  // OSC 9;9;<path> — what Windows Terminal / PowerShell profiles emit.
  term.parser.registerOscHandler(9, (payload) => {
    const match = /^9;(.+)$/.exec(payload);
    if (match) {
      session.cwd = match[1].replace(/^"|"$/g, "");
      notifySession(id);
      return true;
    }
    if (session.agent && payload.trim()) {
      markAgentComplete(session);
      return true;
    }
    return false;
  });

  // Warp's CLI-agent integrations use OSC 777 with a structured JSON body.
  // Supporting the same protocol lets their plugins report a completed turn
  // even though the long-lived agent process remains attached to this PTY.
  term.parser.registerOscHandler(777, (payload) => {
    const event = parseAgentOsc777(payload);
    if (event) {
      if (event.agent) bindAgentKind(session, event.agent);
      if (event.needsAttention) markAgentComplete(session);
      return true;
    }
    if (session.agent && isGenericOsc777Notification(payload)) {
      markAgentComplete(session);
      return true;
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
  // Vite's browser preview has no native process behind it. Keeping the visual
  // shell mountable makes layout/performance testing possible outside Tauri.
  if (!TAURI_RUNTIME) return;

  // Create the raw channel before spawning so no output can slip through.
  const dataChannel = new Channel<ArrayBuffer>();
  dataChannel.onmessage = (payload) => {
    // Decoding moves here from xterm because everything downstream — frame
    // reassembly and the highlighter — works on text. `stream` keeps a UTF-8
    // character split across two PTY reads intact.
    const text = session.decoder.decode(new Uint8Array(payload), { stream: true });
    session.frames.push(text);
  };
  session.dataChannel = dataChannel;
  const offExit = await listen<{ code: number | null }>(`pty:exit:${id}`, (event) => {
    // A program killed mid-redraw leaves a frame open; draw it before the notice
    // so the last thing it managed to print stays above its own epitaph.
    session.frames.flush();
    session.cursorVisible = false;
    clearTyping(session);
    hideVisualCursor(session);
    session.exited = true;
    session.busy = false;
    session.blocks.busyChanged(false);
    session.ran = true;
    session.exitCode = event.payload.code ?? null;
    const code = session.exitCode;
    session.term.write(
      `\r\n\x1b[38;5;244m[process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`,
    );
    notifySession(id);
    session.processStartedAt = null;
    unbindAgent(session);
  });
  session.unlisten.push(offExit);

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
      result = await ptySpawn(args, dataChannel);
    } catch (error) {
      // A webview reload (Vite HMR, manual refresh) leaves the backend PTY
      // alive while this side starts from scratch — the restored pane asks for
      // an id the backend still owns. Kill the orphan and spawn again.
      if (!String(error).includes("already exists")) throw error;
      await ptyKill(id);
      result = await ptySpawn(args, dataChannel);
    }
    session.shellLabel = result.shell_label;
    if (!session.titleLocked) session.title = result.shell_label;
    if (!session.cwd) session.cwd = result.cwd;
    session.spawned = true;
    // The pane may have been resized while the spawn was in flight; resizes are
    // dropped before the PTY exists, so re-assert the current geometry.
    void ptyResize(id, session.term.cols, session.term.rows);
    for (const chunk of session.pending) void ptyWrite(id, chunk);
    session.pending = [];
    notifySession(id);
  } catch (error) {
    session.exited = true;
    session.term.write(`\r\n\x1b[31mfailed to start shell: ${String(error)}\x1b[0m\r\n`);
    notifySession(id);
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

  // Background tabs keep their buffer but release renderer/overlay work. Load
  // WebGL again before paint when the pane becomes visible.
  if (!session.webgl) {
    try {
      session.webgl = new WebglAddon();
      session.term.loadAddon(session.webgl);
    } catch {
      session.webgl = null;
      // WebGL is optional; xterm's DOM renderer is the fallback.
    }
  }
  session.blocks.setActive(true);
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
  session.blocks.setActive(false);
  session.webgl?.dispose();
  session.webgl = null;
  hideVisualCursor(session);
  limbo().appendChild(session.host);
}

export function refit(id: string): void {
  const session = sessions.get(id);
  if (!session || !session.container) return;
  const { clientWidth, clientHeight } = session.container;
  if (clientWidth < 20 || clientHeight < 20) return;
  try {
    // FitAddon only resizes when cols/rows change. After a font-size change the
    // cell metrics have already been rebuilt in applyMetrics; fit here picks up
    // the new column/row count for the same pane.
    session.fit.fit();
    scheduleVisualCursor(session, true);
    session.blocks.scheduleLayout();
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

/**
 * Register the pane's command editor focus callback. When editor mode is on,
 * {@link focus} prefers this over the raw xterm textarea — same idea as Warp's
 * separate input editor.
 */
export function registerInputFocus(id: string, focusFn: () => void): () => void {
  inputFocusers.set(id, focusFn);
  return () => {
    if (inputFocusers.get(id) === focusFn) inputFocusers.delete(id);
  };
}

/** Register how the command editor accepts pasted text. */
export function registerInputPaste(id: string, pasteFn: (text: string) => void): () => void {
  inputPasters.set(id, pasteFn);
  return () => {
    if (inputPasters.get(id) === pasteFn) inputPasters.delete(id);
  };
}

/** Unsent composer buffer for this terminal (survives pane remounts). */
export function getDraft(id: string): string {
  return sessions.get(id)?.draft ?? "";
}

/** Keep the composer draft in session state so layout changes cannot discard it. */
export function setDraft(id: string, text: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.draft = text;
}

/** Prefer the command editor when active; otherwise the raw terminal. */
export function focus(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.editorMode && !session.exited) {
    const focusInput = inputFocusers.get(id);
    if (focusInput) {
      focusInput();
      return;
    }
  }
  session.term.focus();
}

/** Always focus the raw xterm grid (selection, interactive programs). */
export function focusTerminal(id: string): void {
  sessions.get(id)?.term.focus();
}

/**
 * Toggle Warp-style editor mode. When off, keystrokes go straight to the PTY
 * grid — needed for TUIs, password prompts, and nested REPLs that spawn no child.
 */
export function setEditorMode(id: string, enabled: boolean): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.editorMode === enabled) return;
  session.editorMode = enabled;
  // Drop editor-only chrome (prompt cover / selection) for interactive children.
  // Command labels stay up so the shell's `PS path> cmd` echo remains covered.
  session.blocks.setEditorMode(enabled);
  if (!enabled) {
    // Editor mode hides the visual caret in favor of the input bar.
    session.cursorFocused = true;
    scheduleVisualCursor(session, true);
  } else {
    hideVisualCursor(session);
  }
  notifySession(id);
}

export function getEditorMode(id: string): boolean {
  return sessions.get(id)?.editorMode ?? true;
}

/** Max commands kept for per-pane ↑/↓ history. */
const MAX_LOCAL_HISTORY = 200;

/**
 * Record a command on this session only. Consecutive duplicates collapse to
 * a single newest entry (shell-style). Empty/whitespace-only is ignored.
 */
function recordLocalHistory(session: Session, command: string): void {
  const trimmed = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (!trimmed.trim()) return;
  const last = session.history[session.history.length - 1];
  if (last === trimmed) return;
  session.history = [...session.history, trimmed].slice(-MAX_LOCAL_HISTORY);
}

/**
 * Commands submitted in this pane, oldest first — for ↑/↓ history navigation.
 * Distinct from the shared {@link commandHistory} used for ghost suggestions.
 */
export function localHistory(id: string): readonly string[] {
  return sessions.get(id)?.history ?? [];
}

/**
 * Submit a command through the PTY as if the user typed it at a shell prompt.
 * Multi-line buffers use bracketed paste so shells that support it treat the
 * payload as a single unit (Warp sends the editor buffer the same way).
 *
 * Opens a command block at the current cursor line so the command and its
 * output stay selectable as one chunk (Warp-style).
 */
export function submitCommand(id: string, command: string): void {
  const session = sessions.get(id);
  if (!session || session.exited) return;
  markRan(session);
  const text = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) {
    // Empty Enter — just send a newline so the shell re-draws the prompt.
    send(session, "\r");
    session.term.scrollToBottom();
    return;
  }
  // Shared history (ghost autosuggest across panes) + per-pane ↑ walk.
  commandHistory.record(text, session.cwd || null);
  recordLocalHistory(session, text);
  bindAgentCommand(session, text);
  // Mark the block before writing so the start line is the prompt row that
  // will hold the echoed command.
  session.blocks.open(text);
  session.lastSubmitAt = Date.now();
  markTyping(session);
  if (text.includes("\n")) {
    send(session, `\x1b[200~${text}\x1b[201~\r`);
  } else {
    send(session, `${text}\r`);
  }
  // Always follow the new command — if the user had scrolled up to read an
  // older chunk, Enter should drop them back to the live bottom of the grid.
  session.term.scrollToBottom();
  session.blocks.scheduleLayout();
}

/**
 * How long after a submit empty Ctrl+C is still treated as an interrupt, so a
 * quick cancel lands before the busy poll notices the child.
 */
const INTERRUPT_GRACE_MS = 2000;

/**
 * Send Ctrl+C to the shell only when something is (or was just) running.
 *
 * Idle Ctrl+C in editor mode must not reach PowerShell: every press echoes
 * `PS path> ^C` and a fresh prompt, which stacks into noise the block UI has
 * no place for. When a child is running the composer is usually unmounted
 * already; this path covers the grace window right after submit.
 */
export async function interrupt(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session || session.exited) return;
  const running = await hasRunningProcess(id);
  const recentlySubmitted =
    session.lastSubmitAt > 0 && Date.now() - session.lastSubmitAt < INTERRUPT_GRACE_MS;
  if (!running && !recentlySubmitted) return;
  markTyping(session);
  // Avoid writeRaw: that always markRan, and an interrupt is not "using" a
  // blank pane the way a typed command is.
  if (running || session.ran) markRan(session);
  send(session, "\x03");
}

/**
 * Move a shell into `path`.
 *
 * A blank pane (nothing run yet) stays blank: opening a folder is not "using"
 * the terminal, so the welcome duck stays up the same way a fresh split into
 * that project would. Panes that already have history get a normal visible
 * `cd` so the user sees the switch in the grid.
 */
export function changeDirectory(id: string, path: string): void {
  const session = sessions.get(id);
  if (!session || session.exited) return;

  const command = `cd "${path}"`;

  if (session.ran) {
    submitCommand(id, command);
    return;
  }

  // Under the welcome overlay — do not markRan, or the empty state vanishes.
  send(session, `${command}\r`);
  session.cwd = path;
  notifySession(id);

  // Once the shell has drawn the new prompt, drop the echoed `cd` so the first
  // real command does not sit under a project-switch line.
  window.setTimeout(() => {
    const live = sessions.get(id);
    if (!live || live.ran || live.exited) return;
    live.term.clear();
    notifySession(id);
  }, 200);
}

/** Write raw bytes to the PTY (Ctrl+C, Ctrl+L, Ctrl+D, etc.). */
export function writeRaw(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session || session.exited) return;
  markTyping(session);
  markRan(session);
  send(session, data);
}

export function dispose(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.observer?.disconnect();
  session.frames.dispose();
  session.blocks.dispose();
  clearTyping(session);
  hideVisualCursor(session);
  inputFocusers.delete(id);
  inputPasters.delete(id);
  if (session.agent && TAURI_RUNTIME) void agentUnwatch(id);
  for (const off of session.unlisten) off();
  session.dataChannel = null;
  if (TAURI_RUNTIME) void ptyKill(id);
  session.term.dispose();
  session.host.remove();
  sessions.delete(id);
  notifySession(id);
}

export function disposeAll(): void {
  for (const id of [...sessions.keys()]) dispose(id);
}

/**
 * True when the shell for `id` still has a child process (a command running).
 * Sessions that never spawned or already exited are never busy.
 */
export async function hasRunningProcess(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.exited || !session.spawned) return false;
  try {
    return await ptyIsBusy(id);
  } catch {
    return false;
  }
}

/** True when any of the listed terminals has a command still running. */
export async function anyHasRunningProcess(ids: string[]): Promise<boolean> {
  const live = ids.filter((id) => {
    const s = sessions.get(id);
    return s && s.spawned && !s.exited;
  });
  if (live.length === 0) return false;
  try {
    return await ptyAnyBusy(live);
  } catch {
    return false;
  }
}

/** Every live session id — used when quitting the app. */
export function allSessionIds(): string[] {
  return [...sessions.keys()];
}

export function setInputMode(mode: InputMode): void {
  if (inputMode === mode) return;
  inputMode = mode;
  notifySettings();
}

export function getInputMode(): InputMode {
  return inputMode;
}

export function setFontSize(size: number): void {
  // Keep and step from the requested size; metricsFor only derives line height.
  const next = Math.min(28, Math.max(8, Math.round(size * 10) / 10));
  const changed = next !== fontSize;
  fontSize = next;
  // Always re-apply: first boot may share the module default (13.5) with the
  // saved preference, and the command editor still needs the CSS variables.
  applyMetrics();
  for (const id of sessions.keys()) refit(id);
  if (changed) notifySettings();
}

export function getFontSize(): number {
  return fontSize;
}

/**
 * Dump the active buffer as plain text (no cell colours). Used when the
 * highlighter toggle flips so scrollback can be redrawn with the new setting.
 */
function dumpBufferPlain(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";
  // `\r\n` matches how most shells write the grid, so re-wrapping lands close
  // to the original layout.
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Re-paint scrollback for the current highlight setting.
 *
 * Colours that were already in the cells (program SGR *or* a previous pass of
 * our highlighter) are flattened to plain text first — there is no public API
 * to strip only our palette. That is the cost of a live toggle; new output is
 * exact either way.
 */
function recolorSession(session: Session): void {
  const { term } = session;
  // Leave full-screen / TUI buffers alone — rewriting them as plain lines
  // destroys the alt-screen layout the program is mid-drawing.
  if (term.buffer.active.type !== "normal") return;
  if (term.modes.mouseTrackingMode !== "none") return;

  const plain = dumpBufferPlain(term);
  const wasFocused = session.cursorFocused;

  // Markers sit on buffer lines that are about to vanish; drop the blocks so
  // we do not keep decorations pointing at disposed rows.
  session.blocks.clear();

  // Soft clear of screen + scrollback, then home. Avoid `reset()` so custom
  // key handlers and parser registrations stay put.
  term.write("\x1b[2J\x1b[3J\x1b[H");
  session.highlighter = createHighlighter();
  session.cursorVisible = true;

  if (!plain) {
    term.write("\x1b[?25l", () => scheduleVisualCursor(session, true));
    return;
  }

  // Always run the highlighter so its escape-sequence state tracks the stream;
  // only the painted form is optional (same rule as live `draw`).
  const painted = session.highlighter(plain, highlightEnabled);
  const output = highlightEnabled ? painted : plain;
  term.write(`\x1b[?25l${output}`, () => {
    session.cursorFocused = wasFocused;
    scheduleVisualCursor(session, true);
  });
}

/**
 * Turn the colouriser for uncoloured output on or off, and re-paint existing
 * scrollback so the setting is visible immediately — same live feel as the
 * command-editor toggle.
 */
export function setHighlight(enabled: boolean): void {
  if (highlightEnabled === enabled) return;
  highlightEnabled = enabled;
  for (const session of sessions.values()) recolorSession(session);
  notifySettings();
}

export function getHighlight(): boolean {
  return highlightEnabled;
}

export function clear(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.blocks.clear();
  session.term.clear();
  // `Terminal.clear` keeps the current prompt line and drops everything above
  // it — exactly the state a pane opens in, so the empty state belongs back.
  if (session.ran && !session.exited) {
    session.ran = false;
    notifySession(id);
  }
}

export function selection(id: string): string {
  const session = sessions.get(id);
  if (!session) return "";
  // Prefer a clean block copy (command + output, no PS path chrome) when the
  // user clicked a command block rather than dragging a free-range selection.
  if (session.blocks.hasBlockSelection()) {
    const blockText = session.blocks.copyText();
    if (blockText !== null) return blockText;
  }
  return session.term.getSelection();
}

/** Keyboard block nav: true when a block is currently selected in this pane. */
export function hasBlockNavSelection(id: string): boolean {
  return sessions.get(id)?.blocks.hasNavSelection() ?? false;
}

export function clearBlockSelection(id: string): void {
  sessions.get(id)?.blocks.clearSelection();
}

/** Drop chunk selection in every terminal (pane/tab focus moved away). */
export function clearAllBlockSelections(): void {
  for (const session of sessions.values()) {
    session.blocks.clearSelection();
  }
}

/** Drop chunk selection in every terminal except `exceptId`. */
export function clearOtherBlockSelections(exceptId: string): void {
  for (const [id, session] of sessions) {
    if (id === exceptId) continue;
    session.blocks.clearSelection();
  }
}

/** Ctrl+Up — select the most recent block (and scroll it into view). */
export function selectLastBlock(id: string): boolean {
  return sessions.get(id)?.blocks.navigate("selectLast") ?? false;
}

/** Up while a block is selected — move to an older block. */
export function selectPrevBlock(id: string): boolean {
  return sessions.get(id)?.blocks.navigate("prev") ?? false;
}

/** Down while a block is selected — move to a newer block. */
export function selectNextBlock(id: string): boolean {
  return sessions.get(id)?.blocks.navigate("next") ?? false;
}

export function paste(id: string, text: string): void {
  const session = sessions.get(id);
  if (!session) return;
  // Prefer the command editor when it is owning input (Warp-style).
  if (session.editorMode && !session.exited) {
    const pasteToInput = inputPasters.get(id);
    if (pasteToInput) {
      pasteToInput(text);
      const focusInput = inputFocusers.get(id);
      focusInput?.();
      return;
    }
  }
  markRan(session);
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
