import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("focused completion highlight", () => {
  test("focused panes flash without becoming unread", () => {
    const app = read("src/App.tsx");
    const focused = app.indexOf("if (isFocusedTerm(termId)) {");
    const flash = app.indexOf("flashFocusedCompletion(termId);", focused);
    const leaveFocusedBranch = app.indexOf("return;", flash);
    const unread = app.indexOf("setUnreadTermIds((prev)", leaveFocusedBranch);

    expect(focused).toBeGreaterThan(-1);
    expect(flash).toBeGreaterThan(focused);
    expect(leaveFocusedBranch).toBeGreaterThan(flash);
    expect(unread).toBeGreaterThan(leaveFocusedBranch);
  });

  test("the pulse is 500ms in, 500ms held, and 500ms out", () => {
    const css = read("src/styles.css");
    expect(css).toContain("animation: pane-completion-flash 1500ms linear both");
    expect(css).toMatch(
      /@keyframes pane-completion-flash[\s\S]*33\.333%,\s*66\.667%[\s\S]*opacity:\s*1[\s\S]*100%[\s\S]*opacity:\s*0/,
    );
  });

  test("returning to a selected unread terminal holds for 1s, then fades for 500ms", () => {
    const app = read("src/App.tsx");
    const pane = read("src/components/TerminalPane.tsx");
    const css = read("src/styles.css");

    expect(app).toContain('window.addEventListener("focus", reviewSelectedCompletion)');
    expect(app).toContain("unreadTermIdsRef.current.has(term)");
    expect(app).toContain("flashFocusedCompletion(term, true)");
    expect(pane).toContain('completionFlash < 0 ? "is-restored" : ""');
    expect(css).toMatch(
      /@keyframes pane-restored-completion-flash[\s\S]*0%,\s*66\.667%[\s\S]*opacity:\s*1[\s\S]*100%[\s\S]*opacity:\s*0/,
    );
  });

  test("turning completion highlights off clears active pulses", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("completionFlashTimers.current.clear()");
    expect(app).toContain(
      "completionFlashes: completionHighlights ? completionFlashes : NO_COMPLETION_FLASHES",
    );
  });
});
