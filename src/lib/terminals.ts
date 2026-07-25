import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "./ipc";
import { terminalTheme } from "./theme";

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
  /** Bytes typed before the PTY was ready. */
  pending: string[];
}

const sessions = new Map<string, Session>();
const listeners = new Set<() => void>();

let fontSize = 13.5;
const FONT_FAMILY =
  '"CaskaydiaCove Nerd Font", "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace';

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

function create(id: string, opts: { cwd?: string | null; shell?: string | null }): Session {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: FONT_FAMILY,
    fontSize,
    lineHeight: 1.28,
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
    pending: [],
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
    if (session.spawned) void ptyWrite(id, data);
    else session.pending.push(data);
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

  // Subscribe before spawning so no output can slip through.
  const offData = await listen<string>(`pty:data:${id}`, (event) => {
    session.term.write(decodeBase64(event.payload));
  });
  const offExit = await listen<{ code: number | null }>(`pty:exit:${id}`, (event) => {
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
    const result = await ptySpawn({
      id,
      cwd: opts.cwd ?? null,
      shell: opts.shell ?? null,
      cols: session.term.cols,
      rows: session.term.rows,
    });
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
}

/** Park the terminal off-screen; its scrollback and process stay alive. */
export function detach(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.observer?.disconnect();
  session.observer = null;
  session.container = null;
  limbo().appendChild(session.host);
}

export function refit(id: string): void {
  const session = sessions.get(id);
  if (!session || !session.container) return;
  const { clientWidth, clientHeight } = session.container;
  if (clientWidth < 20 || clientHeight < 20) return;
  try {
    session.fit.fit();
  } catch {
    // Fit can throw while the pane is mid-animation; the observer retries.
  }
}

/** Re-measure every mounted terminal — used after window resize/fullscreen. */
export function refitAll(): void {
  for (const id of sessions.keys()) refit(id);
}

export function focus(id: string): void {
  sessions.get(id)?.term.focus();
}

export function dispose(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.observer?.disconnect();
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
  fontSize = Math.min(28, Math.max(8, size));
  for (const session of sessions.values()) {
    session.term.options.fontSize = fontSize;
    refit(session.id);
  }
  notify();
}

export function getFontSize(): number {
  return fontSize;
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
  matchBackground: "#4a3d8f",
  matchBorder: "#7c6cff",
  matchOverviewRuler: "#7c6cff",
  activeMatchBackground: "#7c6cff",
  activeMatchBorder: "#c8bfff",
  activeMatchColorOverviewRuler: "#c8bfff",
};
