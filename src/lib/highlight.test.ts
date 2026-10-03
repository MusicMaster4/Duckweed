import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";

import { createFrameBuffer } from "./frames";
import { createHighlighter } from "./highlight";
import { highlightColors } from "./theme";

const ESC = "\x1b";
const plain = "Error: missing C:\\demo\\config.json\r\ncount: 42";
const paint = (hex: string, text: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${ESC}[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${text}${ESC}[39m`;
};
const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, "");

describe("terminal output syntax highlighting", () => {
  test("highlights plain output without changing text or line endings", () => {
    const output = createHighlighter()(plain);
    expect(stripSgr(output)).toBe(plain);
    expect(output).toContain(paint(highlightColors.error, "Error"));
    expect(output).toContain(paint(highlightColors.path, "C:\\demo\\config.json"));
    expect(output).toContain(paint(highlightColors.number, "42"));
  });

  test("handles Windows PowerShell ConPTY output with reset and native colour in the same read", async () => {
    // Captured from portable-pty / ConPTY with Write-Output and Write-Host.
    const highlighter = createHighlighter();
    highlighter(`${ESC}[93mWrite-Output ${ESC}[36m'count: 42'\r\n`);
    const error = highlighter(`${ESC}[mError: missing C:\\demo\\config.json`);
    const rest = highlighter(`\r\ncount: 42${ESC}[38;5;9m\r\nNative red${ESC}[m\r\nPS C:\\Users\\jubar> `);
    expect(error).toContain(paint(highlightColors.error, "Error"));
    expect(rest).toContain(paint(highlightColors.number, "42"));
    expect(rest).toContain(`${ESC}[38;5;9m\r\nNative red${ESC}[m`);

    const term = new Terminal({ cols: 100, rows: 10 });
    await new Promise<void>((resolve) => term.write(error + rest, resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("Error: missing C:\\demo\\config.json");
    expect(term.buffer.active.getLine(1)?.getCell(7)?.getFgColor()).toBe(Number.parseInt(highlightColors.number.slice(1), 16));
    expect(term.buffer.active.getLine(2)?.getCell(0)?.getFgColor()).toBe(9);
    term.dispose();
  });

  test("keeps cursor commands, title payloads and OSC 133 markers intact", () => {
    const prefix = `${ESC}[?25l${ESC}[3;1H${ESC}[K${ESC}]0;Error 42\x07${ESC}]133;D;0\x07`;
    const output = createHighlighter()(prefix + plain);
    expect(output.startsWith(prefix)).toBe(true);
    expect(output).toContain(paint(highlightColors.error, "Error"));
    expect(stripSgr(output)).toBe(prefix + plain);
  });

  test("resumes after selective SGR resets without overriding native attributes", () => {
    for (const [open, close] of [
      ["31", "39"], ["1;31", "22;39"], ["48;2;0;0;0", "49"],
      ["38;5;0", "39"], ["38;2;0;0;0", "39"], ["38:2::0:0:0", "39"],
      ["4:3", "24"], ["1;3;4;7", "22;23;24;27"],
    ]) {
      const highlighter = createHighlighter();
      expect(highlighter(`${ESC}[${open}mError 42`)).toBe(`${ESC}[${open}mError 42`);
      expect(highlighter("Error 42")).toBe("Error 42");
      expect(highlighter(`${ESC}[${close}mError 42`)).toContain(paint(highlightColors.error, "Error"));
    }
    const highlighter = createHighlighter();
    highlighter(`${ESC}[1;31m`);
    expect(highlighter(`${ESC}[39mError 42`)).toBe(`${ESC}[39mError 42`);
    expect(highlighter(`${ESC}[22mError 42`)).toContain(paint(highlightColors.error, "Error"));
  });

  test("leaves native ANSI and truecolour spans unchanged", () => {
    const source = `${ESC}[31mError 42${ESC}[39m ${ESC}[38;2;44;55;66mWarning 12${ESC}[0m`;
    expect(createHighlighter()(source)).toBe(source);
  });

  test("tracks combined screen/mouse modes in stream order", () => {
    for (const mode of [47, 1047, 1049, 1000, 1002, 1003, 2026]) {
      const highlighter = createHighlighter();
      const frame = `${ESC}[?25;${mode}hError 42${ESC}[?${mode};25l`;
      expect(highlighter(frame)).toBe(frame);
      expect(highlighter(plain)).toContain(paint(highlightColors.error, "Error"));
      highlighter(`${ESC}[?${mode}h`);
      expect(highlighter(plain)).toBe(plain);
      highlighter(`${ESC}[?${mode}l`);
      expect(highlighter(plain)).toContain(paint(highlightColors.error, "Error"));
    }
    const highlighter = createHighlighter();
    highlighter(`${ESC}[?1000;1002h`);
    highlighter(`${ESC}[?1000l`);
    expect(highlighter(plain)).toBe(plain);
    highlighter(`${ESC}[?1002l`);
    expect(highlighter(plain)).not.toBe(plain);
  });

  test("does not inject colours into progress bars or PSReadLine redraws", () => {
    for (const source of ["progress 42%\rprogress 43%", `${ESC}[m\x08Write-Output 'Error 42'`]) {
      expect(createHighlighter()(source)).toBe(source);
    }
  });

  test("tracks styles and modes while highlighting is disabled", () => {
    const highlighter = createHighlighter();
    expect(highlighter(`${ESC}[31mError 42`, false)).toBe(`${ESC}[31mError 42`);
    expect(highlighter(plain)).toBe(plain);
    expect(highlighter(`${ESC}[39m` + plain, false)).toBe(`${ESC}[39m` + plain);
    expect(highlighter(plain)).not.toBe(plain);
    highlighter(`${ESC}[?1049h`, false);
    expect(highlighter(plain)).toBe(plain);
    highlighter(`${ESC}[?1049l`, false);
    expect(highlighter(plain)).not.toBe(plain);
  });

  test("never paints inside split CSI or OSC sequences", () => {
    for (const sequence of [`${ESC}[38;2;0;0;0m`, `${ESC}]0;Error 42\x07`, `${ESC}]8;;https://example.com/42${ESC}\\`]) {
      const highlighter = createHighlighter();
      let output = "";
      for (const byte of sequence) output += highlighter(byte);
      expect(output).toBe(sequence);
      const next = highlighter("Error 42");
      expect(next).toBe(sequence.endsWith("m") ? "Error 42" : paint(highlightColors.error, "Error") + " " + paint(highlightColors.number, "42"));
    }
  });

  test("passes long string payloads through, including a terminator split across reads", () => {
    const highlighter = createHighlighter();
    expect(highlighter(`${ESC}]0;` + "Error 42".repeat(10000))).toBe(`${ESC}]0;` + "Error 42".repeat(10000));
    expect(highlighter("Warning 12".repeat(10000) + ESC)).toBe("Warning 12".repeat(10000) + ESC);
    expect(highlighter("\\Error 42")).toBe("\\" + paint(highlightColors.error, "Error") + " " + paint(highlightColors.number, "42"));
  });

  test("a terminal reset clears previous screen and colour state", () => {
    const highlighter = createHighlighter();
    highlighter(`${ESC}[?1049;1000h${ESC}[31m`);
    expect(highlighter(`${ESC}c`)).toBe(`${ESC}c`);
    expect(highlighter(plain)).toContain(paint(highlightColors.error, "Error"));
  });

  test("works after frame reassembly while synchronized TUIs remain unchanged", () => {
    const highlighter = createHighlighter();
    const writes: string[] = [];
    const frames = createFrameBuffer((chunk) => writes.push(highlighter(chunk.text)));
    frames.push(`${ESC}[`);
    frames.push("m" + plain);
    expect(writes.join("")).toContain(paint(highlightColors.error, "Error"));
    writes.length = 0;
    frames.push(`${ESC}[?2026hError `);
    frames.push(`42${ESC}[?2026l`);
    expect(writes.join("")).toBe(`${ESC}[?2026hError 42${ESC}[?2026l`);
    frames.dispose();
  });
});
