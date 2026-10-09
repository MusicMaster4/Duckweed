import { describe, expect, test } from "bun:test";
import { createRecoveryStore, parseRecovery } from "./workspaceRecovery";

function recoveryHarness() {
  const pending = new Set<() => void>();
  const writes: string[] = [];
  let scheduled = 0;
  const store = createRecoveryStore(
    () => null,
    (raw) => { writes.push(raw); },
    (save) => {
      scheduled++;
      pending.add(save);
      return () => { pending.delete(save); };
    },
  );
  return {
    store, writes, pending,
    get scheduled() { return scheduled; },
    tick: () => { for (const save of [...pending]) save(); },
  };
}

describe("workspace crash recovery", () => {
  test("saves drafts and absolute deadlines without needing an exit event", () => {
    const { store: first, writes, tick } = recoveryHarness();
    first.update("claude-pane", { cwd: "H:/project", draft: "Unsent\nwork", timed: { at: 1234 } });
    first.update("other-pane", { scheduled: { targetTermId: "claude-pane", targetLabel: "Claude" } });
    tick();
    const restarted = createRecoveryStore(() => writes.at(-1) ?? null, () => {});
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
    store.flush();
    store.remove("b");
    store.flush();
    expect(parseRecovery(disk).panes.b).toBeUndefined();
    expect(parseRecovery(disk).panes.a).toMatchObject({ draft: "keep", timed: { at: 5000 }, scheduled: null });
  });

  test("shutdown cleanup cannot erase the last live snapshot", () => {
    let disk: string | null = null;
    const store = createRecoveryStore(() => disk, (raw) => { disk = raw; });
    store.update("a", { draft: "recover me" });
    store.freeze();
    const saved = disk;
    expect(parseRecovery(saved).panes.a?.draft).toBe("recover me");
    store.update("a", { draft: "" });
    store.remove("a");
    store.prune([]);
    expect(disk).toBe(saved);
  });

  test("typing and simultaneous agent checkpoints share one bounded save", () => {
    const harness = recoveryHarness();
    const { store, writes, pending, tick } = harness;
    for (let edit = 0; edit < 100; edit++) {
      store.update(`pane-${edit % 24}`, { draft: `draft-${edit}` });
      expect(store.get(`pane-${edit % 24}`)?.draft).toBe(`draft-${edit}`);
      expect(pending.size).toBe(1);
    }
    expect(writes).toHaveLength(0);
    expect(harness.scheduled).toBe(1);
    tick();
    expect(writes).toHaveLength(1);
    expect(pending.size).toBe(0);
    expect(Object.keys(parseRecovery(writes[0]).panes)).toHaveLength(24);
    expect(parseRecovery(writes[0]).panes["pane-3"]?.draft).toBe("draft-99");
    store.update("pane-3", { draft: "still typing" });
    tick();
    expect(writes).toHaveLength(2);
    expect(parseRecovery(writes[1]).savedAt).toBeGreaterThan(parseRecovery(writes[0]).savedAt);
  });

  test("unchanged background histories are not serialized again", () => {
    const { store, writes, tick } = recoveryHarness();
    let visits = 0;
    const history = Object.assign(["previous command"], {
      toJSON: () => { visits++; return ["previous command"]; },
    });
    store.update('background-"quoted"', { history });
    store.update("active", { draft: "first" });
    tick();
    store.update("active", { draft: "second" });
    tick();
    expect(visits).toBe(1);
    expect(parseRecovery(writes[1]).panes['background-"quoted"']?.history).toEqual(["previous command"]);
    store.update('background-"quoted"', { history: ["new command"] });
    tick();
    expect(parseRecovery(writes[2]).panes['background-"quoted"']?.history).toEqual(["new command"]);
  });

  test("pruning invalidates cached schedules and does not resurrect closed panes", () => {
    const { store, writes, tick } = recoveryHarness();
    store.update("a", { scheduled: { targetTermId: "b", targetLabel: "B" } });
    store.update("b", { draft: "closed" });
    tick();
    store.prune(["a"]);
    tick();
    expect(parseRecovery(writes[1]).panes).toMatchObject({ a: { scheduled: null } });
    expect(parseRecovery(writes[1]).panes.b).toBeUndefined();
  });

  test("no-op updates and repeated flushes do not write the workspace", () => {
    const { store, writes, pending, tick } = recoveryHarness();
    store.update("a", { draft: "kept" });
    store.flush();
    expect(pending.size).toBe(0);
    store.update("a", { draft: "kept" });
    store.prune(["a"]);
    store.remove("absent");
    store.flush();
    tick();
    expect(writes).toHaveLength(1);
  });

  test("freeze flushes the pending draft and cancels the timer before cleanup", () => {
    const { store, writes, pending, tick } = recoveryHarness();
    store.update("shell-only", { draft: "last keystroke" });
    store.freeze();
    expect(pending.size).toBe(0);
    store.remove("shell-only");
    tick();
    expect(writes).toHaveLength(1);
    expect(parseRecovery(writes[0]).panes["shell-only"]?.draft).toBe("last keystroke");
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
