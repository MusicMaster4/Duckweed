import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentFrame, AgentSpawnOptions } from "../ipc";
import type { AgentLaunch } from "./launch";

const store = new Map<string, string>();
const stubWindow = {
  __TAURI_INTERNALS__: {},
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  },
  cancelAnimationFrame: () => {},
  setTimeout: globalThis.setTimeout.bind(globalThis),
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
};
Object.defineProperty(globalThis, "window", { value: stubWindow, configurable: true });

const sent: string[] = [];
let spawn: AgentSpawnOptions | null = null;
let frameSink: ((frame: AgentFrame) => void) | null = null;

mock.module("../durableStorage", () => ({
  saveDurably: () => {},
}));

mock.module("@tauri-apps/api/core", () => ({
  Channel: class Channel {
    onmessage: ((frame: AgentFrame) => void) | null = null;
  },
  invoke: async () => {
    throw new Error("unexpected invoke");
  },
}));

mock.module("../ipc", () => ({
  agentProcStart: async (
    _id: string,
    options: AgentSpawnOptions,
    onFrame: { onmessage?: (frame: AgentFrame) => void },
  ) => {
    spawn = options;
    frameSink = (frame) => onFrame.onmessage?.(frame);
    return { program: options.program, pid: 1 };
  },
  agentProcSend: async (_id: string, line: string) => {
    sent.push(line);
  },
  agentProcStop: async () => {},
  agentProcCloseStdin: async () => {},
  agentProcProbe: async () => [],
  agentSessionTranscript: async () => [],
  agentSessionsList: async () => [],
  homeDir: async () => "H:/",
  readFile: async () => "",
}));

