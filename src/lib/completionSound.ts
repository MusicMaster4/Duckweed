const COMPLETION_SOUND_URL = new URL(
  "../../assets/completion_sound.ogg",
  import.meta.url,
).href;

/** Numeric readyState floors — avoid depending on HTMLMediaElement in tests. */
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

let audio: HTMLAudioElement | null = null;
/** True after a successful play (or silent unlock) under a user gesture. */
let unlocked = false;
let unlockBound = false;
/** Bumps so a late `canplay` retry cannot restart a superseded cue. */
let playGeneration = 0;

function completionAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (!audio) {
    audio = new Audio(COMPLETION_SOUND_URL);
    audio.preload = "auto";
  }
  return audio;
}

function safeRewind(player: HTMLAudioElement): void {
  try {
    if (player.readyState >= HAVE_METADATA) {
      player.currentTime = 0;
    }
  } catch {
    // InvalidStateError when the element has no usable timeline yet.
  }
}

function bindGestureUnlock(): void {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;

  const onGesture = () => {
    if (unlocked) {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      return;
    }
    const player = completionAudio();
    if (!player) return;

    // Silent play under a real gesture unlocks autoplay for later cues.
    const wasMuted = player.muted;
    player.muted = true;
    void player
      .play()
      .then(() => {
        player.pause();
        safeRewind(player);
        player.muted = wasMuted;
        unlocked = true;
        window.removeEventListener("pointerdown", onGesture, true);
        window.removeEventListener("keydown", onGesture, true);
      })
      .catch(() => {
        player.muted = wasMuted;
      });
  };

  // Capture phase so terminal keystrokes and pane clicks unlock audio too.
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
}

function attemptPlay(player: HTMLAudioElement, generation: number): void {
  if (generation !== playGeneration) return;

  // Pause + rewind avoids racing a previous play() promise on the shared element.
  try {
    player.pause();
  } catch {
    // ignore
  }
  safeRewind(player);

  void player
    .play()
    .then(() => {
      unlocked = true;
    })
    .catch(() => {
      if (generation !== playGeneration) return;

      // Decode not finished yet — wait once, then try again.
      if (player.readyState < HAVE_CURRENT_DATA) {
        const onReady = () => {
          player.removeEventListener("canplay", onReady);
          if (generation !== playGeneration) return;
          safeRewind(player);
          void player
            .play()
            .then(() => {
              unlocked = true;
            })
            .catch(() => {
              // Autoplay still blocked, or the asset failed. Visual markers continue.
            });
        };
        player.addEventListener("canplay", onReady);
        window.setTimeout(() => {
          player.removeEventListener("canplay", onReady);
        }, 3_000);
        return;
      }
      // Policy / decode failure: keep listening for a gesture so the next cue works.
      bindGestureUnlock();
    });
}

/** Decode the short effect ahead of the first process completion when possible. */
export function preloadCompletionSound(): void {
  bindGestureUnlock();
  const player = completionAudio();
  if (!player) return;
  try {
    player.load();
  } catch {
    // ignore
  }
}

/**
 * Signal a completion once. Rewinding the shared player coalesces simultaneous
 * completions into one clean cue instead of stacking several copies.
 */
export function playCompletionSound(): void {
  bindGestureUnlock();
  const player = completionAudio();
  if (!player) return;
  const generation = ++playGeneration;
  attemptPlay(player, generation);
}
