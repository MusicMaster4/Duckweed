/**
 * Frame assembly for PTY output.
 *
 * A PTY hands over whatever bytes happen to have arrived, and those boundaries
 * have nothing to do with where a program's output is meaningful. That is fine
 * for a shell printing lines, and wrong for anything that redraws: a full-screen
 * program repaints by walking the cursor over the region it is changing, so a
 * redraw that reaches the terminal in pieces gets painted in pieces — with the
 * cursor sitting wherever the redraw had got to. That is the cursor darting
 * between the status line and the composer in Codex on every keystroke, and the
 * same flicker in any other TUI that updates while you watch it.
 *
 * Programs already mark where a redraw begins and ends: DEC private mode 2026,
 * "synchronized output". `CSI ? 2026 h` means hold the picture still, `CSI ?
 * 2026 l` means the frame is complete. xterm.js has no support for it and drops
 * both on the floor, so this module implements it — everything between the two
 * markers is collected and handed to xterm together.
 *
 * A single `Terminal.write` is still not necessarily a single paint: xterm
 * yields after its parser has worked for 12 ms so the renderer can catch up.
 * `stabilizeCursorDuringFrame` therefore tracks the program's requested cursor
 * visibility but keeps xterm's renderer hidden. The app paints the logical
 * cursor separately after the parsed buffer has settled.
 *
 * The markers are left in the stream rather than stripped: xterm ignores private
 * modes it does not know, and passing the bytes through untouched keeps what the
 * terminal sees byte-identical to what the program sent.
 */

const ESC = "\x1b";

/** DEC private mode number for synchronized output. */
export const SYNC_MODE = 2026;

/** `CSI ? <params> h` / `CSI ? <params> l` — DEC private mode set and reset. */
const PRIVATE_MODE_SOURCE = String.raw`\x1b\[\?([0-9;]*)([hl])`;

function privateModes(): RegExp {
  // A fresh expression matters here: delivering a frame can synchronously run
  // cursor stabilization, and sharing one global `lastIndex` would make the
  // outer frame scan skip its next marker.
  return new RegExp(PRIVATE_MODE_SOURCE, "g");
}

export interface FrameWrite {
  text: string;
  /** The bytes belong to a DEC 2026 synchronized-output frame. */
  synchronized: boolean;
  /** The matching `CSI ? 2026 l` was received; false means a safety flush. */
  complete: boolean;
}

export interface StabilizedWrite {
  text: string;
  /** Logical visibility requested by the program after processing this text. */
  cursorVisible: boolean;
}

/**
 * Keep xterm's native cursor hidden while tracking the program's logical state.
 *
 * Cursor visibility changes are removed even outside synchronized frames.
 * Codex sometimes completes a valid frame with the cursor on its status row and
 * sends the composer position in a second update ~24 ms later. Letting xterm
 * paint either position would expose that transient jump. Other private modes
 * sharing the same CSI command are preserved.
 */
export function stabilizeCursorDuringFrame(
  text: string,
  cursorVisible: boolean,
  _synchronized: boolean,
  _complete: boolean,
): StabilizedWrite {
  let nextVisible = cursorVisible;
  const withoutCursorChanges = text.replace(privateModes(), (sequence, rawParams: string, action: string) => {
    const params = rawParams.split(";").filter(Boolean);
    if (!params.includes("25")) return sequence;

    nextVisible = action === "h";
    const remaining = params.filter((param) => param !== "25");
    return remaining.length ? `${ESC}[?${remaining.join(";")}${action}` : "";
  });

  return {
    // Reasserting mode 25 on every write also repairs native cursor state if a
    // renderer reset or a future xterm change happens to restore it.
    text: `${ESC}[?25l${withoutCursorChanges}`,
    cursorVisible: nextVisible,
  };
}

/**
 * How long a frame may stay open before it is drawn anyway. A program that
 * begins a frame and then dies — or is stopped at a breakpoint — must not be
 * able to freeze the pane it was running in.
 */
const FRAME_TIMEOUT_MS = 150;

/** Ceiling on a single held frame, so a stray `CSI ? 2026 h` cannot eat memory. */
const MAX_FRAME = 4 * 1024 * 1024;

/**
 * Longest incomplete tail worth holding on to. Real sequences are short; a
 * payload longer than this is not a marker we are waiting to complete, so it
 * goes straight through rather than being held for a continuation.
 */
const MAX_CARRY = 4096;

