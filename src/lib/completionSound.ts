import { playCompletionCue } from "./ipc";

const COMPLETION_SOUND_URLS = [
  new URL("../../assets/completion_sound_A.ogg", import.meta.url).href,
  new URL("../../assets/completion_sound_C.ogg", import.meta.url).href,
  new URL("../../assets/completion_sound_C2.ogg", import.meta.url).href,
  new URL("../../assets/completion_sound_D.ogg", import.meta.url).href,
  new URL("../../assets/completion_sound_E.ogg", import.meta.url).href,
  new URL("../../assets/completion_sound_G.ogg", import.meta.url).href,
] as const;

/** Numeric readyState floors. Avoid depending on HTMLMediaElement in tests. */
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

let audioPlayers: HTMLAudioElement[] | null = null;
let activePlayer: HTMLAudioElement | null = null;
/** Cleared for the session once the native player reports it cannot play. */
let nativePlayerUsable = true;
/** True after a successful play (or silent unlock) under a user gesture. */
let unlocked = false;
let unlockBound = false;
/** Bumps so a late `canplay` retry cannot restart a superseded cue. */
let playGeneration = 0;

function completionAudios(): HTMLAudioElement[] {
  if (typeof Audio === "undefined") return [];
  if (!audioPlayers) {
    audioPlayers = COMPLETION_SOUND_URLS.map((url) => {
      const player = new Audio(url);
      player.preload = "auto";
      return player;
    });
  }
  return audioPlayers;
}

function randomCompletionAudio(): HTMLAudioElement | null {
  const players = completionAudios();
  if (players.length === 0) return null;
  return players[Math.floor(Math.random() * players.length)] ?? null;
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
    const players = completionAudios();
    if (players.length === 0) return;

    // Silent plays under a real gesture unlock autoplay for every cue.
    const attempts = players.map(async (player) => {
      const wasMuted = player.muted;
      player.muted = true;
      try {
        await player.play();
        player.pause();
        safeRewind(player);
        return true;
      } catch {
        return false;
      } finally {
        player.muted = wasMuted;
      }
    });

    void Promise.all(attempts).then((results) => {
      if (results.every(Boolean)) {
        unlocked = true;
        window.removeEventListener("pointerdown", onGesture, true);
        window.removeEventListener("keydown", onGesture, true);
      }
    });
  };

  // Capture phase so terminal keystrokes and pane clicks unlock audio too.
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
}

function attemptPlay(player: HTMLAudioElement, generation: number): void {
  if (generation !== playGeneration) return;

  // Stop the previous cue so simultaneous completions still coalesce cleanly.
  if (activePlayer) {
    try {
      activePlayer.pause();
    } catch {
      // ignore
    }
    safeRewind(activePlayer);
  }
  activePlayer = player;
  safeRewind(player);

  void player
    .play()
    .then(() => {
      unlocked = true;
    })
    .catch(() => {
      if (generation !== playGeneration) return;

      // Decode not finished yet. Wait once, then try again.
      if (player.readyState < HAVE_CURRENT_DATA) {
        const onReady = () => {
          player.removeEventListener("canplay", onReady);
          if (generation !== playGeneration || activePlayer !== player) return;
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

/**
 * Whether the cue should come from the app process rather than the WebView.
 *
 * WebView audio belongs to the shared WebView2 runtime on Windows, so the
 * volume mixer files these cues under "Microsoft Edge WebView2" with Edge's
 * icon. The native player owns its audio session, so the mixer shows Duckweed.
 */
function nativePlayerAvailable(): boolean {
  return (
    nativePlayerUsable &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

/** Play one cue in the WebView, the fallback for browsers and dead devices. */
function playInWebView(): void {
  bindGestureUnlock();
  const player = randomCompletionAudio();
  if (!player) return;
  const generation = ++playGeneration;
  attemptPlay(player, generation);
}

/** Decode the short effects ahead of the first process completion when possible. */
export function preloadCompletionSound(): void {
  // The native player reads the cues straight out of the binary, so there is
  // nothing to warm up until the WebView has to take over.
  if (nativePlayerAvailable()) return;
  bindGestureUnlock();
  for (const player of completionAudios()) {
    try {
      player.load();
    } catch {
      // ignore
    }
  }
}

/**
 * Signal a completion once with a randomly selected cue. Simultaneous
 * completions restart the cue instead of stacking several copies.
 */
export function playCompletionSound(): void {
  if (nativePlayerAvailable()) {
    void playCompletionCue().catch(() => {
      // No output device the app process can open, or an older build without
      // the command. Hand the rest of the session to the WebView so
      // completions stay audible even with the wrong name in the mixer.
      nativePlayerUsable = false;
      playInWebView();
    });
    return;
  }
  playInWebView();
}
