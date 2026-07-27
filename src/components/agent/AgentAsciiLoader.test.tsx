import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentAsciiLoader } from "./AgentAsciiLoader";
import { ASCII_ANIMATIONS } from "./ascii/animations";

describe("agent startup animation", () => {
  test("every animation paints a full, non-empty grid", () => {
    for (const create of ASCII_ANIMATIONS) {
      const paint = create();
      const rows = paint(0.4).split("\n");
      const width = rows[0].length;
      expect(rows.length).toBeGreaterThan(4);
      expect(width).toBeGreaterThan(12);
      for (const row of rows) expect(row.length).toBe(width);
      expect(paint(0.4).trim().length).toBeGreaterThan(0);
    }
  });

  test("every animation actually moves", () => {
    for (const create of ASCII_ANIMATIONS) {
      const paint = create();
      expect(paint(0.4)).not.toBe(paint(1.1));
    }
  });

  test("offers a pool to choose from rather than one animation per provider", () => {
    expect(ASCII_ANIMATIONS.length).toBeGreaterThanOrEqual(40);
  });

  /**
   * Two panes can land on the same animation. The simulations advance a
   * generation at a time, so a shared instance would be dragged backwards and
   * forwards by their differing clocks and reseed on every frame.
   */
  test("independent instances do not disturb each other's clocks", () => {
    for (const create of ASCII_ANIMATIONS) {
      const alone = create();
      const solo = [alone(1), alone(2), alone(3)];

      const first = create();
      const second = create();
      const interleaved: string[] = [];
      for (const t of [1, 2, 3]) {
        second(t + 9.5);
        interleaved.push(first(t));
      }

      expect(interleaved).toEqual(solo);
    }
  });

  test("shows progress affordances only while a handshake is pending", () => {
    const starting = renderToStaticMarkup(
      <AgentAsciiLoader agent="claude" termId="pane-progress" />,
    );
    expect(starting).toContain('role="status"');
    expect(starting).toContain("agent-ascii-bar");
    expect(starting).toContain("Starting session");

    const ambient = renderToStaticMarkup(
      <AgentAsciiLoader agent="claude" termId="pane-ambient" progress={false} />,
    );
    expect(ambient).toContain("is-ambient");
    expect(ambient).not.toContain("agent-ascii-bar");
    expect(ambient).not.toContain("Starting session");
  });

  /**
   * Splitting or closing a pane re-parents the terminal subtree, which remounts
   * this component. The same terminal has to come back with the same animation,
   * still running on the same clock, or the remount is visible as a jump.
   */
  test("keeps one animation and one clock per terminal across remounts", () => {
    const realNow = performance.now;
    const realRandom = Math.random;
    let clock = 1000;
    performance.now = () => clock;
    /* Fix the draw so the assertions below are about persistence, not luck. */
    Math.random = () => 0;

    try {
      const mounted = renderToStaticMarkup(<AgentAsciiLoader agent="grok" termId="pane-7" />);

      const sameInstant = renderToStaticMarkup(<AgentAsciiLoader agent="grok" termId="pane-7" />);
      expect(sameInstant).toBe(mounted);

      /* A reset origin would render t=0 again; a persisted one has moved on. */
      clock = 4700;
      const later = renderToStaticMarkup(<AgentAsciiLoader agent="grok" termId="pane-7" />);
      expect(later).not.toBe(mounted);
    } finally {
      performance.now = realNow;
      Math.random = realRandom;
    }
  });
});
