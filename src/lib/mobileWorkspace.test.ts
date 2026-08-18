import { describe, expect, test } from "bun:test";

import {
  fitMobileWorkspaceSnapshot,
  MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
  truncateUtf8,
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
});
