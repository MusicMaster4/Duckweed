import { describe, expect, test } from "bun:test";
import { createRecoveryStore, parseRecovery } from "./workspaceRecovery";

describe("workspace crash recovery", () => {
  test("saves drafts and absolute deadlines without needing an exit event", () => {
    let disk: string | null = null;
    const first = createRecoveryStore(() => disk, (raw) => { disk = raw; });
    first.update("claude-pane", { cwd: "H:/project", draft: "Unsent\nwork", timed: { at: 1234 } });
    first.update("other-pane", { scheduled: { targetTermId: "claude-pane", targetLabel: "Claude" } });
    const restarted = createRecoveryStore(() => disk, (raw) => { disk = raw; });
    expect(restarted.get("claude-pane")).toMatchObject({
      cwd: "H:/project", draft: "Unsent\nwork", timed: { at: 1234 },
    });
    expect(restarted.get("other-pane")?.scheduled?.targetTermId).toBe("claude-pane");
  });

  test("closing one pane removes its recovery and dependent completion schedules", () => {
    let disk: string | null = null;
    const store = createRecoveryStore(() => disk, (raw) => { disk = raw; });
    store.update("a", { draft: "keep", timed: { at: 5000 } });
    store.update("b", { draft: "closed" });
    store.update("a", { scheduled: { targetTermId: "b", targetLabel: "Other agent" } });
    store.remove("b");
    expect(parseRecovery(disk).panes.b).toBeUndefined();
    expect(parseRecovery(disk).panes.a).toMatchObject({ draft: "keep", timed: { at: 5000 }, scheduled: null });
  });

  test("shutdown cleanup cannot erase the last live snapshot", () => {
    let disk: string | null = null;
    const store = createRecoveryStore(() => disk, (raw) => { disk = raw; });
    store.update("a", { draft: "recover me" });
    const saved = disk;
    store.freeze();
    store.update("a", { draft: "" });
    store.remove("a");
    store.prune([]);
    expect(disk).toBe(saved);
  });

  test("invalid recovery data does not prevent startup", () => {
    expect(parseRecovery("invalid").panes).toEqual({});
    expect(parseRecovery('{"version":2,"panes":{}}').panes).toEqual({});
    const saved = parseRecovery(JSON.stringify({ version: 1, panes: {
      valid: { draft: "kept", timed: { at: "tomorrow" }, agent: { launch: {} } }, invalid: null,
    } }));
    expect(saved.panes.valid).toMatchObject({ draft: "kept", timed: null, agent: null });
    expect(saved.panes.invalid).toBeUndefined();
  });
});
