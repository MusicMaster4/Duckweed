import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const originalAudio = globalThis.Audio;
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
    return Promise.resolve();
  }
}

beforeAll(() => {
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
});

afterAll(() => {
  if (originalAudio === undefined) delete (globalThis as { Audio?: unknown }).Audio;
  else (globalThis as { Audio?: unknown }).Audio = originalAudio;
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
    addEventListener() {},
    removeEventListener() {},
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

  // Runs last: the fallback is sticky for the rest of the session.
  test("falls back to the WebView when the app process cannot play", async () => {
    const sound = await import("./completionSound");
    const calls = fakeTauriRuntime(() => Promise.reject(new Error("no output")));

    try {
      const playsBefore = totalPlays();
      sound.playCompletionSound();
      await flush();

      expect(calls).toEqual(["play_completion_sound"]);
      expect(totalPlays()).toBe(playsBefore + 1);

      // Later completions go straight to the WebView instead of retrying.
      sound.playCompletionSound();
      await flush();
      expect(calls).toHaveLength(1);
      expect(totalPlays()).toBe(playsBefore + 2);
    } finally {
      clearTauriRuntime();
    }
  });
});
