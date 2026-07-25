import { describe, expect, test } from "bun:test";

import {
  createFrameBuffer,
  stabilizeCursorDuringFrame,
} from "../src/lib/frames.ts";

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
    expect(stabilized.every((write) => write.text.endsWith(SHOW))).toBe(true);
    frames.dispose();
  });

  test("hides cursor for every partial paint and restores it at the true close", () => {
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
    expect(last.text.endsWith(SHOW)).toBe(true);
    expect(last.text.slice(0, -SHOW.length).includes(SHOW)).toBe(false);
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
    expect(result.text.endsWith(HIDE)).toBe(true);
    expect(result.text.match(/\x1b\[\?25h/g)).toBeNull();
  });

  test("tracks ordinary cursor state without rewriting ordinary output", () => {
    const text = `plain${HIDE}text`;
    const result = stabilizeCursorDuringFrame(text, true, false, true);
    expect(result).toEqual({ text, cursorVisible: false });
  });
});
