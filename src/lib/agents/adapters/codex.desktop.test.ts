import { describe, expect, test } from "bun:test";

import type { AdapterContext } from "../adapter";
import type { AgentEvent } from "../events";
import type { AgentLaunch } from "../launch";
import { createCodexAdapter, type CodexDesktopBridge } from "./codex";

const launch: AgentLaunch = {
  agent: "codex",
  program: "codex",
  env: {},
  wrapperArgs: [],
  forwardArgs: [],
  args: [],
  prompt: null,
  model: null,
  effort: null,
  resume: false,
  resumeId: null,
};

const bridgeA: CodexDesktopBridge = {
  fingerprint: "desktop-a",
  config: { "mcp_servers.node_repl.env.BROWSER_USE_ACCESS_PIPE_PATH": "\\\\.\\pipe\\codex-app-tools-a" },
};
const bridgeB: CodexDesktopBridge = {
  fingerprint: "desktop-b",
  config: { "mcp_servers.node_repl.env.BROWSER_USE_ACCESS_PIPE_PATH": "\\\\.\\pipe\\codex-app-tools-b" },
};

type Frame = Record<string, unknown> & { id?: string | number; method?: string; params?: Record<string, unknown> };

function harness(options: { bridge: () => CodexDesktopBridge | null; poll?: number }) {
  const events: AgentEvent[] = [];
  const sent: Frame[] = [];
  const homes: (string | null)[] = [];
  const adapter = createCodexAdapter({
    childStreamPublishMs: 0,
    completionQuietMs: 0,
    authPollIntervalMs: options.poll ?? 0,
    desktopRebindUnloadMs: 5_000,
    desktopBridge: async (home) => {
      homes.push(home);
      return options.bridge();
    },
  });
  const ctx: AdapterContext = {
    cwd: "H:/project",
    launch,
    send: (message) => sent.push(message as Frame),
    emit: (event) => events.push(event),
  };
  const feed = (frame: unknown) => adapter.receive(JSON.stringify(frame), ctx);
  const flush = async (steps = 12) => {
    for (let step = 0; step < steps; step += 1) await Promise.resolve();
  };
  /** Wait for the next unanswered request with this method. */
  const answered = new Set<string | number>();
  const next = async (method: string, timeoutMs = 3_000): Promise<Frame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = sent.find((message) => message.method === method && message.id !== undefined && !answered.has(message.id));
      if (frame) {
        answered.add(frame.id!);
        return frame;
      }
      if (Date.now() > deadline) throw new Error(`No ${method} request`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const reply = (frame: Frame, result: unknown) => feed({ jsonrpc: "2.0", id: frame.id, result });
  const open = async () => {
    adapter.start(ctx);
    reply(await next("initialize"), { codexHome: "C:\\Users\\me\\.codex" });
    reply(await next("account/read"), { account: { type: "chatgpt", email: null }, requiresOpenaiAuth: true });
  };
  return { adapter, ctx, events, sent, homes, feed, flush, next, reply, open };
}

describe("codex desktop browser bridge", () => {
  test("new threads receive the desktop settings for the reported Codex home", async () => {
    const h = harness({ bridge: () => bridgeA });
    await h.open();
    const start = await h.next("thread/start");
    expect(start.params).toEqual({ cwd: "H:/project", config: bridgeA.config });
    expect(h.homes).toEqual(["C:\\Users\\me\\.codex"]);
    h.reply(start, { thread: { id: "thread_1" } });
    await h.flush();
    await h.adapter.dispose?.(h.ctx);
  });

  test("a rejected bridge never prevents the conversation from opening", async () => {
    const h = harness({ bridge: () => bridgeA });
    await h.open();
    const first = await h.next("thread/start");
    h.feed({ jsonrpc: "2.0", id: first.id, error: { code: -32600, message: "invalid config" } });
    const retry = await h.next("thread/start");
    expect(retry.params).toEqual({ cwd: "H:/project" });
    h.reply(retry, { thread: { id: "thread_1", sessionId: "sess_1" } });
    await h.flush();
    expect(h.events).toContainEqual(expect.objectContaining({ type: "session", sessionId: "sess_1" }));
    await h.adapter.dispose?.(h.ctx);
  });

  test("an empty thread opened before the desktop app is reopened with its settings", async () => {
    let bridge: CodexDesktopBridge | null = null;
    const h = harness({ bridge: () => bridge, poll: 5 });
    await h.open();
    const start = await h.next("thread/start");
    expect(start.params).toEqual({ cwd: "H:/project" });
    h.reply(start, { thread: { id: "thread_empty" } });
    bridge = bridgeA;
    const reopened = await h.next("thread/start");
    expect(reopened.params).toEqual({ cwd: "H:/project", config: bridgeA.config });
    h.reply(reopened, { thread: { id: "thread_new", sessionId: "sess_new" } });
    const released = await h.next("thread/unsubscribe");
    expect(released.params).toEqual({ threadId: "thread_empty" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "session", sessionId: "sess_new" }));
    await h.adapter.dispose?.(h.ctx);
  });

  test("a desktop restart reloads an idle saved thread once with the new settings", async () => {
    let bridge: CodexDesktopBridge | null = bridgeA;
    const h = harness({ bridge: () => bridge, poll: 5 });
    await h.open();
    h.reply(await h.next("thread/start"), { thread: { id: "thread_1" } });
    await h.flush();

    const resumed = h.adapter.resume?.("thread_saved", h.ctx);
    h.reply(await h.next("thread/loaded/list"), { data: [], nextCursor: null });
    const resume = await h.next("thread/resume");
    expect(resume.params).toMatchObject({ threadId: "thread_saved", config: bridgeA.config });
    h.reply(resume, { thread: { id: "thread_saved", status: { type: "idle" }, turns: [] } });
    await resumed;
    await h.flush();

    bridge = bridgeB;
    h.reply(await h.next("thread/backgroundTerminals/list"), { data: [] });
    const release = await h.next("thread/unsubscribe");
    expect(release.params).toEqual({ threadId: "thread_saved" });
    h.reply(release, { status: "unsubscribed" });
    await h.flush();
    h.feed({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: "thread_saved", status: { type: "notLoaded" } } });
    const reload = await h.next("thread/resume");
    expect(reload.params).toEqual({ threadId: "thread_saved", config: bridgeB.config, excludeTurns: true });
    h.reply(reload, { thread: { id: "thread_saved" } });
    await h.flush();
    expect(h.events).toContainEqual({ type: "session", desktopConnectionError: null });

    // The same desktop launch is never retried, even after more poll ticks.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.sent.filter((frame) => frame.method === "thread/unsubscribe")).toHaveLength(1);
    await h.adapter.dispose?.(h.ctx);
  });

  test("resuming a thread that was already loaded schedules a reload", async () => {
    const h = harness({ bridge: () => bridgeA, poll: 5 });
    await h.open();
    h.reply(await h.next("thread/start"), { thread: { id: "thread_1" } });
    await h.flush();
    const resumed = h.adapter.resume?.("thread_live", h.ctx);
    h.reply(await h.next("thread/loaded/list"), { data: ["thread_live"], nextCursor: null });
    h.reply(await h.next("thread/resume"), { thread: { id: "thread_live", status: { type: "idle" }, turns: [] } });
    await resumed;
    h.reply(await h.next("thread/backgroundTerminals/list"), { data: [] });
    const release = await h.next("thread/unsubscribe");
    expect(release.params).toEqual({ threadId: "thread_live" });
    await h.adapter.dispose?.(h.ctx);
  });

  test("background terminals postpone a reload instead of ending them", async () => {
    let bridge: CodexDesktopBridge | null = bridgeA;
    const h = harness({ bridge: () => bridge, poll: 5 });
    await h.open();
    h.reply(await h.next("thread/start"), { thread: { id: "thread_1" } });
    await h.flush();
    const resumed = h.adapter.resume?.("thread_saved", h.ctx);
    h.reply(await h.next("thread/loaded/list"), { data: [], nextCursor: null });
    h.reply(await h.next("thread/resume"), { thread: { id: "thread_saved", status: { type: "idle" }, turns: [] } });
    await resumed;
    await h.flush();

    bridge = bridgeB;
    h.reply(await h.next("thread/backgroundTerminals/list"), { data: [{ processId: "dev-server", osPid: 42 }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent.some((frame) => frame.method === "thread/unsubscribe")).toBe(false);
    // Once the terminal is gone, the next tick reconnects.
    h.reply(await h.next("thread/backgroundTerminals/list"), { data: [] });
    expect((await h.next("thread/unsubscribe")).params).toEqual({ threadId: "thread_saved" });
    await h.adapter.dispose?.(h.ctx);
  });

  test("a prompt sent during a reload waits for the reloaded thread", async () => {
    let bridge: CodexDesktopBridge | null = bridgeA;
    const h = harness({ bridge: () => bridge, poll: 5 });
    await h.open();
    h.reply(await h.next("thread/start"), { thread: { id: "thread_1" } });
    await h.flush();
    const resumed = h.adapter.resume?.("thread_saved", h.ctx);
    h.reply(await h.next("thread/loaded/list"), { data: [], nextCursor: null });
    h.reply(await h.next("thread/resume"), { thread: { id: "thread_saved", status: { type: "idle" }, turns: [] } });
    await resumed;
    await h.flush();

    bridge = bridgeB;
    h.reply(await h.next("thread/backgroundTerminals/list"), { data: [] });
    h.reply(await h.next("thread/unsubscribe"), { status: "unsubscribed" });
    h.adapter.prompt({ text: "Open Chrome", images: [] }, h.ctx);
    expect(h.sent.some((frame) => frame.method === "turn/start")).toBe(false);
    h.feed({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: "thread_saved", status: { type: "notLoaded" } } });
    h.reply(await h.next("thread/resume"), { thread: { id: "thread_saved" } });
    const turn = await h.next("turn/start");
    expect(turn.params).toMatchObject({ threadId: "thread_saved" });
    await h.adapter.dispose?.(h.ctx);
  });
});
