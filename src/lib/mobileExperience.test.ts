import { describe, expect, test } from "bun:test";
import { mobileAgentExperience } from "./mobileExperience";
import { fitMobileWorkspaceSnapshot, MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES, utf8ByteLength } from "./mobileWorkspace";
import { emptyUsage, type AgentSessionState } from "./agents/types";
import type { MobileWorkspaceSnapshot } from "./ipc";

const session: AgentSessionState = { termId: "term", agent: "codex", program: "codex", label: "Codex", mark: "CX", accent: "#aaa",
  status: "working", workStartedAt: 100, lastWorkedForMs: null, cwd: "C:/project", model: "real-model", effort: "high", sessionId: "thread",
  goal: null, items: [], models: [], commands: [], permission: null, pending: [], usage: emptyUsage(), error: null, started: true };
describe("mobile desktop experience", () => {
  test("keeps normalized provider structure, streaming IDs, and current reasoning defaults", () => {
    const result = mobileAgentExperience({ ...session, nextEffort: "low", items: [
      { kind: "user", id: "user", at: 1, text: "Hello" },
      { kind: "thinking", id: "thought", at: 2, text: "Checking", streaming: true },
      { kind: "assistant", id: "answer", at: 3, text: "Progress", streaming: true },
    ] }, true);
    expect(result.items.map(item => item.id)).toEqual(["user", "thought", "answer"]);
    expect(result.agent).toBe("codex");
    expect(result.nextEffort).toBe("low");
    expect(result.conversationEpoch).toBe("user");
  });
  test("bounds long UTF-8 transcripts without mutating the desktop", () => {
    const items = Array.from({ length: 90 }, (_, index) => ({ kind: "assistant" as const, id: `a${index}`, at: index, text: "??".repeat(12_000), streaming: index === 89 }));
    const focused = mobileAgentExperience({ ...session, items }, true);
    const background = mobileAgentExperience({ ...session, items });
    expect(utf8ByteLength(JSON.stringify(focused))).toBeLessThan(125_000);
    expect(utf8ByteLength(JSON.stringify(background))).toBeLessThan(10_000);
    expect(focused.items.at(-1)?.id).toBe("a89");
    expect(background.items.at(-1)?.id).toBe("a89");
    expect(items[89].text).toBe("??".repeat(12_000));
    expect(focused.items.length).toBeGreaterThan(background.items.length);
  });
  test("keeps a large live tool readable even before the tab gets focus", () => {
    const result = mobileAgentExperience({ ...session, items: [{ kind: "tool", id: "live", at: 1, callId: "live", name: "edit", tool: "edit", title: "Apply changes", status: "running", command: null,
      output: "x".repeat(10_000), changes: Array.from({ length: 8 }, (_, i) => ({ path: `file-${i}`, before: "old".repeat(2_000), after: "new".repeat(2_000), diff: "diff".repeat(2_000), insertions: 3, deletions: 3 })) }] });
    expect(result.items[0]?.id).toBe("live");
    expect(utf8ByteLength(JSON.stringify(result))).toBeLessThan(10_000);
  });
  test("fits many rich agents inside the relay budget while preserving newest output", () => {
    const snapshot: MobileWorkspaceSnapshot = { projects: [{ id: "p", name: "Project", path: "", branch: null,
      terminals: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: "Codex", shell: "", agent: "Codex", model: "real-model",
        status: "working", mode: "conversation", completionSeq: 0, unreadOnDesktop: false, commands: [], activity: [], conversation: [], permission: null,
        experience: mobileAgentExperience({ ...session, items: Array.from({ length: 20 }, (_, n) => ({ kind: "assistant", id: `${i}-${n}`, at: n, text: "long\n".repeat(1_000), streaming: n === 19 })) }, i === 0),
      })),
    }] };
    fitMobileWorkspaceSnapshot(snapshot);
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MOBILE_WORKSPACE_SNAPSHOT_BUDGET_BYTES);
    for (const terminal of snapshot.projects[0].terminals) expect(terminal.experience?.items.at(-1)?.id).toEndWith("-19");
  });
});
