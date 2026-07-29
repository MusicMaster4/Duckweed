import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AsciiAmbient } from "./AsciiAmbient";
import { ASCII_SCENES } from "./agent/ascii/animations";

describe("ambient ASCII decoration", () => {
  test("every named scene paints a full, non-empty grid", () => {
    for (const [id, create] of Object.entries(ASCII_SCENES)) {
      const paint = create();
      const frame = paint(0.5);
      const rows = frame.split("\n");
      expect(rows.length, id).toBeGreaterThan(4);
      expect(rows[0]!.length, id).toBeGreaterThan(12);
      expect(frame.trim().length, id).toBeGreaterThan(0);
    }
  });

  test("renders a pre grid for a named scene", () => {
    const html = renderToStaticMarkup(
      <AsciiAmbient surfaceId="test-ports" scene="sonar" />,
    );
    expect(html).toContain("ascii-ambient");
    expect(html).toContain("<pre>");
    expect(html).toContain('aria-hidden="true"');
  });

  test("keeps one clock per surface across remounts", () => {
    const realNow = performance.now;
    let clock = 1000;
    performance.now = () => clock;

    try {
      const mounted = renderToStaticMarkup(
        <AsciiAmbient surfaceId="surface-a" scene="radar" />,
      );
      const sameInstant = renderToStaticMarkup(
        <AsciiAmbient surfaceId="surface-a" scene="radar" />,
      );
      expect(sameInstant).toBe(mounted);

      clock = 5200;
      const later = renderToStaticMarkup(
        <AsciiAmbient surfaceId="surface-a" scene="radar" />,
      );
      expect(later).not.toBe(mounted);
    } finally {
      performance.now = realNow;
    }
  });

  test("switching scenes on the same surface starts a new clock", () => {
    const realNow = performance.now;
    let clock = 2000;
    performance.now = () => clock;

    try {
      const radar = renderToStaticMarkup(
        <AsciiAmbient surfaceId="power-phase" scene="radar" />,
      );
      clock = 8000;
      const clockScene = renderToStaticMarkup(
        <AsciiAmbient surfaceId="power-phase" scene="clock" />,
      );
      expect(clockScene).not.toBe(radar);
    } finally {
      performance.now = realNow;
    }
  });
});
