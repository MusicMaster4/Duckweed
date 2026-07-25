import { describe, expect, test } from "bun:test";

import {
  createFrameBuffer,
  stabilizeCursorDuringFrame,
} from "../src/lib/frames.ts";
import {
  CURSOR_SETTLE_MS,
  createCursorSettler,
  cursorMoveNeedsSettling,
} from "../src/lib/cursor.ts";

const ESC = "\x1b";
const OPEN = `${ESC}[?2026h`;
const CLOSE = `${ESC}[?2026l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;

describe("synchronized terminal frames", () => {
  test("reassembles a marker and frame split across PTY events", () => {
    const writes = [];
    const frames = createFrameBuffer((write) => writes.push(write));

    frames.push(`before${ESC}[?20`);
    frames.push("26hmove");
    frames.push(`${SHOW}${CLOSE}after`);

    expect(writes).toEqual([
      { text: "before", synchronized: false, complete: true },
      { text: `${OPEN}move${SHOW}${CLOSE}`, synchronized: true, complete: true },
      { text: "after", synchronized: false, complete: true },
    ]);
    frames.dispose();
  });

  test("keeps a safety-flushed frame logically open", () => {
    const writes = [];
    const frames = createFrameBuffer((write) => writes.push(write));

    frames.push(`${OPEN}first`);
    frames.flush();
    frames.push(`second${CLOSE}`);

    expect(writes).toEqual([
      { text: `${OPEN}first`, synchronized: true, complete: false },
      { text: `second${CLOSE}`, synchronized: true, complete: true },
    ]);
    frames.dispose();
  });

  test("preserves every byte when each input byte is a separate PTY event", () => {
    const source = `before${OPEN}move${HIDE}paint${SHOW}${CLOSE}after`;
    const writes = [];
    const frames = createFrameBuffer((write) => writes.push(write));

    for (const byte of source) frames.push(byte);

    expect(writes.map((write) => write.text).join("")).toBe(source);
    expect(writes.filter((write) => write.synchronized)).toHaveLength(1);
    expect(writes.find((write) => write.synchronized)?.complete).toBe(true);
    frames.dispose();
  });

  test("does not lose a later frame when delivery synchronously processes the first", () => {
    const stabilized = [];
    let visible = true;
    const frames = createFrameBuffer((write) => {
      const result = stabilizeCursorDuringFrame(
        write.text,
        visible,
        write.synchronized,
        write.complete,
      );
      visible = result.cursorVisible;
      stabilized.push({ ...write, text: result.text });
    });

    frames.push(`${OPEN}one${SHOW}${CLOSE}${OPEN}two${SHOW}${CLOSE}`);

    expect(stabilized).toHaveLength(2);
    expect(stabilized.every((write) => write.synchronized && write.complete)).toBe(true);
    expect(stabilized.every((write) => write.text.startsWith(HIDE))).toBe(true);
    expect(stabilized.every((write) => !write.text.includes(SHOW))).toBe(true);
    frames.dispose();
  });

  test("keeps the native cursor hidden for partial and completed paints", () => {
    const first = stabilizeCursorDuringFrame(
      `${OPEN}cursor-move${SHOW}`,
      true,
      true,
      false,
    );
    expect(first.cursorVisible).toBe(true);
    expect(first.text.startsWith(HIDE)).toBe(true);
    expect(first.text.includes(SHOW)).toBe(false);

    const last = stabilizeCursorDuringFrame(
      `more-movement${CLOSE}`,
      first.cursorVisible,
      true,
      true,
    );
    expect(last.text.startsWith(HIDE)).toBe(true);
    expect(last.text.includes(SHOW)).toBe(false);
    expect(last.cursorVisible).toBe(true);
  });

  test("preserves a hidden final cursor and other combined private modes", () => {
    const result = stabilizeCursorDuringFrame(
      `${OPEN}${ESC}[?25;1004hbody${ESC}[?25l${CLOSE}`,
      true,
      true,
      true,
    );

    expect(result.cursorVisible).toBe(false);
    expect(result.text).toContain(`${ESC}[?1004h`);
    expect(result.text.startsWith(HIDE)).toBe(true);
    expect(result.text.match(/\x1b\[\?25h/g)).toBeNull();
  });

  test("tracks ordinary cursor state while suppressing the native cursor", () => {
    const text = `plain${HIDE}text`;
    const result = stabilizeCursorDuringFrame(text, true, false, true);
    expect(result).toEqual({ text: `${HIDE}plaintext`, cursorVisible: false });
  });
});

describe("visual cursor stabilization", () => {
  test("holds Codex's transient jump from composer to status", () => {
    // Real capture: composer row 22, transient Working row 19, correction
    // arrives 23.6 ms later. The settle window must cover that correction.
    expect(
      cursorMoveNeedsSettling(
        { row: 21, column: 2 },
        { row: 18, column: 13 },
      ),
    ).toBe(true);
    expect(CURSOR_SETTLE_MS).toBeGreaterThan(23.6);
  });

  test("keeps typing immediate and settles vertical or large horizontal jumps", () => {
    const stable = { row: 21, column: 8 };
    expect(cursorMoveNeedsSettling(stable, { row: 21, column: 9 })).toBe(false);
    expect(cursorMoveNeedsSettling(stable, { row: 21, column: 6 })).toBe(false);
    expect(cursorMoveNeedsSettling(stable, { row: 23, column: 8 })).toBe(true);
    expect(cursorMoveNeedsSettling(stable, { row: 21, column: 37 })).toBe(true);
  });

  test("settles the first cursor snapshot instead of flashing startup positions", () => {
    expect(cursorMoveNeedsSettling(null, { row: 10, column: 2 })).toBe(true);
  });

  test("real Codex status-to-composer sequence never paints the status row", () => {
    let pending = null;
    const painted = [];
    const settler = createCursorSettler(
      (callback) => {
        pending = callback;
        return 1;
      },
      () => {
        pending = null;
      },
    );

    // Establish the composer at zero-based row 21.
    settler.schedule({ row: 21, column: 2 }, () => painted.push("21:2"), true);
    pending();
    pending = null;

    // Captured frame ends at Working row 18. Its cursor-only correction lands
    // 15.3 ms later at composer row 21, before the 32 ms settle timer.
    settler.schedule({ row: 18, column: 13 }, () => painted.push("18:13"));
    expect(painted).toEqual(["21:2"]);
    settler.schedule({ row: 21, column: 2 }, () => painted.push("21:2"));

    expect(pending).toBeNull();
    expect(painted).toEqual(["21:2", "21:2"]);
    settler.cancel();
  });

  test("real Codex footer-to-composer sequence never paints the footer row", () => {
    let pending = null;
    const painted = [];
    const settler = createCursorSettler(
      (callback) => {
        pending = callback;
        return 1;
      },
      () => {
        pending = null;
      },
    );

    // Establish the composer at zero-based row 14.
    settler.schedule({ row: 14, column: 12 }, () => painted.push("14:12"), true);
    pending();
    pending = null;

    // Captured backspace repaint ended on footer row 16, then corrected to the
    // composer about 15 ms later. The footer position must remain provisional.
    settler.schedule({ row: 16, column: 59 }, () => painted.push("16:59"));
    expect(painted).toEqual(["14:12"]);
    settler.schedule({ row: 14, column: 11 }, () => painted.push("14:11"));

    expect(pending).toBeNull();
    expect(painted).toEqual(["14:12", "14:11"]);
    settler.cancel();
  });

  test("real same-row path jump is replaced before paint", () => {
    let pending = null;
    const painted = [];
    const settler = createCursorSettler(
      (callback) => {
        pending = callback;
        return 1;
      },
      () => {
        pending = null;
      },
    );

    settler.schedule({ row: 14, column: 3 }, () => painted.push("14:3"), true);
    pending();
    pending = null;

    // The final captured backspace jumped to column 37 on the composer's row,
    // then returned to column 3 after 17.7 ms.
    settler.schedule({ row: 14, column: 37 }, () => painted.push("14:37"));
    expect(painted).toEqual(["14:3"]);
    settler.schedule({ row: 14, column: 3 }, () => painted.push("14:3"));

    expect(pending).toBeNull();
    expect(painted).toEqual(["14:3", "14:3"]);
    settler.cancel();
  });
});
