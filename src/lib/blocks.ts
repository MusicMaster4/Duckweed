import type { IMarker, Terminal } from "@xterm/xterm";

import { nextBlockSelection, type BlockNavAction } from "./blockNav";
import { highlightCommand } from "./commandSyntax";

/**
 * Warp-style command blocks for the editor flow.
 *
 * Each command submitted from the composer becomes a block: the shell still
 * echoes `PS path> cmd` into the grid, but we cover that row with an opaque
 * label showing only the command, draw a hairline above every block after the
 * first, and let a click select the whole chunk.
 *
 * The command label stays up even while a child process is running (so the raw
 * `PS path> cmd` echo never bleeds through). Prompt-cover and selection chrome
 * are editor-only — they paint free-floating rows and flicker on TUI footers.
 *
 * Overlays are plain DOM (not xterm decorations) so they resize with the pane
 * the same way the visual cursor does.
 */

export interface CommandBlock {
  id: number;
  command: string;
  /**
   * Marker on the first physical row of the logical prompt + command line.
   * xterm disposes markers placed on wrapped continuation rows during reflow.
   */
  start: IMarker;
  /** Lazily mounted cover for the prompt+echo row. */
  cmdEl: HTMLDivElement | null;
  /** Lazily mounted full-width hairline above the block. */
  sepEl: HTMLDivElement | null;
  /** Lazily mounted state wash and failure rail spanning the visible block. */
  stateEl: HTMLDivElement | null;
  /** Exact lifecycle timing when supplied by OSC 133 shell integration. */
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  /** Composer block still waiting for the shell's matching OSC 133 start. */
  awaitingShellConfirmation: boolean;
}

