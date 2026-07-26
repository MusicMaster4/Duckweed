import { invoke } from "@tauri-apps/api/core";

const TAURI_RUNTIME =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const DURABLE_KEYS = [
  "duckweed:state:v1",
  "duckweed:usage:v1",
  "duckweed:command-history:v1",
] as const;

/**
 * Restore Duckweed-owned localStorage from the native app-data copy before
 * modules read their initial state. On the first run after this feature is
 * installed, seed the native copy from the existing WebView storage instead.
 */
export async function restoreDurableStorage(): Promise<void> {
  if (!TAURI_RUNTIME) return;
  try {
    const saved = await invoke<Record<string, string>>("settings_load");
    for (const key of DURABLE_KEYS) {
      const nativeValue = saved[key];
      if (typeof nativeValue === "string") {
        localStorage.setItem(key, nativeValue);
      } else {
        const existing = localStorage.getItem(key);
        if (existing !== null) await invoke("settings_save", { key, value: existing });
      }
    }
  } catch (error) {
    // The WebView copy remains usable if native storage is temporarily
    // unavailable. Do not prevent the terminal from starting.
    console.error("failed to restore durable settings", error);
  }
}

/** Mirror a WebView value into the stable per-user app-data directory. */
export function saveDurably(key: (typeof DURABLE_KEYS)[number], value: string): void {
  if (!TAURI_RUNTIME) return;
  void invoke("settings_save", { key, value }).catch((error) => {
    console.error("failed to save durable settings", error);
  });
}
