import { describe, expect, test } from "bun:test";

import { emit, on } from "./bus";

describe("cross-component bus", () => {
  test("routes a prompt to one exact terminal", () => {
    const received: Array<{ termId: string; text: string }> = [];
    const unsubscribe = on("term:insert-prompt", (payload) => received.push(payload));

    emit("term:insert-prompt", { termId: "terminal-b", text: "Run the focused tests" });
    unsubscribe();
    emit("term:insert-prompt", { termId: "terminal-c", text: "Ignored" });

    expect(received).toEqual([
      { termId: "terminal-b", text: "Run the focused tests" },
    ]);
  });
});