/**
 * Where an incomplete escape sequence starts in `text`, or -1 if it ends clean.
 *
 * A read can land anywhere, including between the `[` and the `h` of a frame
 * marker — and a marker split in two is a marker that goes unrecognised, which
 * is one torn frame every time it happens.
 */
export function incompleteTailStart(text: string): number {
  const start = text.lastIndexOf(ESC);
  if (start < 0) return -1;
  const tail = text.slice(start);
  if (tail.length < 2) return start;

  const kind = tail[1];
  // CSI — parameters and intermediates, then a final byte in @…~.
  if (kind === "[") return /^\x1b\[[0-?]*[ -/]*[@-~]/.test(tail) ? -1 : start;
  // String sequences (OSC/DCS/APC/PM/SOS) run until BEL or ST.
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    return tail.includes("\x07") || tail.includes(`${ESC}\\`) ? -1 : start;
  }
  // Everything else is a complete two-byte sequence.
  return -1;
}

export interface FrameBuffer {
  /** Feed one decoded PTY chunk. Whole frames are written out; partial ones wait. */
  push(chunk: string): void;
  /** True while a frame is open — what DECRQM has to report for mode 2026. */
  isFraming(): boolean;
  /** Draw a held frame right now, for when nothing more is coming. */
  flush(): void;
  /** Drop any pending timer; the held frame dies with the session. */
  dispose(): void;
}

/**
 * Collect PTY text into frames and hand each one to `write` in a single call.
 * Output from a program that never uses mode 2026 passes straight through, so
 * this is only ever as slow as the stream it is reassembling.
 */
export function createFrameBuffer(write: (chunk: FrameWrite) => void): FrameBuffer {
  /** An escape sequence cut in half by a read boundary, waiting for its tail. */
  let carry = "";
  /** The frame being assembled, if one is open. */
  let frame = "";
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function disarm(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  /** Draw whatever has been held so far, whether or not the frame ever closed. */
  function flush(): void {
    disarm();
    if (!frame) return;
    const text = frame;
    frame = "";
    write({ text, synchronized: true, complete: false });
  }

  function push(chunk: string): void {
    let text = carry + chunk;
    carry = "";

    const cut = incompleteTailStart(text);
    if (cut >= 0 && text.length - cut <= MAX_CARRY) {
      carry = text.slice(cut);
      text = text.slice(0, cut);
    }
    if (!text) return;

    // Everything outside a frame accumulates in `out`, while synchronized bytes
    // stay in `frame`. They are emitted separately so the renderer knows exactly
    // which writes need cursor stabilization.
    let out = "";
    let at = 0;

    function emitOutside(): void {
      if (!out) return;
      write({ text: out, synchronized: false, complete: true });
      out = "";
    }

    const modes = privateModes();
    for (let m = modes.exec(text); m; m = modes.exec(text)) {
      // `CSI ? 1049 ; 2026 h` is legal: the mode can ride along with others.
      if (!m[1].split(";").includes(String(SYNC_MODE))) continue;

      const lead = text.slice(at, m.index);
      at = m.index + m[0].length;
      if (open) frame += lead;
      else out += lead;

      if (m[2] === "h") {
        // The marker travels with the frame it opens rather than going out on
        // its own, so a chunk that only starts a frame costs no write at all —
        // and a write that renders nothing is still a repaint.
        //
        // Already inside a frame? Then this marker is redundant, not a nested
        // frame — mode 2026 has no depth, so the outer frame simply continues.
        if (!open) emitOutside();
        open = true;
        frame += m[0];
      } else {
        if (open) {
          frame += m[0];
          write({ text: frame, synchronized: true, complete: true });
          frame = "";
          open = false;
        } else {
          // A reset without a matching set is ordinary terminal output. Keep it
          // byte-for-byte so mode state can still be repaired by the program.
          out += m[0];
        }
      }
    }

    const rest = text.slice(at);
    if (open) frame += rest;
    else out += rest;

    // A frame this big is not a frame. Let it through and keep collecting: the
    // program gets one torn redraw instead of a pane that stops updating.
    if (frame.length > MAX_FRAME) {
      write({ text: frame, synchronized: true, complete: false });
      frame = "";
    }

    emitOutside();
    if (frame) {
      if (timer === undefined) timer = setTimeout(flush, FRAME_TIMEOUT_MS);
    } else {
      disarm();
    }
  }

  return {
    push,
    isFraming: () => open,
    flush,
    dispose: disarm,
  };
}
