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
  test("preloads and reuses the bundled sound player", async () => {
    const sound = await import("./completionSound");
    sound.preloadCompletionSound();
    sound.playCompletionSound();
    sound.playCompletionSound();

    expect(players).toHaveLength(1);
    expect(players[0].src).toContain("completion_sound.ogg");
    expect(players[0].preload).toBe("auto");
    expect(players[0].loads).toBe(1);
    expect(players[0].plays).toBe(2);
    // Replayed from the top rather than resuming where the last play ended.
    expect(players[0].currentTime).toBe(0);
  });
});
