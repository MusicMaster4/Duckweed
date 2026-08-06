import { describe, expect, test } from "bun:test";

import { conversationText } from "./conversation";
import type { AgentItem } from "./types";

describe("conversationText", () => {
  test("copies every timeline item in transcript order", () => {
    const items: AgentItem[] = [
      { kind: "user", id: "u1", at: 1, text: "Build this feature" },
      { kind: "thinking", id: "t1", at: 2, text: "Inspect the exporter", streaming: false },
      {
        kind: "plan",
        id: "p1",
        at: 3,
        steps: [
          { text: "Find the copy action", status: "done" },
          { text: "Update the transcript", status: "running" },
          { text: "Verify it", status: "pending" },
        ],
      },
      {
        kind: "tool",
        id: "tool-1",
        at: 4,
        callId: "call-1",
        name: "read",
        tool: "read",
        title: "Read a file",
        status: "done",
        command: "Get-Content src/app.ts",
        output: "const app = true;",
        changes: [],
      },
      { kind: "notice", id: "n1", at: 5, text: "Model changed", tone: "info" },
      { kind: "assistant", id: "a1", at: 6, text: "Done.", streaming: false },
    ];

    expect(conversationText(items, "Codex")).toBe(
      [
        "You:\nBuild this feature",
        "Codex thinking:\nInspect the exporter",
        "Plan:\n- [x] Find the copy action\n- [>] Update the transcript\n- [ ] Verify it",
        [
          "Tool call [done]: Read a file",
          "Tool: read",
          "Command:\n```shell\nGet-Content src/app.ts\n```",
          "Output:\n```text\nconst app = true;\n```",
        ].join("\n\n"),
        "Notice [info]:\nModel changed",
        "Codex:\nDone.",
      ].join("\n\n"),
    );
  });

  test("copies added, removed, and replaced file contents as diffs", () => {
    const items: AgentItem[] = [
      {
        kind: "tool",
        id: "tool-1",
        at: 1,
        callId: "call-1",
        name: "edit_file",
        tool: "edit",
        title: "Edit files",
        status: "done",
        command: null,
        output: "",
        changes: [
          {
            path: "src/new.ts",
            before: null,
            after: "first\nsecond",
            diff: null,
            insertions: 2,
            deletions: 0,
          },
          {
            path: "src/old.ts",
            before: "obsolete\nfile",
            after: null,
            diff: null,
            insertions: 0,
            deletions: 2,
          },
          {
            path: "src/app.ts",
            before: "keep\nold\nend",
            after: "keep\nnew\nend",
            diff: null,
            insertions: 1,
            deletions: 1,
          },
        ],
      },
    ];

    const transcript = conversationText(items, "Codex");
    expect(transcript).toContain(
      "File change: src/new.ts (+2 -0)\n```diff\n--- /dev/null\n+++ b/src/new.ts\n+first\n+second\n```",
    );
    expect(transcript).toContain(
      "File change: src/old.ts (+0 -2)\n```diff\n--- a/src/old.ts\n+++ /dev/null\n-obsolete\n-file\n```",
    );
    expect(transcript).toContain(
      "File change: src/app.ts (+1 -1)\n```diff\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n keep\n-old\n+new\n end\n```",
    );
  });

  test("keeps provider patches and nested subagent transcripts", () => {
    const items: AgentItem[] = [
      {
        kind: "tool",
        id: "tool-1",
        at: 1,
        callId: "call-1",
        name: "spawn_agent",
        tool: "task",
        title: "Delegate tests",
        status: "done",
        command: null,
        output: "Tests passed",
        changes: [
          {
            path: "src/app.ts",
            before: null,
            after: null,
            diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
            insertions: 1,
            deletions: 1,
          },
        ],
        subagent: {
          label: "Tester",
          role: "worker",
          prompt: "Run the tests",
          items: [
            { kind: "assistant", id: "child-a1", at: 2, text: "All green.", streaming: false },
          ],
        },
      },
    ];

    const transcript = conversationText(items, "Codex");
    expect(transcript).toContain("@@ -1 +1 @@\n-old\n+new");
    expect(transcript).toContain(
      "Subagent:\nLabel: Tester\nRole: worker\nPrompt:\nRun the tests\nTranscript:\nTester:\nAll green.",
    );
  });

  test("reports a change whose provider omitted its diff contents", () => {
    const items: AgentItem[] = [
      {
        kind: "tool",
        id: "tool-1",
        at: 1,
        callId: "call-1",
        name: "edit",
        tool: "edit",
        title: "Edit unknown contents",
        status: "done",
        command: null,
        output: "",
        changes: [
          {
            path: "src/unknown.ts",
            before: null,
            after: null,
            diff: null,
            insertions: 4,
            deletions: 2,
          },
        ],
      },
    ];

    expect(conversationText(items, "Codex")).toContain(
      "File change: src/unknown.ts (+4 -2)\nDiff contents were not provided by the agent.",
    );
  });

  test("names image attachments, their type and size", () => {
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
    ];

    expect(conversationText(items, "OpenCode")).toBe(
      "You:\nWhat is wrong here?\n[Image: error.png (image/png, 1 bytes)]",
    );
  });
});
