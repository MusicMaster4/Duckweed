import { describe, expect, test } from "bun:test";

import {
  fitMobileWorkspaceSnapshot,
  MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
  mobileAgentActivity,
  mobileTerminalStatus,
  mobileUsageLimits,
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
          completionSeq: 0,
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
          completionSeq: 0,
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

  test("fits verbose permission questions while preserving answer choices", () => {
    const permission = (terminal: string) => ({
      id: `permission-${terminal}`,
      kind: "question" as const,
      title: "Choose an option",
      detail: null,
      command: null,
      options: [],
      questions: Array.from({ length: 3 }, (_, questionIndex) => ({
        id: `question-${terminal}-${questionIndex}`,
        header: `Question ${questionIndex + 1}`,
        question: "Explain the preferred approach ".repeat(40),
        multiSelect: false,
        options: Array.from({ length: 12 }, (_, optionIndex) => ({
          id: `option-${terminal}-${questionIndex}-${optionIndex}`,
          label: `Option ${optionIndex + 1}`,
          description: "Detailed option description ".repeat(40),
          preview: "Large preview payload ".repeat(200),
        })),
      })),
    });
    const snapshot: MobileWorkspaceSnapshot = {
      projects: [{
        id: "project",
        name: "Project",
        path: "C:/project",
        branch: null,
        terminals: ["one", "two"].map((id) => ({
          id,
          title: "Codex",
          shell: "PowerShell",
          agent: "Codex",
          model: null,
          status: "waiting" as const,
          mode: "conversation" as const,
          unreadOnDesktop: false,
          completionSeq: 0,
          commands: [],
          activity: [],
          conversation: [],
          permission: permission(id),
        })),
      }],
    };

    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeGreaterThan(
      MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
    );
    const bounded = fitMobileWorkspaceSnapshot(snapshot);
    expect(utf8ByteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES,
    );
    for (const terminal of bounded.projects[0].terminals) {
      expect(terminal.permission?.questions).toHaveLength(3);
      expect(
        terminal.permission?.questions.every((question) => question.options.length === 12),
      ).toBe(true);
      expect(terminal.permission?.questions[0].options[0].label).toBe("Option 1");
    }
  });
});

describe("mobile usage limits", () => {
  test("keeps reported windows and only the fields needed by Settings", () => {
    const limits = mobileUsageLimits([
      {
        agent: "codex",
        label: "Codex",
        source: "reported",
        plan: "pro",
        message: null,
        limits: [{
          id: "weekly",
          label: "7-day limit",
          used: 142,
          limit: null,
          percent: 142,
          unit: "percent",
          resets_at: 1_800_000_000_000,
          window_ms: 7 * 24 * 60 * 60 * 1000,
          forecast: {
            per_hour: 2,
            basis: "recent",
            confidence: 0.8,
            usage_hours_left: 12.5,
            runs_out_at: null,
            projected_percent: 88,
            duty: 0.25,
          },
        }],
      },
      {
        agent: "future-agent",
        label: "Future Agent",
        source: "unavailable",
        plan: null,
        message: "No provider data",
        limits: [],
      },
    ]);

    expect(limits).toEqual([{
      agent: "codex",
      label: "Codex",
      plan: "pro",
      limits: [{
        id: "weekly",
        label: "7-day limit",
        percent: 100,
        resetsAt: 1_800_000_000_000,
        usageHoursLeft: 12.5,
      }],
    }]);
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
      ["plan", "Publish progress", "running"],
      ["tool", "Run mobile tests", "running"],
    ]);
    expect(activity[1]).toMatchObject({
      planType: "tasks",
      steps: [
        { text: "Inspect state", status: "done" },
        { text: "Publish progress", status: "running" },
      ],
    });
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

  test("keeps the active plan tracker when newer tool rows reach the activity limit", () => {
    const tools = Array.from({ length: 24 }, (_, index) => ({
      id: `tool-${index}`,
      at: index + 2,
      kind: "tool" as const,
      callId: `call-${index}`,
      name: "read",
      tool: "read" as const,
      title: `Read file ${index}`,
      status: "done" as const,
      command: null,
      output: "",
      changes: [],
    }));
    const activity = mobileAgentActivity([
      {
        id: "plan",
        at: 1,
        kind: "plan",
        steps: [{ text: "Keep tracking", status: "running" }],
      },
      ...tools,
    ], 20);

    expect(activity).toHaveLength(20);
    expect(activity.some((item) => item.id === "plan" && item.kind === "plan")).toBe(true);
  });
});
