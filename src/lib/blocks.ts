import type { IMarker, Terminal } from "@xterm/xterm";

import { nextBlockSelection, type BlockNavAction } from "./blockNav";

/**
 * Warp-style command blocks for the editor flow.
 *
 * Each command submitted from the composer becomes a block: the shell still
 * echoes `PS path> cmd` into the grid, but we cover that row with an opaque
 * label showing only the command, draw a hairline above every block after the
 * first, and let a click select the whole chunk.
 *
 * Overlays are plain DOM (not xterm decorations) so they stay visible under the
 * WebGL renderer and resize with the pane the same way the visual cursor does.
 */

/** Vertical breathing room above each block after the first (px). */
const BLOCK_GAP = 12;

export interface CommandBlock {
  id: number;
  command: string;
  start: IMarker;
  /** Set when the next command starts or the process goes idle. */
  end: IMarker | null;
  /** Covers the prompt+echo row; shows only the command text. */
  cmdEl: HTMLDivElement;
  /** Full-width hairline + gap above the block (null for the first). */
  sepEl: HTMLDivElement | null;
}

type BusyFn = () => Promise<boolean>;

export class BlockTracker {
  private blocks: CommandBlock[] = [];
  private nextId = 1;
  private press: { x: number; y: number; line: number } | null = null;
  private selectedId: number | null = null;
  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onMouseLeave: () => void;
  private readonly onScroll: () => void;
  private sealWatch: number | null = null;
  private wasBusy = false;
  /** Bumped on every open/clear so a delayed idle-seal cannot close a newer block. */
  private sealEpoch = 0;
  /** Covers the idle shell prompt under the last block (editor mode). */
  private readonly promptCover: HTMLDivElement;
  private layoutRaf: number | null = null;
  private readonly scrollDisposable: { dispose: () => void };

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLElement,
    private readonly isBusy: BusyFn,
  ) {
    this.promptCover = document.createElement("div");
    this.promptCover.className = "command-block-prompt-cover";
    this.promptCover.hidden = true;
    this.host.appendChild(this.promptCover);

    this.onMouseDown = (e) => this.handleMouseDown(e);
    this.onMouseUp = (e) => this.handleMouseUp(e);
    this.onMouseLeave = () => {
      this.press = null;
    };
    this.onScroll = () => this.scheduleLayout();

    // Bubble phase so the empty-space capture handler in terminals can refuse
    // dead rows first; we only see clicks that landed on real content.
    host.addEventListener("mousedown", this.onMouseDown);
    host.addEventListener("mouseup", this.onMouseUp);
    host.addEventListener("mouseleave", this.onMouseLeave);
    this.scrollDisposable = this.term.onScroll(this.onScroll);
  }

  /**
   * Open a block for a submitted command. Seals the previous open block so its
   * end sits on the last line of that command's output.
   */
  open(command: string): void {
    if (this.term.buffer.active.type !== "normal") return;
    this.prune();
    this.sealEpoch += 1;
    this.sealOpen(-1);

    const start = this.term.registerMarker(0);
    if (!start) return;

    const cmdEl = document.createElement("div");
    cmdEl.className = "command-block-cmd";
    cmdEl.setAttribute("role", "presentation");
    // One-line label: multi-line buffers collapse to a single visual row for now.
    cmdEl.textContent = command.replace(/\s+/g, " ").trim();
    cmdEl.hidden = true;
    this.host.appendChild(cmdEl);

    let sepEl: HTMLDivElement | null = null;
    if (this.blocks.length > 0) {
      sepEl = document.createElement("div");
      sepEl.className = "command-block-separator";
      sepEl.setAttribute("role", "presentation");
      sepEl.hidden = true;
      this.host.appendChild(sepEl);
    }

    const block: CommandBlock = {
      id: this.nextId++,
      command,
      start,
      end: null,
      cmdEl,
      sepEl,
    };

    this.blocks.push(block);
    this.armSealWatch();
    this.scheduleLayout();
  }

  /** Drop every block (clear screen, dispose session). */
  clear(): void {
    this.sealEpoch += 1;
    this.disarmSealWatch();
    for (const b of this.blocks) disposeBlock(b);
    this.blocks = [];
    this.press = null;
    this.selectedId = null;
    this.promptCover.hidden = true;
    this.term.clearSelection();
  }

  dispose(): void {
    this.clear();
    this.promptCover.remove();
    this.scrollDisposable.dispose();
    if (this.layoutRaf !== null) {
      cancelAnimationFrame(this.layoutRaf);
      this.layoutRaf = null;
    }
    this.host.removeEventListener("mousedown", this.onMouseDown);
    this.host.removeEventListener("mouseup", this.onMouseUp);
    this.host.removeEventListener("mouseleave", this.onMouseLeave);
  }

  /** Reposition overlays after scroll, write, or resize. */
  layout(): void {
    if (this.layoutRaf !== null) {
      cancelAnimationFrame(this.layoutRaf);
      this.layoutRaf = null;
    }
    this.prune();

    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || screen.clientWidth <= 0 || screen.clientHeight <= 0) {
      for (const b of this.blocks) {
        b.cmdEl.hidden = true;
        if (b.sepEl) b.sepEl.hidden = true;
      }
      this.promptCover.hidden = true;
      return;
    }

    if (this.term.buffer.active.type !== "normal") {
      for (const b of this.blocks) {
        b.cmdEl.hidden = true;
        if (b.sepEl) b.sepEl.hidden = true;
      }
      this.promptCover.hidden = true;
      return;
    }

    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / this.term.rows;
    // Full host width so the hairline runs edge-to-edge (no gutter from the
    // xterm screen inset). Vertical position still tracks the screen grid.
    const offsetY = screenRect.top - hostRect.top;
    const fullWidth = hostRect.width;
    const viewportY = this.term.buffer.active.viewportY;
    const rows = this.term.rows;

    for (const block of this.blocks) {
      const range = this.range(block);
      if (!range) {
        block.cmdEl.hidden = true;
        if (block.sepEl) block.sepEl.hidden = true;
        continue;
      }

      const cmdRow = range.start - viewportY;
      // Command label stays visible if any of its cell is on-screen; the gap
      // strip may extend slightly above the viewport top.
      const cmdVisible = cmdRow >= -1 && cmdRow < rows;
      if (cmdVisible) {
        const y = offsetY + cmdRow * cellHeight;
        block.cmdEl.hidden = false;
        block.cmdEl.classList.toggle("is-selected", block.id === this.selectedId);
        block.cmdEl.style.transform = `translate3d(0, ${y}px, 0)`;
        block.cmdEl.style.width = `${fullWidth}px`;
        block.cmdEl.style.height = `${cellHeight}px`;
        block.cmdEl.style.lineHeight = `${cellHeight}px`;

        if (block.sepEl) {
          // Opaque gap + hairline above the command row, full width.
          block.sepEl.hidden = false;
          block.sepEl.style.transform = `translate3d(0, ${y - BLOCK_GAP}px, 0)`;
          block.sepEl.style.width = `${fullWidth}px`;
          block.sepEl.style.height = `${BLOCK_GAP}px`;
        }
      } else {
        block.cmdEl.hidden = true;
        if (block.sepEl) block.sepEl.hidden = true;
      }
    }

    this.layoutPromptCover(fullWidth, offsetY, cellHeight, viewportY, rows);
  }

  scheduleLayout(): void {
    if (this.layoutRaf !== null) return;
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = null;
      this.layout();
    });
  }

  /** Absolute buffer line range of a block, or null if the markers are gone. */
  range(block: CommandBlock): { start: number; end: number } | null {
    if (block.start.isDisposed || block.start.line < 0) return null;
    const start = block.start.line;
    let end: number;
    if (block.end && !block.end.isDisposed && block.end.line >= 0) {
      end = block.end.line;
    } else {
      end = liveEndLine(this.term, start);
    }
    if (end < start) end = start;
    return { start, end };
  }

  select(block: CommandBlock): boolean {
    const range = this.range(block);
    if (!range) return false;
    this.selectedId = block.id;
    // Select output rows in xterm (command row is covered by our label).
    // start..end still selects the underlying cells for multi-line copy via
    // xterm; {@link copyText} rebuilds a clean payload when a block is selected.
    this.term.selectLines(range.start, range.end);
    this.scrollBlockIntoView(range);
    this.scheduleLayout();
    return true;
  }

  /** Block ids oldest → newest (prunes disposed markers first). */
  ids(): number[] {
    this.prune();
    return this.blocks.map((b) => b.id);
  }

  selectedBlockId(): number | null {
    return this.selectedId;
  }

  /** True when a block is keyboard/click selected (may outlive xterm selection). */
  hasNavSelection(): boolean {
    return this.selectedId !== null;
  }

  selectById(id: number): boolean {
    this.prune();
    const block = this.blocks.find((b) => b.id === id);
    if (!block) return false;
    return this.select(block);
  }

  /**
   * Keyboard block navigation. `selectLast` is Ctrl+Up; `prev`/`next` are
   * Up/Down while a block is selected. Empty list is a no-op.
   */
  navigate(action: BlockNavAction): boolean {
    const target = nextBlockSelection(this.ids(), this.selectedId, action);
    if (target === null) return false;
    return this.selectById(target);
  }

  /** Scroll so the block's start line is visible (prefer top of viewport). */
  private scrollBlockIntoView(range: { start: number; end: number }): void {
    const viewportY = this.term.buffer.active.viewportY;
    const rows = this.term.rows;
    if (rows <= 0) return;
    if (range.start < viewportY) {
      this.term.scrollToLine(range.start);
      return;
    }
    if (range.end >= viewportY + rows) {
      // Keep the end visible with a little headroom for the command row.
      const top = Math.max(0, range.end - rows + 1);
      this.term.scrollToLine(top);
    }
  }

  /**
   * Plain-text copy for the selected block: just the command + output, no
   * `PS path>` chrome. Returns null when no block is selected.
   */
  copyText(): string | null {
    if (this.selectedId === null) return null;
    const block = this.blocks.find((b) => b.id === this.selectedId);
    if (!block) return null;
    const range = this.range(block);
    if (!range) return null;

    const lines: string[] = [block.command];
    const buf = this.term.buffer.active;
    // Skip the first row (prompt + echoed command) — we already have `command`.
    for (let y = range.start + 1; y <= range.end; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    // Drop trailing blank lines.
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }

  /** True when the current xterm selection matches our selected block. */
  hasBlockSelection(): boolean {
    return this.selectedId !== null && this.term.hasSelection();
  }

  clearSelection(): void {
    if (this.selectedId === null) return;
    this.selectedId = null;
    this.term.clearSelection();
    this.scheduleLayout();
  }

  /** Find the block that owns an absolute buffer line. */
  atLine(line: number): CommandBlock | null {
    this.prune();
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      const range = this.range(block);
      if (!range) continue;
      if (line >= range.start && line <= range.end) return block;
    }
    return null;
  }

  // ---------------------------------------------------------------------------

  private layoutPromptCover(
    fullWidth: number,
    offsetY: number,
    cellHeight: number,
    viewportY: number,
    rows: number,
  ): void {
    // Hide the idle shell prompt under the composer so the grid reads as a
    // list of blocks, not a conventional PS session. Works for open blocks
    // too (builtins never flip isBusy, so they may never get an end marker).
    if (this.blocks.length === 0) {
      this.promptCover.hidden = true;
      return;
    }

    const last = this.blocks[this.blocks.length - 1];
    const range = this.range(last);
    if (!range) {
      this.promptCover.hidden = true;
      return;
    }

    const buf = this.term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    // Everything after the block's content up to (and including) the cursor
    // line is fair game to cover when it looks like an idle prompt.
    const from = range.end + 1;
    if (cursorLine < from) {
      this.promptCover.hidden = true;
      return;
    }

    // Find the first coverable prompt/empty line at or after `from`.
    let coverStart = -1;
    let coverEnd = -1;
    for (let y = from; y <= cursorLine; y++) {
      const line = buf.getLine(y);
      const text = line ? line.translateToString(true) : "";
      if (text.trim() === "" || looksLikePrompt(text)) {
        if (coverStart < 0) coverStart = y;
        coverEnd = y;
      } else if (coverStart >= 0) {
        break;
      }
    }

    if (coverStart < 0 || coverEnd < 0) {
      this.promptCover.hidden = true;
      return;
    }

    const startRow = coverStart - viewportY;
    const endRow = coverEnd - viewportY;
    // Clip to the visible viewport.
    const visStart = Math.max(0, startRow);
    const visEnd = Math.min(rows - 1, endRow);
    if (visEnd < visStart) {
      this.promptCover.hidden = true;
      return;
    }

    this.promptCover.hidden = false;
    this.promptCover.style.transform = `translate3d(0, ${offsetY + visStart * cellHeight}px, 0)`;
    this.promptCover.style.width = `${fullWidth}px`;
    this.promptCover.style.height = `${(visEnd - visStart + 1) * cellHeight}px`;
  }

  private sealOpen(cursorYOffset: number): void {
    this.disarmSealWatch();
    const open = this.blocks[this.blocks.length - 1];
    if (!open || open.end) return;
    if (open.start.isDisposed || open.start.line < 0) return;

    // Cursor sits on the new prompt; the previous block ends one row above it.
    const end = this.term.registerMarker(cursorYOffset);
    if (!end || end.isDisposed || end.line < 0) return;
    if (end.line < open.start.line) {
      end.dispose();
      open.end = this.term.registerMarker(0);
      this.scheduleLayout();
      return;
    }
    open.end = end;
    this.scheduleLayout();
  }

  /**
   * Watch for a child process to start and finish. Builtins that never fork
   * stay open until the next `open()` seals them.
   */
  private armSealWatch(): void {
    this.disarmSealWatch();
    this.wasBusy = false;
    const epoch = this.sealEpoch;

    this.sealWatch = window.setInterval(() => {
      void this.isBusy().then((busy) => {
        if (epoch !== this.sealEpoch) return;
        if (busy) {
          this.wasBusy = true;
          return;
        }
        if (this.wasBusy) {
          this.disarmSealWatch();
          window.setTimeout(() => {
            if (epoch !== this.sealEpoch) return;
            this.sealOpen(-1);
          }, 100);
        }
      });
    }, 250);
  }

  private disarmSealWatch(): void {
    if (this.sealWatch !== null) {
      window.clearInterval(this.sealWatch);
      this.sealWatch = null;
    }
    this.wasBusy = false;
  }

  private prune(): void {
    this.blocks = this.blocks.filter((b) => {
      if (!b.start.isDisposed && b.start.line >= 0) return true;
      disposeBlock(b);
      if (this.selectedId === b.id) this.selectedId = null;
      return false;
    });
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || e.shiftKey) return;
    if (this.term.modes.mouseTrackingMode !== "none") return;
    if (this.term.buffer.active.type !== "normal") return;
    const line = bufferLineFromEvent(this.term, this.host, e);
    if (line === null) return;
    this.press = { x: e.clientX, y: e.clientY, line };
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (this.term.modes.mouseTrackingMode !== "none") return;
    if (this.term.buffer.active.type !== "normal") return;
    // Leave double-click (word) and triple-click (line) to xterm.
    if (e.detail !== 1) return;

    // Drag = normal text selection. Click = select the whole block.
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (dx * dx + dy * dy > 25) {
      this.clearSelection();
      return;
    }

    const block = this.atLine(press.line);
    if (!block) {
      this.clearSelection();
      return;
    }
    this.select(block);
  }
}

