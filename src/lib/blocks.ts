import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

/**
 * Warp-style command blocks for the editor flow.
 *
 * When a command is submitted from the composer we know its boundaries: open a
 * block at the cursor line, seal the previous one, draw a hairline separator,
 * and let a click select the whole command+output chunk.
 *
 * Full OSC 133 shell integration would cover raw-mode typing too; this tracks
 * the path the app already owns (submitCommand).
 */

export interface CommandBlock {
  id: number;
  command: string;
  start: IMarker;
  /** Set when the next command starts (or the tracker is disposed). */
  end: IMarker | null;
  separator: IDecoration | null;
}

type BusyFn = () => Promise<boolean>;

export class BlockTracker {
  private blocks: CommandBlock[] = [];
  private nextId = 1;
  private press: { x: number; y: number; line: number } | null = null;
  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onMouseLeave: () => void;
  private sealWatch: number | null = null;
  private wasBusy = false;
  /** Bumped on every open/clear so a delayed idle-seal cannot close a newer block. */
  private sealEpoch = 0;

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLElement,
    private readonly isBusy: BusyFn,
  ) {
    this.onMouseDown = (e) => this.handleMouseDown(e);
    this.onMouseUp = (e) => this.handleMouseUp(e);
    this.onMouseLeave = () => {
      this.press = null;
    };
    // Bubble phase so the empty-space capture handler in terminals can refuse
    // dead rows first; we only see clicks that landed on real content.
    host.addEventListener("mousedown", this.onMouseDown);
    host.addEventListener("mouseup", this.onMouseUp);
    host.addEventListener("mouseleave", this.onMouseLeave);
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

    const block: CommandBlock = {
      id: this.nextId++,
      command,
      start,
      end: null,
      separator: null,
    };

    // Hairline above every block after the first — the visual break Warp uses
    // between command chunks.
    if (this.blocks.length > 0) {
      block.separator = this.attachSeparator(start);
    }

    this.blocks.push(block);
    this.armSealWatch();
  }

  /** Drop every block (clear screen, dispose session). */
  clear(): void {
    this.sealEpoch += 1;
    this.disarmSealWatch();
    for (const b of this.blocks) disposeBlock(b);
    this.blocks = [];
    this.press = null;
  }

  dispose(): void {
    this.clear();
    this.host.removeEventListener("mousedown", this.onMouseDown);
    this.host.removeEventListener("mouseup", this.onMouseUp);
    this.host.removeEventListener("mouseleave", this.onMouseLeave);
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
    this.term.selectLines(range.start, range.end);
    return true;
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

  private sealOpen(cursorYOffset: number): void {
    this.disarmSealWatch();
    const open = this.blocks[this.blocks.length - 1];
    if (!open || open.end) return;
    if (open.start.isDisposed || open.start.line < 0) return;

    // Cursor sits on the new prompt; the previous block ends one row above it.
    // When sealing because the process went idle, the same offset applies once
    // the shell has redrawn the prompt.
    const end = this.term.registerMarker(cursorYOffset);
    if (!end || end.isDisposed || end.line < 0) return;
    // Never end before we started (empty/fast commands, or prompt still on the
    // same row).
    if (end.line < open.start.line) {
      end.dispose();
      open.end = this.term.registerMarker(0);
      return;
    }
    open.end = end;
  }

  private attachSeparator(marker: IMarker): IDecoration | null {
    const decoration = this.term.registerDecoration({
      marker,
      anchor: "left",
      x: 0,
      // Full row so the hairline spans the grid; height 1 keeps it on the
      // command's first line without covering output.
      width: Math.max(1, this.term.cols),
      height: 1,
      layer: "top",
    });
    if (!decoration) return null;

    decoration.onRender((el) => {
      el.className = "command-block-separator";
      // xterm sizes the element to the cell range; pin a 1px rule to its top edge.
      // Prefer the live screen width so a resize still spans the full grid.
      const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
      if (screen) el.style.width = `${screen.clientWidth}px`;
      el.style.pointerEvents = "none";
      el.style.background = "transparent";
      el.style.border = "none";
      el.style.borderTop = "1px solid var(--block-separator, rgba(255, 255, 255, 0.12))";
      el.style.boxSizing = "border-box";
      el.style.margin = "0";
      el.style.padding = "0";
    });

    return decoration;
  }

  /**
   * Watch for a child process to start and finish. Builtins that never fork
   * stay open until the next `open()` seals them — safer than a quiet timeout
   * that would cut long output short when busy detection misses.
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
          // Let the shell finish drawing its next prompt, then end one row above
          // so the fresh prompt is not part of this chunk.
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
    if (dx * dx + dy * dy > 25) return;

    const block = this.atLine(press.line);
    if (!block) return;
    this.select(block);
  }
}

function disposeBlock(block: CommandBlock): void {
  block.separator?.dispose();
  block.end?.dispose();
  block.start.dispose();
}

/**
 * Last absolute buffer line that still holds non-whitespace, not before
 * `start`. Used while a block is still open.
 */
function liveEndLine(term: Terminal, start: number): number {
  const buf = term.buffer.active;
  const bottom = buf.baseY + buf.cursorY;
  for (let y = bottom; y >= start; y--) {
    const line = buf.getLine(y);
    if (line && /\S/.test(line.translateToString(true))) return y;
  }
  return start;
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
