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
});
