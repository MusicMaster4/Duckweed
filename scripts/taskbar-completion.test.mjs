import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCompletionBadgeRgba } from "../src/lib/taskbarCompletion.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("taskbar completion marker", () => {
  test("draws a transparent 16px overlay with a dark outline around the completion colour", () => {
    const rgba = createCompletionBadgeRgba();
    const pixels = Array.from({ length: rgba.length / 4 }, (_, index) =>
      rgba.slice(index * 4, index * 4 + 4),
    );

    expect(rgba).toHaveLength(16 * 16 * 4);
    expect(pixels.some((pixel) => pixel[3] === 0)).toBe(true);
    expect(
      pixels.some(
        (pixel) =>
          pixel[0] === 242 &&
          pixel[1] === 104 &&
          pixel[2] === 111 &&
          pixel[3] === 255,
      ),
    ).toBe(true);
    expect(
      pixels.some(
        (pixel) =>
          pixel[0] === 15 &&
          pixel[1] === 18 &&
          pixel[2] === 15 &&
          pixel[3] === 255,
      ),
    ).toBe(true);
  });

  test("latches while unfocused and clears when the app regains focus", () => {
    const app = read("src/App.tsx");

    expect(app).toContain('window.addEventListener("blur", syncTaskbarCompletionBadge)');
    expect(app).toContain("unreadTermIdsRef.current.size > 0");
    expect(app).toContain("completionFlashesRef.current.size > 0");
    expect(app).toMatch(
      /if \(document\.hasFocus\(\) \|\| !completionHighlightsRef\.current\)[\s\S]*setCompletionTaskbarBadge\(false\)/,
    );
    expect(app).toContain("setCompletionTaskbarBadge(true)");
  });

  test("grants only the native overlay permission needed by the window", () => {
    const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capability.permissions).toContain("core:window:allow-set-overlay-icon");
  });
});
