import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

const originalAudio = globalThis.Audio;
const players = [];

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.currentTime = 19;
    this.preload = "";
    this.readyState = 4; // HAVE_ENOUGH_DATA
    this.muted = false;
    this.loads = 0;
    this.plays = 0;
    this.pauses = 0;
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
  globalThis.Audio = FakeAudio;
});

afterAll(() => {
  if (originalAudio === undefined) delete globalThis.Audio;
  else globalThis.Audio = originalAudio;
});

describe("completion sound", () => {
  test("preloads and reuses the bundled sound player", async () => {
    const sound = await import("../src/lib/completionSound.ts");
    sound.preloadCompletionSound();
    sound.playCompletionSound();
    sound.playCompletionSound();

    expect(players).toHaveLength(1);
    expect(players[0].src).toContain("completion_sound.ogg");
    expect(players[0].preload).toBe("auto");
    expect(players[0].loads).toBe(1);
    expect(players[0].plays).toBe(2);
    expect(players[0].currentTime).toBe(0);
  });

  test("the preference is persisted and defaults on for older saves", () => {
    const persist = read("src/lib/persist.ts");
    expect(persist).toContain("completionSoundEnabled: boolean");
    expect(persist).toContain(
      'typeof parsed.completionSoundEnabled === "boolean" ? parsed.completionSoundEnabled : true',
    );
    expect(persist).toContain("completionSoundEnabled: state.completionSoundEnabled");
  });

  test("sound requires the selected pane and a job longer than one minute", () => {
    const app = read("src/App.tsx");
    const signal = app.indexOf("if (!shouldSignalCompletion(previous, meta)) return;");
    const soundGate = app.indexOf("shouldPlayCompletionSound(previous, meta)", signal);
    const sound = app.indexOf("playCompletionSound();", signal);
    const selectedGate = app.indexOf("isSelectedTerm(termId)", signal);
    const focusGate = app.indexOf("isFocusedTerm(termId)", signal);
    expect(signal).toBeGreaterThan(-1);
    expect(soundGate).toBeGreaterThan(signal);
    expect(selectedGate).toBeGreaterThan(signal);
    expect(selectedGate).toBeLessThan(sound);
    expect(soundGate).toBeLessThan(sound);
    // Flash/unread still use document focus; sound must not.
    expect(focusGate).toBeGreaterThan(sound);
  });
});
