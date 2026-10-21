import { expect, test } from "bun:test";
import { startMobilePromptSync } from "./mobilePromptSync";
import type { PromptTemplate } from "./promptTemplates";
import type { MobileNotificationStatus, MobileSendResult } from "./ipc";

const prompt: PromptTemplate = { id: "p", title: "Review", content: "Full text \u{1f986}\n".repeat(1_000), createdAt: 1, updatedAt: 2 };
const ok: MobileSendResult = { sent: 1, failed: 0, errors: [] };
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

function harness(paired = true) {
  let rows: readonly PromptTemplate[] = [prompt];
  let tick = () => {};
  let devices = (_paired: boolean) => {};
  let changed = () => {};
  const events = new EventTarget();
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const sent: readonly PromptTemplate[][] = [];
  const calls = sent as PromptTemplate[][];
  let send: (templates: readonly PromptTemplate[]) => Promise<MobileSendResult> = async () => ok;
  const stop = startMobilePromptSync({
    send: templates => { calls.push([...templates]); return send(templates); },
    status: async () => ({ devices: paired ? [{}] : [] } as unknown as MobileNotificationStatus),
    getTemplates: () => rows,
    subscribe: listener => { changed = listener; return () => { changed = () => {}; }; },
    onTick: async cb => { tick = cb; return () => { tick = () => {}; }; },
    onDevices: async cb => { devices = cb; return () => { devices = () => {}; }; },
    runtime: {
      setTimeout: ((cb: () => void) => { timers.set(++timerId, cb); return timerId; }) as Window["setTimeout"],
      clearTimeout: id => { timers.delete(id); },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  return { calls, stop, tick: () => tick(), pair: () => devices(true), unpair: () => devices(false),
    change: (next: PromptTemplate[]) => { rows = next; changed(); },
    setSend: (next: typeof send) => { send = next; },
    flush: async () => { await settle(); const pending = [...timers.values()]; timers.clear(); pending.forEach(cb => cb()); await settle(); },
    refresh: () => events.dispatchEvent(new Event("duckweed:mobile-refresh")),
  };
}

test("syncs the full initial library, edits, new templates, and deletions", async () => {
  const h = harness();
  try {
    await h.flush();
    expect(h.calls[0]).toEqual([prompt]);
    const added = { ...prompt, id: "new", title: "New template" };
    h.change([added, { ...prompt, content: "Edited" }]);
    await h.flush();
    expect(h.calls[1]).toEqual([added, { ...prompt, content: "Edited" }]);
    h.change([]);
    await h.flush();
    expect(h.calls[2]).toEqual([]);
  } finally { h.stop(); }
});

test("waits for pairing and resends after a phone refresh", async () => {
  const h = harness(false);
  try {
    await h.flush();
    expect(h.calls).toHaveLength(0);
    h.pair(); await h.flush();
    h.change([prompt]); await h.flush();
    expect(h.calls).toHaveLength(1);
    h.refresh(); await h.flush();
    expect(h.calls).toHaveLength(2);
    h.unpair(); h.change([]); await h.flush();
    expect(h.calls).toHaveLength(2);
  } finally { h.stop(); }
});

test("queues changes while sending and retries a partial delivery", async () => {
  const h = harness();
  let finish!: (result: MobileSendResult) => void;
  h.setSend(() => new Promise(resolve => { finish = resolve; }));
  try {
    await h.flush();
    h.change([]);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    finish(ok); await h.flush();
    expect(h.calls[1]).toEqual([]);
    finish({ sent: 0, failed: 1, errors: ["Offline"] });
    h.setSend(async () => ok);
    await h.flush();
    expect(h.calls[2]).toEqual([]);
  } finally { h.stop(); }
});

test("a native tick publishes queued changes and stopping cancels pending sends", async () => {
  const h = harness();
  await settle();
  h.tick(); await settle();
  expect(h.calls).toHaveLength(1);
  h.change([]); h.stop();
  await h.flush();
  expect(h.calls).toHaveLength(1);
});

test("retries a failed forced refresh even when the library has not changed", async () => {
  const h = harness();
  try {
    await h.flush();
    h.setSend(async () => ({ sent: 0, failed: 1, errors: ["Offline"] }));
    h.refresh(); await h.flush();
    h.setSend(async () => ok);
    await h.flush();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]).toEqual([prompt]);
  } finally { h.stop(); }
});
