import { describe, expect, test } from "bun:test";

import { conversationText } from "./conversation";
import type { AgentItem } from "./types";

describe("conversationText", () => {
  test("copies user and assistant messages in transcript order", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "u1", at: 1, text: "Build this feature" },
      { kind: "thinking", id: "t1", at: 2, text: "Private notes", streaming: false },
      {
        kind: "tool",
        id: "tool-1",
        at: 3,
        callId: "call-1",
        name: "read",
        tool: "read",
        title: "Read a file",
        status: "done",
        command: null,
        output: "implementation detail",
        changes: [],
      },
      { kind: "assistant", id: "a1", at: 4, text: "Done.", streaming: false },
    ];

    expect(conversationText(items, "Codex")).toBe(
      "You:\nBuild this feature\n\nCodex:\nDone.",
    );
  });

  test("names image attachments and skips app notices", () => {
    const items: AgentItem[] = [
      {
        kind: "user",
        id: "u1",
        at: 1,
        text: "What is wrong here?",
        images: [
          {
            id: "image-1",
            name: "error.png",
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,AA==",
            size: 1,
          },
        ],
      },
      { kind: "notice", id: "n1", at: 2, text: "Model changed", tone: "info" },
    ];

    expect(conversationText(items, "OpenCode")).toBe(
      "You:\nWhat is wrong here?\n[Image: error.png]",
    );
  });
});
