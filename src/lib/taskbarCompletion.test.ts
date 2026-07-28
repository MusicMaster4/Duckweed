import { describe, expect, test } from "bun:test";

import { createCompletionBadgeRgba } from "./taskbarCompletion";

describe("taskbar completion marker", () => {
  test("draws a transparent 16px overlay with a dark outline around the completion colour", () => {
    const rgba = createCompletionBadgeRgba();
    const pixels = Array.from({ length: rgba.length / 4 }, (_, index) =>
      rgba.slice(index * 4, index * 4 + 4),
    );

    expect(rgba).toHaveLength(16 * 16 * 4);
    // Transparent corners, so the badge reads as a dot rather than a square.
    expect(pixels.some((pixel) => pixel[3] === 0)).toBe(true);
    expect(
      pixels.some(
        (pixel) =>
          pixel[0] === 242 && pixel[1] === 104 && pixel[2] === 111 && pixel[3] === 255,
      ),
    ).toBe(true);
    // The outline keeps the dot visible against a light taskbar.
    expect(
      pixels.some(
        (pixel) => pixel[0] === 15 && pixel[1] === 18 && pixel[2] === 15 && pixel[3] === 255,
      ),
    ).toBe(true);
  });
});
