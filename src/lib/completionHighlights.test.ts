import { describe, expect, test } from "bun:test";

import {
  acknowledgeCompletion,
  shouldFlashCompletionReview,
} from "./completionHighlights";

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

  test("keeps an unread selected terminal visible when its tab is opened", () => {
    const unread = new Set(["background-selected"]);

    expect(
      shouldFlashCompletionReview(unread, "background-selected", true),
    ).toBe(true);
  });

  test("does not replay the review flash without a view change or unread completion", () => {
    const unread = new Set(["background-selected"]);

    expect(
      shouldFlashCompletionReview(unread, "background-selected", false),
    ).toBe(false);
    expect(shouldFlashCompletionReview(unread, "plain-terminal", true)).toBe(false);
    expect(shouldFlashCompletionReview(unread, null, true)).toBe(false);
  });
});