export class BlockTracker {
  private blocks: CommandBlock[] = [];
  private nextId = 1;
  private press: { x: number; y: number; line: number } | null = null;
  private selectedId: number | null = null;
  private hoveredId: number | null = null;
  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseLeave: () => void;
  private readonly onScroll: () => void;
  /** Covers the idle shell prompt under the last block (editor mode). */
  private readonly promptCover: HTMLDivElement;
  /**
   * Soft highlight over the selected block's visible output rows. Avoids
   * `selectLines` for the full chunk (which jumps the viewport and freezes
   * scroll on tall cargo/build output).
   */
  private readonly selectOverlay: HTMLDivElement;
  /** Selection tint kept below command headers and the optical separator. */
  private readonly selectFill: HTMLDivElement;
  /** Quiet outline that makes the atomic block under the pointer legible. */
  private readonly hoverOverlay: HTMLDivElement;
  /**
   * Blocks whose command chrome was visible during the previous layout.
   * Keeping this small set lets scrolling hide stale overlays without walking
   * and mutating every DOM node in a long terminal history on every PTY write.
   */
  private visibleBlocks = new Set<CommandBlock>();
  private layoutRaf: number | null = null;
  private readonly scrollDisposable: { dispose: () => void };
  private active = false;
  /**
   * Editor mode owns the full block chrome (prompt cover + selection). When a
   * child/TUI is running we still keep the command labels so the shell's
   * `PS path> cmd` echo stays covered — but never the prompt cover, which
   * paints over TUI footers and causes flicker.
   */
  private editorMode = true;
  /** True while we programmatically touch xterm selection (suppresses races). */
  private applyingSelection = false;

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLElement,
    /**
     * Fired when a block becomes selected (click or keyboard). Used by the
     * session registry to drop chunk selection in every other terminal so only
     * one pane owns the selection at a time.
     */
    private readonly onSelect?: () => void,
  ) {
    this.promptCover = document.createElement("div");
    this.promptCover.className = "command-block-prompt-cover";
    this.promptCover.hidden = true;
    this.host.appendChild(this.promptCover);

    this.selectFill = document.createElement("div");
    this.selectFill.className = "command-block-select-fill";
    this.selectFill.setAttribute("role", "presentation");
    this.selectFill.hidden = true;
    this.host.appendChild(this.selectFill);

    this.selectOverlay = document.createElement("div");
    this.selectOverlay.className = "command-block-select-overlay";
    this.selectOverlay.setAttribute("role", "presentation");
    this.selectOverlay.hidden = true;
    this.host.appendChild(this.selectOverlay);

    this.hoverOverlay = document.createElement("div");
    this.hoverOverlay.className = "command-block-hover-overlay";
    this.hoverOverlay.setAttribute("role", "presentation");
    this.hoverOverlay.hidden = true;
    this.host.appendChild(this.hoverOverlay);

    this.onMouseDown = (e) => this.handleMouseDown(e);
    this.onMouseUp = (e) => this.handleMouseUp(e);
    this.onMouseMove = (e) => this.handleMouseMove(e);
    this.onMouseLeave = () => {
      this.press = null;
      this.setHovered(null);
    };
    this.onScroll = () => {
      // The row beneath a stationary pointer changes while scrolling. Hide the
      // hover affordance until the next pointer move instead of letting it
      // follow an old block through the viewport.
      this.setHovered(null);
      this.scheduleLayout();
    };

    // Bubble phase so the empty-space capture handler in terminals can refuse
    // dead rows first; we only see clicks that landed on real content.
    host.addEventListener("mousedown", this.onMouseDown);
    host.addEventListener("mouseup", this.onMouseUp);
    host.addEventListener("mousemove", this.onMouseMove);
    host.addEventListener("mouseleave", this.onMouseLeave);
    this.scrollDisposable = this.term.onScroll(this.onScroll);
  }

  /** Open a block for a submitted command at the current logical prompt line. */
  open(
    command: string,
    startedAt = Date.now(),
    source: "submission" | "shell" = "submission",
  ): void {
    // No editorMode guard: submits only ever come from the composer, and a
    // busy→idle race (the native busy poll lags a ^C) must not drop the block
    // — that left the raw `PS path> cmd` echo uncovered for good. Command
    // labels are safe either way; layout keeps them up in child mode too.
    if (this.term.buffer.active.type !== "normal") return;
    this.prune();
    // A new command replaces any prior chunk selection.
    if (this.selectedId !== null) {
      this.selectedId = null;
      this.selectFill.hidden = true;
      this.selectOverlay.hidden = true;
    }
    // Editor submissions open before the PTY write. Bash/zsh preexec emits
    // OSC 133;C after the command row is committed. Only that shell event may
    // confirm the pending block. A second composer submission with identical
    // text is a real new run and must always get its own marker and block.
    const last = this.blocks[this.blocks.length - 1];
    if (
      source === "shell" &&
      last?.awaitingShellConfirmation &&
      last.completedAt === null &&
      last.command === command
    ) {
      last.startedAt = startedAt;
      last.awaitingShellConfirmation = false;
      return;
    }
    if (last) {
      last.awaitingShellConfirmation = false;
      // PowerShell has no OSC 133 integration. Reaching another submission is
      // still a reliable boundary for the previous command, even without an
      // exit code from the shell.
      if (source === "submission" && last.completedAt === null) {
        last.completedAt = startedAt;
      }
    }
    // A PowerShell prompt can already be wrapped before the command is echoed.
    // A marker at the cursor would then sit on a continuation row, which xterm
    // deletes when the terminal grows wider. Anchor the first physical row of
    // the logical line instead. That row survives both directions of reflow.
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    const isWrapped = (line: number) => buffer.getLine(line)?.isWrapped ?? false;
    let startLine = logicalLineStart(isWrapped, cursorLine);
    // Shell hooks fire after the echoed command + newline, so the cursor sits
    // on the (still empty) first output row. Step back to the preceding
    // logical command row; leave the cursor line alone when it still holds
    // visible text (PowerShell can emit C before advancing).
    const cursorText = buffer.getLine(cursorLine)?.translateToString(true) ?? "";
    if (!cursorText.trim() && cursorLine > 0) {
      startLine = logicalLineStart(isWrapped, cursorLine - 1);
    }
    const start = this.term.registerMarker(startLine - cursorLine);
    if (!start) return;

    const block: CommandBlock = {
      id: this.nextId++,
      command,
      start,
      cmdEl: null,
      sepEl: null,
      stateEl: null,
      startedAt,
      completedAt: null,
      exitCode: null,
      awaitingShellConfirmation: source === "submission",
    };

    this.blocks.push(block);
    this.scheduleLayout();
  }

  /** Seal the newest command with the status reported by OSC 133;D. */
  complete(exitCode: number | null, completedAt = Date.now()): void {
    this.prune();
    const block = this.blocks[this.blocks.length - 1];
    if (!block || block.completedAt !== null) return;
    block.completedAt = completedAt;
    block.exitCode = exitCode;
    block.awaitingShellConfirmation = false;
    this.scheduleLayout();
  }

  selectedCommand(): string | null {
    if (this.selectedId === null) return null;
    return this.blocks.find((block) => block.id === this.selectedId)?.command ?? null;
  }

  /** Drop every block (clear screen, dispose session). */
  clear(): void {
    for (const b of this.blocks) disposeBlock(b);
    this.blocks = [];
    this.visibleBlocks.clear();
    this.press = null;
    this.selectedId = null;
    this.hoveredId = null;
    this.promptCover.hidden = true;
    this.selectFill.hidden = true;
    this.selectOverlay.hidden = true;
    this.hoverOverlay.hidden = true;
    this.clearXtermSelection();
  }

  dispose(): void {
    this.clear();
    this.promptCover.remove();
    this.selectFill.remove();
    this.selectOverlay.remove();
    this.hoverOverlay.remove();
    this.scrollDisposable.dispose();
    if (this.layoutRaf !== null) {
      cancelAnimationFrame(this.layoutRaf);
      this.layoutRaf = null;
    }
    this.host.removeEventListener("mousedown", this.onMouseDown);
    this.host.removeEventListener("mouseup", this.onMouseUp);
    this.host.removeEventListener("mousemove", this.onMouseMove);
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
      this.hideChrome();
      return;
    }

    // Alternate screen (vim, less, full-screen TUI): the program owns every
    // cell. Shell command labels from the normal buffer must not float on top.
    if (this.term.buffer.active.type !== "normal") {
      this.hideChrome();
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

    // Command labels always cover `PS path> cmd`, even while a child is
    // running — otherwise the raw echo bleeds through the moment we drop the
    // editor chrome (Codex, cargo, long builds). Hairlines and selection/
    // prompt covers are editor-only: a TUI on the normal buffer rewrites the
    // same absolute lines, and a free-floating hairline would strike through
    // mid-output that is no longer a chunk boundary.
    const buf = this.term.buffer.active;
    const visibleBlocks = new Set<CommandBlock>();
    const firstCandidate = this.firstLayoutCandidate(viewportY);
    for (let i = firstCandidate; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      const range = this.rangeAt(i);
      if (!range) {
        this.releaseBlockChrome(block);
        continue;
      }
      const isPastViewport = range.start >= viewportY + rows;

      // Fold orphan idle prompts directly above the echo row into this block's
      // header — but never walk into the previous chunk. Empty Enter / ^C leave
      // `PS path>` rows that belong to no chunk; anything still owned by the
      // previous block stays there so the hairline cannot land mid-output.
      const prevEnd = i > 0 ? (this.rangeAt(i - 1)?.end ?? -1) : -1;
      const coverStart = foldOrphanPrompts(
        (y) => {
          const line = buf.getLine(y);
          return line ? line.translateToString(true) : "";
        },
        range.start,
        prevEnd + 1,
        (y) => buf.getLine(y)?.isWrapped ?? false,
      );

      const commandEnd = Math.min(
        range.end,
        logicalLineEnd(
          (line) => buf.getLine(line)?.isWrapped ?? false,
          range.start,
          buf.length - 1,
        ),
      );
      const coverRow = coverStart - viewportY;
      const commandEndRow = commandEnd - viewportY;
      // Cover every physical row in a wrapped command echo. Keeping the div at
      // its real buffer position also clips a partially visible header cleanly
      // when its first row has just scrolled above the viewport.
      // Warp keeps a compact command header visible while the output of a tall
      // block scrolls underneath it. Do the same once the real command row is
      // above the viewport, but only while this block still owns visible rows.
      const sticky = commandEndRow < 0 && range.end >= viewportY;
      const headerOnScreen = sticky || (commandEndRow >= 0 && coverRow < rows);
      if (headerOnScreen) {
        visibleBlocks.add(block);
        const { cmdEl, sepEl } = this.ensureBlockChrome(block, i > 0);
        const rowsBeforeCommand = range.start - coverStart;
        const headerRows = commandEnd - coverStart + 1;
        const y = sticky ? offsetY : offsetY + coverRow * cellHeight;
        const failed = hasFailed(block);
        const hovered = this.editorMode && block.id === this.hoveredId;
        cmdEl.hidden = false;
        cmdEl.classList.toggle("is-selected", this.editorMode && block.id === this.selectedId);
        cmdEl.classList.toggle("is-hovered", hovered && block.id !== this.selectedId);
        cmdEl.classList.toggle("is-sticky", sticky);
        cmdEl.classList.toggle("is-running", block.completedAt === null);
        cmdEl.classList.toggle("is-failed", failed);
        cmdEl.classList.toggle("is-complete", block.completedAt !== null && !failed);
        const statusEl = cmdEl.querySelector<HTMLElement>(".command-block-status");
        if (statusEl) {
          const duration =
            block.completedAt === null
              ? ""
              : formatBlockDuration(block.completedAt - block.startedAt);
          statusEl.textContent = failed
            ? `exit ${block.exitCode}${duration ? ` · ${duration}` : ""}`
            : block.completedAt === null
              ? "running"
              : duration;
        }
        cmdEl.style.transform = `translate3d(0, ${y}px, 0)`;
        cmdEl.style.width = `${fullWidth}px`;
        cmdEl.style.height = `${(sticky ? 1 : headerRows) * cellHeight}px`;
        cmdEl.style.padding = sticky
          ? "0 10px"
          : `${rowsBeforeCommand * cellHeight}px 10px 0 8px`;
        cmdEl.style.lineHeight = `${cellHeight}px`;

        if (failed) {
          const stateEl = this.ensureBlockState(block);
          stateEl.classList.add("is-failed");
          this.layoutRangeOverlay(
            stateEl,
            range,
            fullWidth,
            offsetY,
            cellHeight,
            viewportY,
            rows,
          );
        } else if (block.stateEl) {
          block.stateEl.remove();
          block.stateEl = null;
        }

        if (sepEl) {
          // A terminal grid has no real inter-row gap. Center a narrow opaque
          // band on the boundary to create equal breathing room on both sides.
          if (i > 0 && this.editorMode && !sticky && coverRow >= 0 && coverRow < rows) {
            sepEl.hidden = false;
            sepEl.style.transform = `translate3d(0, ${y - 3}px, 0)`;
            sepEl.style.width = `${fullWidth}px`;
            sepEl.style.height = "7px";
          } else {
            sepEl.hidden = true;
          }
        }
      } else {
        this.releaseBlockChrome(block);
      }
      if (isPastViewport) break;
    }

    for (const block of this.visibleBlocks) {
      if (visibleBlocks.has(block)) continue;
      this.releaseBlockChrome(block);
    }
    this.visibleBlocks = visibleBlocks;

    if (this.editorMode) {
      this.layoutPromptCover(fullWidth, offsetY, cellHeight, viewportY, rows);
      this.layoutSelectOverlay(fullWidth, offsetY, cellHeight, viewportY, rows);
      this.layoutHoverOverlay(fullWidth, offsetY, cellHeight, viewportY, rows);
    } else {
      this.promptCover.hidden = true;
      this.selectFill.hidden = true;
      this.selectOverlay.hidden = true;
      this.hoverOverlay.hidden = true;
    }
  }

  scheduleLayout(): void {
    // Keep scheduling while a child is running so command labels track scroll
    // and still cover the shell's `PS path> cmd` echo.
    if (!this.active) return;
    if (this.layoutRaf !== null) return;
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = null;
      this.layout();
    });
  }

  /** Suspend overlay layout while this terminal lives in the off-screen limbo. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.scheduleLayout();
    } else if (this.layoutRaf !== null) {
      cancelAnimationFrame(this.layoutRaf);
      this.layoutRaf = null;
    }
  }

  /**
   * Toggle editor-only chrome (prompt cover + block selection + hairlines).
   * Command labels that hide the shell echo stay up either way — see
   * {@link layout}.
   */
  setEditorMode(enabled: boolean): void {
    if (this.editorMode === enabled) return;
    this.editorMode = enabled;
    if (!enabled) {
      // Drop selection + hairlines immediately so a TUI never gets even one
      // frame with a rule painted through mid-output that rewrote those lines.
      this.selectedId = null;
      this.hoveredId = null;
      this.selectFill.hidden = true;
      this.selectOverlay.hidden = true;
      this.hoverOverlay.hidden = true;
      this.promptCover.hidden = true;
      for (const block of this.visibleBlocks) {
        if (block.sepEl) block.sepEl.hidden = true;
      }
    }
    this.scheduleLayout();
  }

  /**
   * Process state is deliberately not a block boundary. A command can briefly
   * look idle while a wrapper hands work to another process, and PTY output may
   * still be queued after the process monitor reports idle. The live last block
   * therefore keeps following terminal output until the next command provides
   * an unambiguous boundary.
   */
  busyChanged(busy: boolean): void {
    // The backend sees the child process before React has time to unmount the
    // composer. Drop the prompt cover on that same event so a TUI never gets
    // even one frame with shell chrome painted over its footer — but keep the
    // command label so `PS path> cmd` does not flash through.
    if (busy) {
      this.setEditorMode(false);
      return;
    }
    this.scheduleLayout();
  }

  /**
   * Absolute buffer line range of a block.
   *
   * The next command's stable logical-start marker is the exclusive boundary.
   * End markers are deliberately not used: if an output line wraps, xterm can
   * redistribute or delete the physical row carrying such a marker on resize.
   */
  range(block: CommandBlock): { start: number; end: number } | null {
    const index = this.blocks.indexOf(block);
    if (index < 0) return null;
    return this.rangeAt(index);
  }

  /**
   * Select a command block.
   *
   * Click selects in place — the viewport must not jump (tall cargo output used
   * to scroll to the block end and leave the grid feeling stuck). Keyboard nav
   * may scroll so the command row is visible.
   */
  select(block: CommandBlock, opts: { scroll?: boolean } = {}): boolean {
    const range = this.range(block);
    if (!range) return false;
    this.selectedId = block.id;
    // Drop any free-range xterm selection so the soft overlay is the only
    // highlight. Copy uses {@link copyText}, not xterm's selection text.
    this.clearXtermSelection();
    // Other terminals must not keep a chunk selected — selection is exclusive
    // to this pane (multi-chunk, if added later, stays inside one terminal).
    this.onSelect?.();
    if (opts.scroll) this.scrollBlockIntoView(range);
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

  selectById(id: number, opts: { scroll?: boolean } = {}): boolean {
    this.prune();
    const block = this.blocks.find((b) => b.id === id);
    if (!block) return false;
    return this.select(block, opts);
  }

  /**
   * Keyboard block navigation. `selectLast` is Ctrl+Up; `prev`/`next` are
   * Up/Down while a block is selected. Empty list is a no-op.
   */
  navigate(action: BlockNavAction): boolean {
    const target = nextBlockSelection(this.ids(), this.selectedId, action);
    if (target === null) return false;
    return this.selectById(target, { scroll: true });
  }

  /**
   * Bring the command row into view. Never jumps to the end of a tall block —
   * that was the main source of "I clicked and can't scroll anymore".
   */
  private scrollBlockIntoView(range: { start: number; end: number }): void {
    const viewportY = this.term.buffer.active.viewportY;
    const rows = this.term.rows;
    if (rows <= 0) return;
    if (range.start < viewportY || range.start >= viewportY + rows) {
      this.term.scrollToLine(range.start);
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
    // Skip the whole logical prompt + command echo, including every physical
    // continuation row created by a narrow terminal.
    const commandEnd = Math.min(
      range.end,
      logicalLineEnd(
        (line) => buf.getLine(line)?.isWrapped ?? false,
        range.start,
        buf.length - 1,
      ),
    );
    for (let y = commandEnd + 1; y <= range.end; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    // Drop trailing blank lines.
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }

  /**
   * True when a command block is selected for copy/nav. Independent of xterm's
   * free-range selection so tall chunks stay copyable without selecting every
   * cell (which broke scroll).
   */
  hasBlockSelection(): boolean {
    return this.selectedId !== null;
  }

  /** Drop block selection chrome only (leave any free-range xterm selection). */
  dismissNavSelection(): void {
    if (this.selectedId === null) return;
    this.selectedId = null;
    this.selectFill.hidden = true;
    this.selectOverlay.hidden = true;
    this.scheduleLayout();
  }

  clearSelection(): void {
    if (this.selectedId === null) {
      this.clearXtermSelection();
      return;
    }
    this.selectedId = null;
    this.selectFill.hidden = true;
    this.selectOverlay.hidden = true;
    this.clearXtermSelection();
    this.scheduleLayout();
  }

  private clearXtermSelection(): void {
    if (this.applyingSelection) return;
    this.applyingSelection = true;
    try {
      this.term.clearSelection();
    } finally {
      this.applyingSelection = false;
    }
  }

  private ensureBlockChrome(
    block: CommandBlock,
    withSeparator: boolean,
  ): { cmdEl: HTMLDivElement; sepEl: HTMLDivElement | null } {
    if (!block.cmdEl) {
      const cmdEl = document.createElement("div");
      cmdEl.className = "command-block-cmd";
      cmdEl.setAttribute("role", "presentation");
      const promptEl = document.createElement("span");
      promptEl.className = "command-block-prompt";
      promptEl.textContent = "›";
      const textEl = document.createElement("span");
      textEl.className = "command-block-text";
      // One-line label: multi-line buffers collapse to one visual row for now.
      const displayCommand = block.command.replace(/\s+/g, " ").trim();
      for (const token of highlightCommand(displayCommand)) {
        const tokenEl = document.createElement("span");
        tokenEl.className = `command-token token-${token.kind}`;
        tokenEl.textContent = token.text;
        textEl.appendChild(tokenEl);
      }
      const statusEl = document.createElement("span");
      statusEl.className = "command-block-status";
      cmdEl.append(promptEl, textEl, statusEl);
      cmdEl.hidden = true;
      this.host.appendChild(cmdEl);
      block.cmdEl = cmdEl;
    }
    if (withSeparator && !block.sepEl) {
      const sepEl = document.createElement("div");
      sepEl.className = "command-block-separator";
      sepEl.setAttribute("role", "presentation");
      sepEl.hidden = true;
      this.host.appendChild(sepEl);
      block.sepEl = sepEl;
    }
    return { cmdEl: block.cmdEl, sepEl: block.sepEl };
  }

  private ensureBlockState(block: CommandBlock): HTMLDivElement {
    if (block.stateEl) return block.stateEl;
    const stateEl = document.createElement("div");
    stateEl.className = "command-block-state-overlay";
    stateEl.setAttribute("role", "presentation");
    stateEl.hidden = true;
    this.host.appendChild(stateEl);
    block.stateEl = stateEl;
    return stateEl;
  }

  private releaseBlockChrome(block: CommandBlock): void {
    block.cmdEl?.remove();
    block.sepEl?.remove();
    block.stateEl?.remove();
    block.cmdEl = null;
    block.sepEl = null;
    block.stateEl = null;
  }

  private hideChrome(): void {
    for (const block of this.visibleBlocks) {
      this.releaseBlockChrome(block);
    }
    this.visibleBlocks.clear();
    this.promptCover.hidden = true;
    this.selectFill.hidden = true;
    this.selectOverlay.hidden = true;
    this.hoverOverlay.hidden = true;
  }

  /** True while we are clearing/setting xterm selection ourselves. */
  isApplyingSelection(): boolean {
    return this.applyingSelection;
  }

  /** Find the block that owns an absolute buffer line. */
  atLine(line: number): CommandBlock | null {
    this.prune();
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      const range = this.rangeAt(i);
      if (!range) continue;
      if (line >= range.start && line <= range.end) return block;
    }
    return null;
  }

  /**
   * Range lookup for a known block index.
   *
   * Layout already walks blocks in order. Avoiding `indexOf` keeps each frame
   * linear as the history grows; after pruning, the next marker is adjacent.
   */
  private rangeAt(index: number): { start: number; end: number } | null {
    const block = this.blocks[index];
    if (!block || block.start.isDisposed || block.start.line < 0) return null;
    const start = block.start.line;
    let nextStart: number | null = null;
    for (let i = index + 1; i < this.blocks.length; i++) {
      const marker = this.blocks[i].start;
      if (marker.isDisposed || marker.line < 0) continue;
      nextStart = marker.line;
      break;
    }

    let end = nextStart === null ? liveEndLine(this.term, start) : nextStart - 1;
    // Idle prompt rows between submissions belong to the next header, not the
    // previous command. Trim them after resolving the semantic boundary.
    end = trimTrailingPrompt(this.term, start, end);
    if (end < start) end = start;
    return { start, end };
  }

  /**
   * Oldest block that can still have command chrome in the viewport.
   *
   * Start markers stay ordered through xterm reflow. One predecessor is kept
   * because a wrapped command can begin above the viewport and continue into
   * its first visible row.
   */
  private firstLayoutCandidate(viewportY: number): number {
    let low = 0;
    let high = this.blocks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.blocks[mid].start.line < viewportY) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  }

  // ---------------------------------------------------------------------------

  private layoutSelectOverlay(
    fullWidth: number,
    offsetY: number,
    cellHeight: number,
    viewportY: number,
    rows: number,
  ): void {
    if (this.selectedId === null) {
      this.selectFill.hidden = true;
      this.selectOverlay.hidden = true;
      return;
    }
    const block = this.blocks.find((b) => b.id === this.selectedId);
    if (!block) {
      this.selectFill.hidden = true;
      this.selectOverlay.hidden = true;
      return;
    }
    const range = this.range(block);
    if (!range) {
      this.selectFill.hidden = true;
      this.selectOverlay.hidden = true;
      return;
    }

    this.layoutRangeOverlay(
      this.selectFill,
      range,
      fullWidth,
      offsetY,
      cellHeight,
      viewportY,
      rows,
    );
    this.layoutRangeOverlay(
      this.selectOverlay,
      range,
      fullWidth,
      offsetY,
      cellHeight,
      viewportY,
      rows,
      2,
    );
  }

  private layoutHoverOverlay(
    fullWidth: number,
    offsetY: number,
    cellHeight: number,
    viewportY: number,
    rows: number,
  ): void {
    if (this.hoveredId === null || this.hoveredId === this.selectedId) {
      this.hoverOverlay.hidden = true;
      return;
    }
    const block = this.blocks.find((candidate) => candidate.id === this.hoveredId);
    const range = block ? this.range(block) : null;
    if (!range) {
      this.hoverOverlay.hidden = true;
      return;
    }
    this.layoutRangeOverlay(
      this.hoverOverlay,
      range,
      fullWidth,
      offsetY,
      cellHeight,
      viewportY,
      rows,
      1,
    );
  }

  /** Position an overlay on only the visible slice of a semantic block. */
  private layoutRangeOverlay(
    element: HTMLDivElement,
    range: { start: number; end: number },
    fullWidth: number,
    offsetY: number,
    cellHeight: number,
    viewportY: number,
    rows: number,
    outset = 0,
  ): void {
    const startRow = range.start - viewportY;
    const endRow = range.end - viewportY;
    const visStart = Math.max(0, startRow);
    const visEnd = Math.min(rows - 1, endRow);
    if (visEnd < visStart) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    element.classList.toggle("is-clipped-top", startRow < 0);
    element.classList.toggle("is-clipped-bottom", endRow >= rows);
    const topOutset = startRow < 0 ? 0 : outset;
    const bottomOutset = endRow >= rows ? 0 : outset;
    element.style.transform = `translate3d(${-outset}px, ${
      offsetY + visStart * cellHeight - topOutset
    }px, 0)`;
    element.style.width = `${fullWidth + outset * 2}px`;
    element.style.height = `${
      (visEnd - visStart + 1) * cellHeight + topOutset + bottomOutset
    }px`;
  }

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

    const range = this.rangeAt(this.blocks.length - 1);
    if (!range) {
      this.promptCover.hidden = true;
      return;
    }

    const buf = this.term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    // Cover from the first line after the last chunk through the live cursor.
    // Also scan one line *into* the chunk end: a sealed marker that landed on
    // `PS path>` is trimmed from `range`, but the absolute buffer line is still
    // there and must be painted over when it scrolls into view.
    const from = range.end;
    const scanEnd = Math.max(cursorLine, viewportY + rows - 1);
    if (scanEnd < from) {
      this.promptCover.hidden = true;
      return;
    }

    // Cover every idle prompt / blank run after the real chunk content. Skip
    // non-prompt text still belonging to the last output line at `range.end`.
    let coverStart = -1;
    let coverEnd = -1;
    for (let y = from; y <= scanEnd; y++) {
      const line = buf.getLine(y);
      const text = line ? line.translateToString(true) : "";
      const blank = text.trim() === "";
      const prompt = looksLikePrompt(text);
      // The line at range.end is only coverable when it is itself a prompt
      // (seal off-by-one). Blank padding that is still part of the chunk stays.
      if (y === range.end && !prompt) continue;
      if (y > range.end && (blank || prompt)) {
        if (coverStart < 0) coverStart = y;
        coverEnd = y;
        continue;
      }
      if (prompt) {
        if (coverStart < 0) coverStart = y;
        coverEnd = y;
        continue;
      }
      if (coverStart >= 0 && y > range.end) break;
    }

    if (coverStart < 0 || coverEnd < 0) {
      this.promptCover.hidden = true;
      return;
    }

    const startRow = coverStart - viewportY;
    // Clip the top to the viewport, but paint through the bottom of the
    // visible area. Selecting a chunk and scrolling to its end used to reveal
    // the raw `PS path>` plus empty grid rows under it — keep that chrome
    // covered so the pane still reads as a block list, not a live shell.
    const visStart = Math.max(0, startRow);
    const visEnd = rows - 1;
    if (visEnd < visStart) {
      this.promptCover.hidden = true;
      return;
    }

    this.promptCover.hidden = false;
    this.promptCover.style.transform = `translate3d(0, ${offsetY + visStart * cellHeight}px, 0)`;
    this.promptCover.style.width = `${fullWidth}px`;
    this.promptCover.style.height = `${(visEnd - visStart + 1) * cellHeight}px`;
  }

  private prune(): void {
    this.blocks = this.blocks.filter((b) => {
      if (!b.start.isDisposed && b.start.line >= 0) return true;
      disposeBlock(b);
      this.visibleBlocks.delete(b);
      if (this.selectedId === b.id) this.selectedId = null;
      return false;
    });
  }

  private handleMouseDown(e: MouseEvent): void {
    if (!this.editorMode) return;
    if (e.button !== 0 || e.shiftKey) return;
    if (this.term.modes.mouseTrackingMode !== "none") return;
    if (this.term.buffer.active.type !== "normal") return;
    const line = bufferLineFromEvent(this.term, this.host, e);
    if (line === null) return;
    this.press = { x: e.clientX, y: e.clientY, line };
  }

  /**
   * As soon as the pointer moves enough to count as a drag, drop the block
   * chrome so free-range selection is the only highlight. Waiting for mouseup
   * left a stuck block tint while xterm was selecting underneath.
   */
  private handleMouseMove(e: MouseEvent): void {
    if (!this.editorMode || this.term.modes.mouseTrackingMode !== "none") {
      this.setHovered(null);
      return;
    }
    const press = this.press;
    if (press && this.selectedId !== null) {
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (dx * dx + dy * dy > 25) {
        this.press = null;
        this.setHovered(null);
        this.dismissNavSelection();
        return;
      }
    }
    const line = bufferLineFromEvent(this.term, this.host, e);
    this.setHovered(line === null ? null : this.atLine(line)?.id ?? null);
  }

  private setHovered(id: number | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    if (id === null) this.hoverOverlay.hidden = true;
    this.scheduleLayout();
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;
    const press = this.press;
    this.press = null;
    if (!press || !this.editorMode) return;
    if (this.term.modes.mouseTrackingMode !== "none") return;
    if (this.term.buffer.active.type !== "normal") return;
    // Leave double-click (word) and triple-click (line) to xterm.
    if (e.detail !== 1) return;

    // Drag = normal text selection. Click = select the whole block.
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (dx * dx + dy * dy > 25) {
      this.dismissNavSelection();
      return;
    }

    const block = this.atLine(press.line);
    if (!block) {
      this.clearSelection();
      return;
    }
    // Click selects the chunk in place — no viewport jump.
    this.select(block);
  }
}

