import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const originalAudio = globalThis.Audio;
const originalWindow = globalThis.window;
const gestureListeners = new Map<string, Set<() => void>>();
const players: FakeAudio[] = [];

class FakeAudio {
  src: string;
  currentTime = 19;
  preload = "";
  readyState = 4; // HAVE_ENOUGH_DATA
  muted = false;
  loads = 0;
  plays = 0;
  pauses = 0;
  playError: Error | null = null;

  constructor(src: string) {
    this.src = src;
    players.push(this);
  }

  load() {
    this.loads += 1;
  }

  pause() {
    this.pauses += 1;
  }

  play() {
    this.plays += 1;
    return this.playError ? Promise.reject(this.playError) : Promise.resolve();
  }
}

beforeAll(() => {
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
});

afterAll(() => {
  if (originalAudio === undefined) delete (globalThis as { Audio?: unknown }).Audio;
  else (globalThis as { Audio?: unknown }).Audio = originalAudio;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

/** A stand-in for the Tauri IPC bridge `invoke()` talks to. */
function fakeTauriRuntime(invoke: (command: string) => Promise<unknown>) {
  const calls: string[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string) => {
        calls.push(command);
        return invoke(command);
      },
    },
    // The WebView fallback binds gesture listeners before it plays.
    addEventListener(name: string, listener: () => void) {
      const listeners = gestureListeners.get(name) ?? new Set();
      listeners.add(listener);
      gestureListeners.set(name, listeners);
    },
    removeEventListener(name: string, listener: () => void) {
      gestureListeners.get(name)?.delete(listener);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
  return calls;
}

function clearTauriRuntime() {
  delete (globalThis as { window?: unknown }).window;
}

function totalPlays(): number {
  return players.reduce((total, player) => total + player.plays, 0);
}

/** Let the invoke promise and its handlers settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("completion sound", () => {
  test("preloads every cue and randomly chooses one for each completion", async () => {
    const originalRandom = Math.random;
    const randomValues = [0, 0.999, 0.5];
    Math.random = () => randomValues.shift() ?? 0;

    try {
      const sound = await import("./completionSound");
      sound.preloadCompletionSound();
      sound.playCompletionSound();
      sound.playCompletionSound();
      sound.playCompletionSound();

      expect(players).toHaveLength(6);
      expect(players.map((player) => player.src)).toEqual([
        expect.stringContaining("completion_sound_A.ogg"),
        expect.stringContaining("completion_sound_C.ogg"),
        expect.stringContaining("completion_sound_C2.ogg"),
        expect.stringContaining("completion_sound_D.ogg"),
        expect.stringContaining("completion_sound_E.ogg"),
        expect.stringContaining("completion_sound_G.ogg"),
      ]);
      expect(players.every((player) => player.preload === "auto")).toBe(true);
      expect(players.every((player) => player.loads === 1)).toBe(true);
      expect(players.map((player) => player.plays)).toEqual([1, 0, 0, 1, 0, 1]);
      // Every selected cue starts from the beginning.
      expect(players[0].currentTime).toBe(0);
      expect(players[3].currentTime).toBe(0);
      expect(players[5].currentTime).toBe(0);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("plays through the app process when the native player answers", async () => {
    const sound = await import("./completionSound");
    const calls = fakeTauriRuntime(() => Promise.resolve(null));

    try {
      const playsBefore = totalPlays();
      // Nothing to warm up: the native player reads the cues from the binary.
      sound.preloadCompletionSound();
      sound.playCompletionSound();
      await flush();

      expect(calls).toEqual(["play_completion_sound"]);
      expect(players.every((player) => player.loads === 1)).toBe(true);
      // The WebView stays silent, so no msedgewebview2 audio session appears.
      expect(totalPlays()).toBe(playsBefore);
    } finally {
      clearTauriRuntime();
    }
  });

  test("falls back for a temporary failure and recovers native playback on the next cue", async () => {
    const sound = await import("./completionSound");
    let deviceAvailable = false;
    const calls = fakeTauriRuntime(() => deviceAvailable
      ? Promise.resolve(null)
      : Promise.reject(new Error("no output")));

    try {
      const playsBefore = totalPlays();
      sound.playCompletionSound(0);
      await flush();

      expect(calls).toEqual(["play_completion_sound"]);
      expect(totalPlays()).toBe(playsBefore + 1);
      expect(gestureListeners.get("keydown")?.size).toBe(1);

      deviceAvailable = true;
      const pausesBefore = players[0].pauses;
      sound.playCompletionSound(1);
      await flush();
      expect(calls).toHaveLength(2);
      expect(totalPlays()).toBe(playsBefore + 1);
      expect(players[0].pauses).toBe(pausesBefore + 1);
    } finally {
      clearTauriRuntime();
    }
  });

  test("continues falling back while native audio is unavailable", async () => {
    const sound = await import("./completionSound");
    const calls = fakeTauriRuntime(() => Promise.reject(new Error("no output")));
    try {
      const playsBefore = totalPlays();
      sound.playCompletionSound(2);
      await flush();
      sound.playCompletionSound(3);
      await flush();
      expect(calls).toHaveLength(2);
      expect(totalPlays()).toBe(playsBefore + 2);
    } finally {
      clearTauriRuntime();
    }
  });

  test("ignores an old native rejection after a newer cue succeeded", async () => {
    const sound = await import("./completionSound");
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise((_, reject) => { rejectOld = reject; });
    let request = 0;
    const calls = fakeTauriRuntime(() => ++request === 1 ? oldRequest : Promise.resolve(null));
    try {
      const playsBefore = totalPlays();
      sound.playCompletionSound(0);
      sound.playCompletionSound(1);
      await flush();
      rejectOld(new Error("output was temporarily unavailable"));
      await flush();
      expect(calls).toHaveLength(2);
      expect(totalPlays()).toBe(playsBefore);
    } finally {
      clearTauriRuntime();
    }
  });

  test("ignores an old native rejection after a newer cue fell back", async () => {
    const sound = await import("./completionSound");
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise((_, reject) => { rejectOld = reject; });
    let request = 0;
    fakeTauriRuntime(() => ++request === 1 ? oldRequest : Promise.reject(new Error("no output")));
    try {
      const playsBefore = totalPlays();
      sound.playCompletionSound(0);
      sound.playCompletionSound(1);
      await flush();
      expect(totalPlays()).toBe(playsBefore + 1);
      const pausesBefore = players[1].pauses;
      rejectOld(new Error("old output failure"));
      await flush();
      expect(totalPlays()).toBe(playsBefore + 1);
      expect(players[1].pauses).toBe(pausesBefore);
    } finally {
      clearTauriRuntime();
    }
  });

  test("rebinds gesture unlock if fallback autoplay becomes blocked again", async () => {
    const sound = await import("./completionSound");
    fakeTauriRuntime(() => Promise.reject(new Error("no output")));
    try {
      sound.playCompletionSound(0);
      await flush();
      // A successful play previously unlocked the WebView. The next gesture
      // removes those listeners, as it would in a real running app.
      for (const listener of gestureListeners.get("keydown") ?? []) listener();
      expect(gestureListeners.get("keydown")?.size).toBe(0);

      players[1].playError = new Error("autoplay blocked after interruption");
      sound.playCompletionSound(1);
      await flush();
      expect(gestureListeners.get("keydown")?.size).toBe(1);
      players[1].playError = null;
      for (const listener of gestureListeners.get("keydown") ?? []) listener();
      await flush();
      expect(gestureListeners.get("keydown")?.size).toBe(0);
    } finally {
      players[1].playError = null;
      clearTauriRuntime();
    }
  });

});