const grokLaunch: AgentLaunch = {
  agent: "grok",
  program: "grok",
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

const cursorLaunch: AgentLaunch = {
  ...grokLaunch,
  agent: "cursor",
  program: "cursor-agent",
};

function rpc(value: unknown): Record<string, unknown> {
  return JSON.parse(value as string) as Record<string, unknown>;
}

function feed(frame: unknown): void {
  frameSink?.({ kind: "stdout", line: JSON.stringify(frame) });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function handshake(): Promise<void> {
  await flush();
  const initialize = sent.map(rpc).find((message) => message.method === "initialize");
  feed({ jsonrpc: "2.0", id: initialize?.id, result: { protocolVersion: 1 } });
  await flush();
  const created = sent.map(rpc).find((message) => message.method === "session/new");
  feed({ jsonrpc: "2.0", id: created?.id, result: { sessionId: "s1" } });
  await flush();
}

const session = await import("./session");

describe("Grok custom-UI follow-up steering", () => {
  beforeEach(() => {
    sent.length = 0;
    spawn = null;
    frameSink = null;
    session.setFollowupMode("queue");
  });

  afterEach(() => {
    session.stopAll();
    session.setFollowupMode("queue");
  });

  test("does not overlay GROK_CONFIG follow_up_behavior when spawning Grok", async () => {
    expect(await session.start("t-grok-env", grokLaunch, "H:/project")).toBeNull();
    expect(spawn?.env?.GROK_CONFIG).toBeUndefined();
  });

  test("steers a working Grok session instead of restoring the follow-up into the local queue", async () => {
    expect(await session.start("t-grok-steer", grokLaunch, "H:/project")).toBeNull();
    await handshake();
    expect(session.get("t-grok-steer")?.status).toBe("idle");
    expect(session.canSteer("t-grok-steer")).toBe(true);

    session.submit("t-grok-steer", "fix the parser");
    await flush();
    expect(session.get("t-grok-steer")?.status).toBe("working");
    const originalPrompts = sent.map(rpc).filter((message) => message.method === "session/prompt");
    expect(originalPrompts).toHaveLength(1);

    session.setFollowupMode("steer");
    session.submit("t-grok-steer", "Focus on the failing test");
    await flush();

    const interject = sent.map(rpc).find((message) => message.method === "_x.ai/interject");
    expect(interject).toMatchObject({
      method: "_x.ai/interject",
      params: { sessionId: "s1", text: "Focus on the failing test" },
    });
    expect(sent.map(rpc).filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(sent.map(rpc).some((message) => message.method === "session/cancel")).toBe(false);

    feed({ jsonrpc: "2.0", id: interject?.id, result: { status: "queued" } });
    await flush();

    const state = session.get("t-grok-steer");
    expect(state?.pending).toEqual([]);
    expect(state?.status).toBe("working");
    expect(state?.items.filter((item) => item.kind === "notice")).toEqual([]);
    const users = state?.items.filter((item) => item.kind === "user") ?? [];
    expect(users.at(-1)).toMatchObject({
      text: "Focus on the failing test",
      sameTurn: true,
    });
  });

  test("queues locally when Grok rejects mid-turn interject", async () => {
    expect(await session.start("t-grok-interject-miss", grokLaunch, "H:/project")).toBeNull();
    await handshake();
    session.submit("t-grok-interject-miss", "fix the parser");
    await flush();

    session.setFollowupMode("steer");
    session.submit("t-grok-interject-miss", "Focus on the failing test");
    await flush();
    const interject = sent.map(rpc).find((message) => message.method === "_x.ai/interject");
    feed({
      jsonrpc: "2.0",
      id: interject?.id,
      error: { code: -32601, message: "Method not found" },
    });
    await flush();

    const state = session.get("t-grok-interject-miss");
    expect(state?.pending).toHaveLength(1);
    expect(state?.pending[0].text).toBe("Focus on the failing test");
    expect(state?.status).toBe("working");
    expect(state?.items.some((item) => item.kind === "user" && item.sameTurn)).toBe(false);
    expect(
      state?.items.some(
        (item) =>
          item.kind === "notice" &&
          item.text.includes("The active turn could not be steered"),
      ),
    ).toBe(true);
    expect(sent.map(rpc).filter((message) => message.method === "session/prompt")).toHaveLength(1);
  });

  test("Send now steers a queued Grok follow-up", async () => {
    expect(await session.start("t-grok-send-now", grokLaunch, "H:/project")).toBeNull();
    await handshake();
    session.setFollowupMode("queue");
    session.submit("t-grok-send-now", "first");
    await flush();
    session.submit("t-grok-send-now", "do this now");
    const queued = session.get("t-grok-send-now")?.pending ?? [];
    expect(queued).toHaveLength(1);

    session.sendQueuedNow("t-grok-send-now", queued[0].id);
    await flush();
    const interject = sent.map(rpc).find((message) => message.method === "_x.ai/interject");
    expect(interject).toMatchObject({
      method: "_x.ai/interject",
      params: { sessionId: "s1", text: "do this now" },
    });
    feed({ jsonrpc: "2.0", id: interject?.id, result: { status: "queued" } });
    await flush();

    const state = session.get("t-grok-send-now");
    expect(state?.pending).toEqual([]);
    expect(state?.items.at(-1)).toMatchObject({
      kind: "user",
      text: "do this now",
      sameTurn: true,
    });
    expect(sent.map(rpc).filter((message) => message.method === "session/prompt")).toHaveLength(1);
  });

  test("does not expose same-turn steering for Cursor", async () => {
    expect(await session.start("t-cursor", cursorLaunch, "H:/project")).toBeNull();
    await handshake();
    expect(session.canSteer("t-cursor")).toBe(false);
    expect(spawn?.env?.GROK_CONFIG).toBeUndefined();

    session.submit("t-cursor", "first");
    await flush();
    session.setFollowupMode("steer");
    session.submit("t-cursor", "nudge");
    const state = session.get("t-cursor");
    expect(state?.pending).toHaveLength(1);
    expect(state?.pending[0].text).toBe("nudge");
    expect(
      sent.map(rpc).filter((message) => message.method === "session/prompt"),
    ).toHaveLength(1);
  });
});
