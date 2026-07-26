const COMPLETION_SOUND_URL = new URL(
  "../../assets/completion_sound.ogg",
  import.meta.url,
).href;

let audio: HTMLAudioElement | null = null;

function completionAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (!audio) {
    audio = new Audio(COMPLETION_SOUND_URL);
    audio.preload = "auto";
  }
  return audio;
}

/** Decode the short effect ahead of the first process completion when possible. */
export function preloadCompletionSound(): void {
  completionAudio()?.load();
}

/**
 * Signal a completion once. Rewinding the shared player coalesces simultaneous
 * completions into one clean cue instead of stacking several copies.
 */
export function playCompletionSound(): void {
  const player = completionAudio();
  if (!player) return;
  player.currentTime = 0;
  void player.play().catch(() => {
    // Some preview browsers block media until the first user gesture. Process
    // activity and the visual completion marker must continue regardless.
  });
}