function disposeBlock(block: CommandBlock): void {
  block.cmdEl?.remove();
  block.sepEl?.remove();
  block.stateEl?.remove();
  block.start.dispose();
}

/** Match Warp's failure treatment: interrupts and SIGPIPE are not errors. */
function hasFailed(block: CommandBlock): boolean {
  return (
    block.completedAt !== null &&
    block.exitCode !== null &&
    block.exitCode !== 0 &&
    block.exitCode !== 130 &&
    block.exitCode !== 141
  );
}

/** Compact timing label for block headers. */
export function formatBlockDuration(durationMs: number): string {
  const ms = Math.max(0, durationMs);
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

/**
 * First physical row of a logical terminal line.
 *
 * `isWrapped(y)` means row `y` continues the row above it. The first row is
 * the only safe place for a durable marker because xterm can delete any of the
 * continuation rows when a terminal grows wider.
 */
export function logicalLineStart(
  isWrapped: (y: number) => boolean,
  line: number,
  minLine = 0,
): number {
  const floor = Math.max(0, minLine);
  let start = Math.max(floor, line);
  while (start > floor && isWrapped(start)) start -= 1;
  return start;
}

/** Last physical row currently occupied by the logical line at `line`. */
export function logicalLineEnd(
  isWrapped: (y: number) => boolean,
  line: number,
  maxLine: number,
): number {
  let end = Math.max(0, line);
  const ceiling = Math.max(end, maxLine);
  while (end < ceiling && isWrapped(end + 1)) end += 1;
  return end;
}

/**
 * Extend a block header upward through consecutive idle prompt lines sitting
 * between chunks, stopping at `minLine` so we never steal lines from the
 * previous block (or from buffer start).
 *
 * `isWrapped` is optional for simple callers, but the tracker passes it so a
 * long PowerShell prompt is evaluated as one logical line after reflow.
 */
export function foldOrphanPrompts(
  getLine: (y: number) => string,
  commandStart: number,
  minLine: number,
  isWrapped: (y: number) => boolean = () => false,
): number {
  let coverStart = commandStart;
  const floor = Math.max(0, minLine);
  while (coverStart > floor) {
    const candidateEnd = coverStart - 1;
    const candidateStart = logicalLineStart(isWrapped, candidateEnd, floor);
    let text = "";
    for (let y = candidateStart; y <= candidateEnd; y++) text += getLine(y);
    if (!looksLikePrompt(text)) break;
    coverStart = candidateStart;
  }
  return coverStart;
}

/**
 * Resolve a block's end without trusting a reflow-sensitive end marker.
 *
 * End markers attached to wrapped continuations can stay before newly
 * inserted rows when a pane narrows, or be disposed when a pane widens. A
 * following block start is therefore the authoritative sealed boundary.
 */
export function resolveBlockEnd(
  start: number,
  nextStart: number | null,
  markerEnd: number | null,
  liveEnd: () => number,
): number {
  if (nextStart !== null && nextStart > start) return nextStart - 1;
  if (markerEnd !== null && markerEnd >= start) return markerEnd;
  return Math.max(start, liveEnd());
}

/**
 * Last row occupied by the command's logical line after xterm reflow.
 *
 * `isWrapped(y)` describes whether row `y` continues the row above it. The
 * upper bound prevents malformed buffer state from consuming command output.
 */
export function wrappedCommandEnd(
  isWrapped: (y: number) => boolean,
  commandStart: number,
  blockEnd: number,
): number {
  let end = commandStart;
  while (end < blockEnd && isWrapped(end + 1)) end += 1;
  return end;
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
  return trimTrailingPrompt(term, start, end);
}

/**
 * Walk `end` back while the line is an idle shell prompt so chunks never own
 * the `PS path>` chrome that sits under the composer.
 */
function trimTrailingPrompt(term: Terminal, start: number, end: number): number {
  let e = end;
  if (e < start) return start;
  const buf = term.buffer.active;
  while (e > start) {
    const promptStart = logicalLineStart(
      (line) => buf.getLine(line)?.isWrapped ?? false,
      e,
      start + 1,
    );
    let text = "";
    for (let y = promptStart; y <= e; y++) {
      text += buf.getLine(y)?.translateToString(true) ?? "";
    }
    if (!looksLikePrompt(text)) break;
    e = promptStart - 1;
  }
  return e;
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
export function looksLikePrompt(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  // PowerShell idle prompt, optionally prefixed by an environment name, and
  // its Ctrl+C echo. Requiring the prompt glyph to be at the end prevents
  // `PS path> command` from being mistaken for shell chrome.
  if (
    /^(?:(?:\([^)]*\)|\[[^\]]*\])\s*)*PS(?:\s+[^>\r\n]*)?>\s*(?:\^C\s*)?$/i.test(t) &&
    t.length < 200
  ) {
    return true;
  }
  // bash/zsh-ish: user@host:path$  or path % (optional space before the glyph).
  // Keep the prefix tight so log lines ending in `>` are not swallowed.
  if (/^[\w.@~\/\\:-]+(\s*)[$#%]\s*$/.test(t) && t.length < 120) return true;
  if (/^[\w.@~\/\\:-]+>+\s*$/.test(t) && t.length < 120) return true;
  return false;
}
