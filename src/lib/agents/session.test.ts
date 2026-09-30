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
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
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
let spawnFailure: string | null = null;

mock.module("../durableStorage", () => ({
  saveDurably: () => {},
  readStoredValue: (key: string) => store.get(key) ?? null,
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
    if (spawnFailure) throw new Error(spawnFailure);
    spawn = options;
    frameSink = (frame) => onFrame.onmessage?.(frame);
    return { program: options.program, pid: 1 };
  },
  agentProcSend: async (_id: string, line: string) => {
    sent.push(line);
  },
  agentProcStop: async () => {},
  agentCodexAuthSync: async () => "unchanged",
  agentProcCloseStdin: async () => {},
  agentProcProbe: async () => [],
  openCodeModelsRefresh: async () => {},
  openUrl: async () => {},
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
const { workspaceRecovery, RECOVERY_KEY, parseRecovery } = await import("../workspaceRecovery");

describe("Custom agent UI sessions", () => {
  test("shutdown flush saves a shell draft even when no agent is open", () => {
    expect(session.activeTermIds()).toHaveLength(0);
    workspaceRecovery.update("shell-only-recovery", { draft: "latest shell input" });
    session.flushRecovery();
    expect(parseRecovery(store.get(RECOVERY_KEY) ?? null).panes["shell-only-recovery"]?.draft)
      .toBe("latest shell input");
  });

  test("batched recovery keeps the latest agent draft and its attachments", async () => {
    const termId = "batched-agent-draft";
    await session.start(termId, grokLaunch, "H:/project");
    session.setDraftImages(termId, [image]);
    for (let index = 0; index < 100; index++) session.setDraft(termId, `draft-${index}`);
    expect(session.getDraft(termId)).toBe("draft-99");
    session.flushRecovery();
    expect(parseRecovery(store.get(RECOVERY_KEY) ?? null).panes[termId]?.agent)
      .toMatchObject({ draft: "draft-99", images: [image] });
  });

  test("keeps a submitted prompt while a model change is still being negotiated", async () => {
    const termId = "recover-configuring";
    await session.start(termId, { ...grokLaunch, agent: "claude", program: "claudex", model: "old-model" }, "H:/project");
    session.configure(termId, "model", "new-model");
    session.submit(termId, "Do this after changing the model");
    session.flushRecovery();
    const saved = workspaceRecovery.get(termId)?.agent;
    expect(saved?.launch.model).toBe("new-model");
    expect(saved?.queued.map((entry) => entry.prompt.text)).toEqual(["Do this after changing the model"]);
  });

  test("recovers a blank Codex composer without trying to resume its unsaved provisional thread", async () => {
    const termId = "recover-blank-codex";
    await session.start(termId, codexLaunch, "H:/project");
    await codexHandshake("not-persisted-yet");
    session.setDraft(termId, "My first prompt");
    const saved = JSON.parse(JSON.stringify(workspaceRecovery.get(termId)?.agent));
    expect(saved.sessionId).toBeNull();
    session.stop(termId);
    sent.length = 0;
    await session.start(termId, { ...saved.launch, resumeId: saved.sessionId }, saved.cwd, saved);
    await codexHandshake("fresh-thread");
    expect(sent.map(rpc).some((message) => message.method === "thread/resume")).toBe(false);
    expect(session.getDraft(termId)).toBe("My first prompt");
    expect(session.readyForScheduledSend(termId)).toBe(true);
  });

  test("a rejected Codex resume cannot release an overdue draft into a fresh thread", async () => {
    const termId = "recover-missing-thread";
    await session.start(termId, codexLaunch, "H:/project");
    await codexHandshake("missing-thread");
    session.submit(termId, "Earlier prompt");
    session.setDraft(termId, "Scheduled follow-up");
    const saved = JSON.parse(JSON.stringify(workspaceRecovery.get(termId)?.agent));
    session.stop(termId);
    sent.length = 0;
    await session.start(termId, { ...saved.launch, resumeId: saved.sessionId }, saved.cwd, saved);
    await codexHandshake("fresh-thread");
    const resume = sent.map(rpc).find((message) => message.method === "thread/resume");
    feed({ id: resume?.id, error: { code: -1, message: "Thread is missing" } });
    await flush();
    expect(session.get(termId)?.status).toBe("error");
    expect(session.readyForScheduledSend(termId)).toBe(false);
    expect(session.getDraft(termId)).toBe("Scheduled follow-up");
    expect(workspaceRecovery.get(termId)?.agent?.sessionId).toBe("missing-thread");
    expect(session.get(termId)?.items.some((item) => item.kind === "user" && item.text === "Earlier prompt")).toBe(true);
    expect(sent.map(rpc).filter((message) => message.method === "turn/start")).toHaveLength(0);
  });

  test("recovers Claude's exact conversation, draft, images, wrapper and settings", async () => {
    const termId = "recover-claude";
    const launch: AgentLaunch = {
      ...grokLaunch, agent: "claude", program: "claudex", wrapperArgs: ["--g"],
      env: { EXAMPLE_PROVIDER: "local" }, model: "custom-model", effort: "high", accessMode: "full-access",
    };
    await session.start(termId, launch, "H:/specific-project");
    feed({ type: "system", subtype: "init", session_id: "exact-claude-session", model: "custom-model" });
    session.setDraft(termId, "Unsent prompt\nwith details");
    session.setDraftImages(termId, [image]);
    workspaceRecovery.update(termId, { timed: { at: 1234 } });
    const saved = JSON.parse(JSON.stringify(workspaceRecovery.get(termId)?.agent));
    session.stop(termId);
    sent.length = 0;
    await session.start(termId, { ...saved.launch, resumeId: saved.sessionId }, saved.cwd, saved);
    expect(spawn?.program).toBe("claudex");
    expect(spawn?.cwd).toBe("H:/specific-project");
    expect(spawn?.args).toContain("--g");
    expect(spawn?.args).toContain("--resume");
    expect(spawn?.args).toContain("exact-claude-session");
    expect(session.getDraft(termId)).toBe("Unsent prompt\nwith details");
    expect(session.getDraftImages(termId)).toEqual([image]);
    expect(session.get(termId)).toMatchObject({ model: "custom-model", effort: "high", accessMode: "full-access" });
    expect(workspaceRecovery.get(termId)?.timed).toEqual({ at: 1234 });
    expect(session.readyForScheduledSend(termId)).toBe(true);
    expect(sent.map(rpc).filter((message) => message.type === "user")).toHaveLength(0);
  });

  test("a failed recovery retains its draft and blocks scheduled delivery", async () => {
    const termId = "recover-failure";
    await session.start(termId, { ...grokLaunch, agent: "claude", program: "claude" }, "H:/project");
    session.setDraft(termId, "Keep this prompt");
    const saved = JSON.parse(JSON.stringify(workspaceRecovery.get(termId)?.agent));
    session.stop(termId);
    spawnFailure = "executable unavailable";
    await session.start(termId, saved.launch, saved.cwd, saved);
    expect(session.get(termId)?.status).toBe("error");
    expect(session.getDraft(termId)).toBe("Keep this prompt");
    expect(session.readyForScheduledSend(termId)).toBe(false);
    session.submit(termId, "Keep this prompt");
    expect(session.getDraft(termId)).toBe("Keep this prompt");
  });

  test("Codex recovery waits for the exact saved thread before releasing follow-ups", async () => {
    const termId = "recover-codex";
    await session.start(termId, codexLaunch, "H:/project");
    await codexHandshake("saved-thread");
    session.submit(termId, "Original turn");
    session.submit(termId, "Queued follow-up");
    session.setDraft(termId, "Scheduled draft");
    session.flushRecovery();
    const saved = JSON.parse(JSON.stringify(workspaceRecovery.get(termId)?.agent));
    expect(saved.queued).toHaveLength(1);
    session.stop(termId);
    sent.length = 0;
    await session.start(termId, { ...saved.launch, resumeId: saved.sessionId }, saved.cwd, saved);
    expect(session.readyForScheduledSend(termId)).toBe(false);
    await codexHandshake("temporary-thread");
    const resume = sent.map(rpc).find((message) => message.method === "thread/resume");
    expect(resume).toMatchObject({ params: { threadId: "saved-thread" } });
    expect(sent.map(rpc).filter((message) => message.method === "turn/start")).toHaveLength(0);
    session.flushRecovery();
    expect(workspaceRecovery.get(termId)?.agent?.sessionId).toBe("saved-thread");
    expect(session.getDraft(termId)).toBe("Scheduled draft");
    feed({ id: resume?.id, result: { thread: { id: "saved-thread", turns: [] } } });
    await flush();
    expect(sent.map(rpc).filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(session.getDraft(termId)).toBe("Scheduled draft");
  });

  test("restores prompt navigation from resumed Codex turns and replaces the previous conversation", async () => {
    const termId = "resumed-prompt-history";
    await session.start(termId, codexLaunch, "H:/project");
    await codexHandshake();
    for (const [threadId, prompts] of [
      ["old-one", ["First command", "Second command", "Second command"]],
      ["old-two", ["Different conversation"]],
    ] as const) {
      const resuming = session.resume(termId, threadId);
      await flush();
      const request = sent.map(rpc).findLast((message) => message.method === "thread/resume");
      feed({ id: request?.id, result: { thread: {
        id: threadId,
        turns: prompts.map((text, index) => ({
          id: `turn-${index}`, status: "completed",
          items: [{ type: "userMessage", id: `user-${index}`, content: [{ type: "text", text }] }],
        })),
      } } });
      await resuming;
      expect(session.localPromptHistory(termId)).toEqual([...new Set(prompts)]);
    }
    session.submit(termId, "New follow-up");
    expect(session.localPromptHistory(termId)).toEqual(["Different conversation", "New follow-up"]);
  });

  beforeEach(() => {
    sent.length = 0;
    spawn = null;
    frameSink = null;
    spawnFailure = null;
    session.setFollowupMode("queue");
    session.setCodexCapacityReply({ enabled: false, message: "continue" });
  });

  afterEach(() => {
    session.stopAll();
    session.setFollowupMode("queue");
    session.setCodexCapacityReply({ enabled: false, message: "continue" });
  });

  describe("automatic Codex capacity replies", () => {
    const capacityError = "Selected model is at capacity. Please try a different model.";
    const originalSetTimeout = stubWindow.setTimeout;
    const originalClearTimeout = stubWindow.clearTimeout;
    let now = 0;
    let timerId = -1;
    const timers = new Map<number, { at: number; callback: () => void }>();

    beforeEach(() => {
      now = 0;
      timerId = -1;
      timers.clear();
      stubWindow.setTimeout = ((callback: () => void, delay: number) => {
        if (delay !== 2000) return originalSetTimeout(callback, delay);
        const id = timerId--;
        timers.set(id, { at: now + delay, callback });
        return id;
      }) as typeof originalSetTimeout;
      stubWindow.clearTimeout = ((id: number) => {
        if (timers.delete(id)) return;
        originalClearTimeout(id);
      }) as typeof originalClearTimeout;
    });

    afterEach(() => {
      session.stopAll();
      stubWindow.setTimeout = originalSetTimeout;
      stubWindow.clearTimeout = originalClearTimeout;
      timers.clear();
    });

    function advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    }

    function starts(): Record<string, unknown>[] {
      return sent.map(rpc).filter((message) => message.method === "turn/start");
    }

    async function failPrompt(termId: string, message = capacityError): Promise<void> {
      session.submit(termId, "Do the work");
      feed({ id: starts().at(-1)?.id, error: { code: -32000, message } });
      await flush();
      expect(session.get(termId)?.status).toBe("idle");
    }

    test("is disabled by default", async () => {
      await session.start("capacity-default", codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt("capacity-default");
      advance(2000);
      expect(starts()).toHaveLength(1);
      expect(timers.size).toBe(0);
    });

    test("sends the custom message at two seconds and preserves the composer", async () => {
      const termId = "capacity-custom";
      session.setCodexCapacityReply({ enabled: true, message: "Please continue the task." });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt(termId);
      session.setDraft(termId, "My unfinished draft");
      session.setDraftImages(termId, [image]);
      advance(1999);
      expect(starts()).toHaveLength(1);
      advance(1);
      expect(starts()).toHaveLength(2);
      expect(starts().at(-1)?.params).toMatchObject({
        input: [{ type: "text", text: "Please continue the task." }],
      });
      expect(session.get(termId)?.items.at(-1)).toMatchObject({
        kind: "user", text: "Please continue the task.",
      });
      expect(session.getDraft(termId)).toBe("My unfinished draft");
      expect(session.getDraftImages(termId)).toEqual([image]);
      advance(2000);
      expect(starts()).toHaveLength(2);
    });

    test("replies once to duplicate failed-turn notifications", async () => {
      const termId = "capacity-completed";
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      session.submit(termId, "Do the work");
      feed({ id: starts().at(-1)?.id, result: { turn: { id: "failed-turn" } } });
      await flush();
      const completion = {
        method: "turn/completed",
        params: {
          threadId: session.get(termId)?.sessionId,
          turn: { id: "failed-turn", status: "failed", error: { message: capacityError } },
        },
      };
      feed(completion);
      feed(completion);
      expect(timers.size).toBe(1);
      await new Promise((resolve) => originalSetTimeout(resolve, 850));
      expect(session.get(termId)?.status).toBe("idle");
      advance(2000);
      expect(starts()).toHaveLength(2);
      feed(completion);
      advance(2000);
      expect(starts()).toHaveLength(2);
    });

    test("does not reply to other errors or blank configured messages", async () => {
      const termId = "capacity-filter";
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt(termId, "Rate limit exceeded");
      advance(2000);
      expect(starts()).toHaveLength(1);
      session.setCodexCapacityReply({ enabled: true, message: "  \n " });
      await failPrompt(termId);
      advance(2000);
      expect(starts()).toHaveLength(2);
    });

    test("cancels pending replies when disabled or edited without replaying the old error", async () => {
      const termId = "capacity-toggle";
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt(termId);
      advance(1000);
      session.setCodexCapacityReply({ enabled: false, message: "continue" });
      advance(1000);
      expect(starts()).toHaveLength(1);
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      advance(2000);
      expect(starts()).toHaveLength(1);
      await failPrompt(termId);
      session.setCodexCapacityReply({ enabled: true, message: "Another reply" });
      advance(2000);
      expect(starts()).toHaveLength(2);
    });

    test("cancels after a manual message even if that turn finishes before the timer", async () => {
      const termId = "capacity-manual";
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt(termId);
      await failPrompt(termId, "A different failure");
      advance(2000);
      expect(starts()).toHaveLength(2);
    });

    test("cancels when interrupted, closed, or replaced by a new chat", async () => {
      const termId = "capacity-lifecycle";
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt(termId);
      session.interrupt(termId);
      advance(2000);
      expect(starts()).toHaveLength(1);
      await failPrompt(termId);
      sent.length = 0;
      await session.newChat(termId);
      advance(2000);
      expect(starts()).toHaveLength(0);
      await codexHandshake();
      await failPrompt(termId);
      session.stop(termId);
      advance(2000);
      expect(starts()).toHaveLength(1);
    });

    test("replies again when the automatic follow-up receives a new capacity error", async () => {
      const termId = "capacity-repeat";
      session.setCodexCapacityReply({ enabled: true, message: "continue" });
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      await failPrompt(termId);
      advance(2000);
      feed({ id: starts().at(-1)?.id, error: { code: -32000, message: capacityError } });
      await flush();
      advance(1999);
      expect(starts()).toHaveLength(2);
      advance(1);
      expect(starts()).toHaveLength(3);
    });
  });

  async function signedOutCodex(termId: string, launch = codexLaunch): Promise<void> {
    await session.start(termId, launch, "H:/project");
    await flush();
    feed({ id: sent.map(rpc).find((message) => message.method === "initialize")?.id, result: {} });
    await flush();
    feed({ id: "duckweed-account-read", result: { account: null, requiresOpenaiAuth: true } });
    await flush();
  }

  async function externalCodexLogin(): Promise<void> {
    feed({ method: "account/updated", params: { authMode: "chatgpt" } });
    feed({ id: "duckweed-account-sync", result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
    await flush();
    const opened = sent.map(rpc).findLast((message) => message.method === "thread/start");
    feed({ id: opened?.id, result: { thread: { id: "signed-in-thread" }, model: "gpt-5" } });
    await flush();
  }

  test("holds an opening prompt while signed out and releases it after CLI login", async () => {
    const termId = "codex-login-queue";
    await signedOutCodex(termId, { ...codexLaunch, prompt: "Inspect the project" });
    expect(session.get(termId)).toMatchObject({ status: "idle", authenticationRequired: true });
    session.flushRecovery();
    expect(workspaceRecovery.get(termId)?.agent?.queued).toHaveLength(1);
    expect(session.readyForScheduledSend(termId)).toBe(false);
    expect(sent.map(rpc).some((message) => message.method === "turn/start")).toBe(false);
    await externalCodexLogin();
    expect(sent.map(rpc).filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(session.get(termId)?.pending).toHaveLength(0);
  });

  test("keeps a rejected signed-out submission and its image in the composer", async () => {
    const termId = "codex-login-draft";
    await signedOutCodex(termId);
    session.setDraft(termId, "Keep this draft");
    session.setDraftImages(termId, [image]);
    expect(session.submit(termId, "Keep this draft", [image])).toBe(false);
    expect(session.getDraft(termId)).toBe("Keep this draft");
    expect(session.getDraftImages(termId)).toEqual([image]);
  });

  test("uses protocol logout without replacing the Codex pane with a terminal", async () => {
    const termId = "codex-protocol-logout";
    const handoffs: session.AgentAuthRequest[] = [];
    const unsubscribe = session.subscribeAuthRequest((request) => handoffs.push(request));
    try {
      await session.start(termId, codexLaunch, "H:/project");
      await codexHandshake();
      expect(session.submit(termId, "/logout")).toBe(true);
      const logout = sent.map(rpc).find((message) => message.method === "account/logout");
      expect(logout).toBeDefined();
      feed({ id: logout?.id, result: {} });
      await flush();
      feed({ id: "duckweed-account-sync", result: { account: null, requiresOpenaiAuth: true } });
      await flush();
      expect(session.get(termId)).toMatchObject({ status: "idle", authenticationRequired: true });
      expect(handoffs).toHaveLength(0);
    } finally { unsubscribe(); }
  });

  test("waits for sign-in before resuming the user's chosen thread", async () => {
    const termId = "codex-resume-after-login";
    await signedOutCodex(termId);
    await session.resume(termId, "stored-thread");
    expect(sent.map(rpc).some((message) => message.method === "thread/resume")).toBe(false);
    await externalCodexLogin();
    expect(sent.map(rpc).find((message) => message.method === "thread/resume")?.params)
      .toMatchObject({ threadId: "stored-thread" });
    expect(sent.map(rpc).some((message) => message.method === "turn/start")).toBe(false);
  });

  test("restores the draft and attachments after a credential service reload", async () => {
    const termId = "codex-auth-reconnect";
    await session.start(termId, codexLaunch, "H:/project");
    await codexHandshake();
    session.submit(termId, "An earlier prompt");
    const turn = sent.map(rpc).find((message) => message.method === "turn/start");
    feed({ id: turn?.id, result: { turn: { id: "saved-turn" } } });
    feed({ method: "turn/completed", params: { threadId: "01900000-0000-7000-8000-000000000001", turn: { id: "saved-turn", status: "completed", items: [] } } });
    await new Promise((resolve) => setTimeout(resolve, 850));
    session.setDraft(termId, "Continue after login");
    session.setDraftImages(termId, [image]);
    const before = sent.map(rpc).filter((message) => message.method === "initialize").length;
    frameSink?.({ kind: "exit", code: 0, reconnect: true });
    for (let count = 0; count < 10; count++) await flush();
    expect(sent.map(rpc).filter((message) => message.method === "initialize")).toHaveLength(before + 1);
    expect(session.getDraft(termId)).toBe("Continue after login");
    expect(session.getDraftImages(termId)).toEqual([image]);
    expect(session.get(termId)?.status).toBe("starting");
    await codexHandshake("temporary-thread");
    const resume = sent.map(rpc).findLast((message) => message.method === "thread/resume");
    expect(resume?.params).toMatchObject({ threadId: "01900000-0000-7000-8000-000000000001" });
    expect(session.getDraft(termId)).toBe("Continue after login");
  });

  test.each(["steer", "queue"] as const)("preserves Codex background activity after an async question in %s mode", async (mode) => {
    const termId = `codex-async-${mode}`;
    const threadId = "async-thread";
    expect(await session.start(termId, codexLaunch, "H:/project")).toBeNull();
    await codexHandshake(threadId);
    session.setFollowupMode(mode);
    session.submit(termId, "Update the website");
    await flush();
    const start = sent.map(rpc).find((message) => message.method === "turn/start");
    feed({ id: start?.id, result: { turn: { id: "background" } } });
    feed({ method: "turn/started", params: { threadId, turn: { id: "background", status: "inProgress" } } });
    feed({
      method: "item/completed",
      params: { threadId, turnId: "background", item: {
        id: "question", type: "agentMessage", phase: "final_answer", delivery: "async",
        text: "Where are the reference images?", questions: [{ title: "Where are the reference images?" }],
      } },
    });
    // Reproduce a human reply after the production completion quiet window.
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(session.get(termId)?.status).toBe("working");
    session.submit(termId, "The images are in Assets");
    await flush();
    expect(sent.map(rpc).filter((message) => message.method === "turn/start")).toHaveLength(1);
    if (mode === "steer") {
      const steer = sent.map(rpc).find((message) => message.method === "turn/steer");
      expect(steer).toMatchObject({ params: { threadId, expectedTurnId: "background" } });
      feed({ id: steer?.id, result: { turnId: "background" } });
      await flush();
      expect(session.get(termId)?.pending).toHaveLength(0);
    } else {
      expect(session.get(termId)?.pending).toHaveLength(1);
    }
    feed({ method: "item/started", params: { threadId, turnId: "background", item: {
      id: "inspect", type: "commandExecution", command: "rg --files Assets", status: "inProgress",
    } } });
    feed({ method: "item/agentMessage/delta", params: {
      threadId, turnId: "background", itemId: "progress", delta: "Inspecting the images.",
    } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.get(termId)?.status).toBe("working");
    expect(session.get(termId)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", command: "rg --files Assets", status: "running" }),
      expect.objectContaining({ kind: "assistant", text: "Inspecting the images." }),
    ]));
    feed({ method: "turn/completed", params: { threadId, turn: { id: "background", status: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(session.get(termId)?.status).toBe(mode === "queue" ? "working" : "idle");
    expect(sent.map(rpc).filter((message) => message.method === "turn/start")).toHaveLength(mode === "queue" ? 2 : 1);
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
