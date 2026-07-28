import { describe, expect, test } from "bun:test";

import { acknowledgeCompletion } from "./completionHighlights";

describe("completion highlights", () => {
  test("acknowledging one terminal preserves every other unread terminal", () => {
    const unread = new Set(["selected-before-restore", "clicked-after-restore"]);

    const next = acknowledgeCompletion(unread, "clicked-after-restore");

    expect(next).toEqual(new Set(["selected-before-restore"]));
    expect(unread).toEqual(new Set(["selected-before-restore", "clicked-after-restore"]));
  });

  test("acknowledging a terminal without a highlight keeps the same state", () => {
    const unread = new Set(["other-terminal"]);

    expect(acknowledgeCompletion(unread, "plain-terminal")).toBe(unread);
  });
});