function disposeBlock(block: CommandBlock): void {
  block.cmdEl.remove();
  block.sepEl?.remove();
  block.end?.dispose();
  block.start.dispose();
}

/**
 * Last absolute buffer line of an open block. Skips a trailing idle prompt so
 * the next `PS path>` is not part of the previous command's chunk.
 */
function liveEndLine(term: Terminal, start: number): number {
  const buf = term.buffer.active;
  const bottom = buf.baseY + buf.cursorY;
  let end = start;
  for (let y = bottom; y >= start; y--) {
    const line = buf.getLine(y);
    if (line && /\S/.test(line.translateToString(true))) {
      end = y;
      break;
    }
  }
  if (end > start) {
    const line = buf.getLine(end);
    const text = line ? line.translateToString(true) : "";
    if (looksLikePrompt(text)) return end - 1;
  }
  return end;
}

function bufferLineFromEvent(
  term: Terminal,
  host: HTMLElement,
  event: MouseEvent,
): number | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.height <= 0) return null;
  const row = Math.floor(((event.clientY - rect.top) / rect.height) * term.rows);
  if (row < 0 || row >= term.rows) return null;
  return term.buffer.active.viewportY + row;
}

/** Heuristic for an idle PowerShell / bash / zsh prompt line. */
function looksLikePrompt(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return true;
  // PowerShell interrupt echo: `PS H:\path> ^C` (still chrome, not output).
  if (/\^C\s*$/i.test(t) && t.length < 200) return true;
  // PowerShell: `PS H:\path>` (and variants with brackets, extra spaces).
  if (/^PS\b/i.test(t) && t.includes(">") && t.length < 200) return true;
  // bash/zsh-ish: user@host:path$  or path %
  if (/[$#%>]\s*$/.test(t) && t.length < 120) return true;
  return false;
}
