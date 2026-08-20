import { describe, expect, test } from "bun:test";

import {
  fitMobileWorkspaceSnapshot,
  MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
  mobileAgentActivity,
  mobileTerminalStatus,
  truncateUtf8,
  truncateUtf8Tail,
  utf8ByteLength,
} from "./mobileWorkspace";
import type { MobileWorkspaceSnapshot } from "./ipc";

describe("mobile workspace payload bounds", () => {
  test("counts UTF-8 bytes without splitting a multibyte character", () => {
    const value = "🦆".repeat(100);
    const truncated = truncateUtf8(value, 17);

    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(17);
    expect(truncated).not.toContain("�");
  });

  test("keeps the newest terminal output on a UTF-8 boundary", () => {
    const truncated = truncateUtf8Tail(`old output\n${"\ud83e\udd86".repeat(100)}\nlatest`, 31);

    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(31);
    expect(truncated).toEndWith("latest");
    expect(truncated).not.toContain("\ufffd");
    expect(truncateUtf8Tail("too long", 1)).toBe("");
  });

  test("fits the serialized snapshot, including JSON escaping", () => {
    const snapshot: MobileWorkspaceSnapshot = {
      projects: [{
        id: "project",
        name: "Project",
        path: "C:/project",
        branch: null,
        terminals: [{
          id: "terminal",
          title: "Terminal",
          shell: "PowerShell",
          agent: "Codex",
          model: null,
          status: "idle",
          mode: "conversation",
          unreadOnDesktop: false,
          commands: [],
          activity: [],
          conversation: [{
            id: "message",
            sentAt: 1,
            role: "assistant",
            text: "\\\"\u0000🦆".repeat(100_000),
          }],
          permission: null,
        }],
      }],
    };

    const bounded = fitMobileWorkspaceSnapshot(snapshot);
    expect(utf8ByteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
    );
  });

  test("trims old terminal scrollback before dropping its newest screen", () => {
    const snapshot: MobileWorkspaceSnapshot = {
      projects: [{
        id: "project",
        name: "Project",
        path: "C:/project",
        branch: null,
        terminals: [{
          id: "terminal",
          title: "Terminal",
          shell: "PowerShell",
          agent: "Codex",
          model: null,
          status: "idle",
          mode: "terminal",
          unreadOnDesktop: false,
          commands: [],
          activity: [],
          terminalOutput: `${"old output\n".repeat(30_000)}LATEST SCREEN`,
          conversation: [],
          permission: null,
        }],
      }],
    };

    const bounded = fitMobileWorkspaceSnapshot(snapshot);
    expect(utf8ByteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
    );
    expect(bounded.projects[0].terminals[0].terminalOutput).toEndWith("LATEST SCREEN");
  });
});

describe("mobile terminal activity", () => {
  test("keeps the newest reasoning, plan, and tool progress for the phone", () => {
    const activity = mobileAgentActivity([
      { id: "think", at: 1, kind: "thinking", text: "Inspecting the sync path", streaming: true },
      {
        id: "plan",
        at: 2,
        kind: "plan",
        steps: [
          { text: "Inspect state", status: "done" },
          { text: "Publish progress", status: "running" },
        ],
      },
      {
        id: "tool",
        at: 3,
        kind: "tool",
        callId: "call",
        name: "shell_command",
        tool: "execute",
        title: "Run mobile tests",
        status: "running",
        command: "gradle test",
        output: "Compiling",
        changes: [{
          path: "android/app.kt",
          before: "old",
          after: "new",
          diff: null,
          insertions: 1,
          deletions: 1,
        }],
      },
    ]);

    expect(activity.map((item) => [item.kind, item.title, item.status])).toEqual([
      ["thinking", "Reasoning", "running"],
      ["plan", "Inspect state", "done"],
      ["plan", "Publish progress", "running"],
      ["tool", "Run mobile tests", "running"],
    ]);
    expect(activity.at(-1)?.detail).toBe("Compiling");
    expect(activity.at(-1)?.command).toBe("gradle test");
    expect(activity.at(-1)?.changes).toEqual([{
      path: "android/app.kt",
      insertions: 1,
      deletions: 1,
      diff: "@@\n-old\n+new",
    }]);
  });

  test("does not call a bare raw agent launch working", () => {
    expect(mobileTerminalStatus({
      exited: false,
      agent: "codex",
      busy: true,
      pendingAgentTurn: false,
      structuredStatus: null,
    })).toBe("idle");
  });

  test("keeps structured startup distinct from thinking", () => {
    expect(mobileTerminalStatus({
      exited: false,
      agent: null,
      busy: false,
      pendingAgentTurn: false,
      structuredStatus: "starting",
    })).toBe("starting");
  });

  test("reports only a credited raw-agent prompt as working", () => {
    expect(mobileTerminalStatus({
      exited: false,
      agent: "codex",
      busy: true,
      pendingAgentTurn: true,
      structuredStatus: null,
    })).toBe("working");
  });
});
