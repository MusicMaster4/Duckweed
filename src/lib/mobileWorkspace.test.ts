import { describe, expect, test } from "bun:test";

import {
  fitMobileWorkspaceSnapshot,
  MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
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
