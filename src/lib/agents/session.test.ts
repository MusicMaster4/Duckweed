import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentFrame, AgentSpawnOptions } from "../ipc";
import type { AgentLaunch } from "./launch";
import type { AgentImageAttachment } from "./types";

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
  openCodeModelsRefresh: async () => {},
  agentSessionTranscript: async () => [],
  agentSessionsList: async () => [],
  homeDir: async () => "H:/",
  listDir: async () => [],
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

const openCodeLaunch: AgentLaunch = {
  ...grokLaunch,
  agent: "opencode",
  program: "opencode",
};

const codexLaunch: AgentLaunch = {
  ...grokLaunch,
  agent: "codex",
  program: "codex",
};

const image: AgentImageAttachment = {
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,aGVsbG8=",
  size: 5,
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

async function codexHandshake(sessionId = "01900000-0000-7000-8000-000000000001"): Promise<void> {
  await flush();
  const initialize = sent.map(rpc).find((message) => message.method === "initialize");
  feed({ jsonrpc: "2.0", id: initialize?.id, result: {} });
  await flush();
  const accountRead = sent.map(rpc).find((message) => message.method === "account/read");
  feed({ jsonrpc: "2.0", id: accountRead?.id, result: { account: { type: "chatgpt" } } });
  await flush();
  const threadStart = sent.map(rpc).find((message) => message.method === "thread/start");
  feed({
    jsonrpc: "2.0",
    id: threadStart?.id,
    result: { thread: { id: sessionId }, model: "gpt-5" },
  });
  await flush();
}

const session = await import("./session");

describe("Custom agent UI sessions", () => {
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

  test("opens an existing OpenCode conversation with its native session flag", async () => {
    const requests: session.AgentAuthRequest[] = [];
    const unsubscribe = session.subscribeAuthRequest((request) => requests.push(request));
    try {
      expect(await session.start("t-opencode-native", openCodeLaunch, "H:/project")).toBeNull();
      await handshake();

      expect(session.handoffToNative("t-opencode-native")).toBe(true);
      expect(requests).toEqual([
        expect.objectContaining({
          termId: "t-opencode-native",
          agent: "opencode",
          action: "native",
          command: 'opencode --session "s1"',
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("opens bare Codex natively when its provisional empty thread was not saved", async () => {
    const requests: session.AgentAuthRequest[] = [];
    const unsubscribe = session.subscribeAuthRequest((request) => requests.push(request));
    try {
      expect(await session.start("t-codex-native-empty", codexLaunch, "H:/project")).toBeNull();
      await codexHandshake();

      expect(session.handoffToNative("t-codex-native-empty")).toBe(true);
      expect(requests).toEqual([
        expect.objectContaining({
          termId: "t-codex-native-empty",
          agent: "codex",
          action: "native",
          command: "codex",
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("resumes Codex natively after the conversation has a user turn", async () => {
    const requests: session.AgentAuthRequest[] = [];
    const unsubscribe = session.subscribeAuthRequest((request) => requests.push(request));
    const sessionId = "01900000-0000-7000-8000-000000000002";
    try {
      expect(await session.start("t-codex-native-started", codexLaunch, "H:/project")).toBeNull();
      await codexHandshake(sessionId);
      session.submit("t-codex-native-started", "Fix the parser");
      await flush();

      // Native handoff is gated while the turn is active. Completing it also
      // models the point at which Codex has persisted the rollout for resume.
      const turnStart = sent.map(rpc).find((message) => message.method === "turn/start");
      feed({ jsonrpc: "2.0", id: turnStart?.id, result: { turn: { id: "turn-1" } } });
      feed({
        method: "turn/completed",
        params: { threadId: sessionId, turn: { id: "turn-1", status: "completed", items: [] } },
      });
      await new Promise((resolve) => setTimeout(resolve, 850));

      expect(session.handoffToNative("t-codex-native-started")).toBe(true);
      expect(requests.at(-1)).toEqual(
        expect.objectContaining({
          termId: "t-codex-native-started",
          agent: "codex",
          action: "native",
          command: `codex resume "${sessionId}"`,
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  test("routes /side with an image into a fork instead of the main Codex turn", async () => {
    expect(await session.start("t-codex-side-image", codexLaunch, "H:/project")).toBeNull();
    await codexHandshake();
    const beforeSubmit = sent.length;

    session.submit("t-codex-side-image", "/side inspect this", [image]);
    await flush();

    const submitted = sent.slice(beforeSubmit).map(rpc);
    const fork = submitted.find((message) => message.method === "thread/fork");
    expect(fork).toBeDefined();
    expect(submitted.some((message) => message.method === "turn/start")).toBe(false);
    expect(session.get("t-codex-side-image")?.sideQuestion).toMatchObject({
      question: "inspect this",
      images: [image],
    });

    feed({ jsonrpc: "2.0", id: fork?.id, result: { thread: { id: "side_image" } } });
    await flush();

    const sideTurn = sent.map(rpc).find(
      (message) =>
        message.method === "turn/start" &&
        (message.params as Record<string, unknown>)?.threadId === "side_image",
    );
    expect(sideTurn).toMatchObject({
      params: {
        input: [
          { type: "text", text: "inspect this" },
          { type: "image", url: image.dataUrl },
        ],
      },
    });
  });

  test("runs image-backed /side immediately while the main Codex turn is working", async () => {
    expect(await session.start("t-codex-side-image-working", codexLaunch, "H:/project")).toBeNull();
    await codexHandshake();
    session.submit("t-codex-side-image-working", "keep working");
    await flush();
    expect(session.get("t-codex-side-image-working")?.status).toBe("working");
    const beforeSide = sent.length;

    session.submit("t-codex-side-image-working", "/side inspect this", [image]);
    await flush();

    const sideMessages = sent.slice(beforeSide).map(rpc);
    expect(sideMessages.some((message) => message.method === "thread/fork")).toBe(true);
    expect(session.get("t-codex-side-image-working")?.pending).toEqual([]);
    expect(session.get("t-codex-side-image-working")?.sideQuestion).toMatchObject({
      question: "inspect this",
      images: [image],
      status: "asking",
    });
  });
});
