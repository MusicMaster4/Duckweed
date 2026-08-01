import { invoke } from "@tauri-apps/api/core";

import { mergeHistoryRaw } from "./historyMerge";

const TAURI_RUNTIME =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const COMMAND_HISTORY_KEY = "duckweed:command-history:v1";

export const DURABLE_KEYS = [
  "duckweed:state:v1",
  "duckweed:usage:v1",
  "duckweed:suggest-feedback:v1",
  // Per-tab checklists. These are the user's own notes rather than app state,
  // so an update that changes the WebView origin must not lose them.
  "duckweed:checklist:v1",
  // Model, reasoning, and access choices for each custom agent CLI.
  "duckweed:agent-preferences:v1",
  // Named pane arrangements and their optional startup commands.
  "duckweed:layouts:v1",
  // Focused time, daily limit, and the local day it belongs to.
  "duckweed:wellbeing:v1",
  // 70% pool cooldown history for greetings, ASCII loaders, preparing lines,
  // and thinking-pulse patterns. Survives updates so the same joke is not
  // drawn again the moment the WebView reloads.
  "duckweed:cooldown-pools:v1",
  COMMAND_HISTORY_KEY,
] as const;

export type DurableKey = (typeof DURABLE_KEYS)[number];

/**
 * Restore Duckweed-owned localStorage from the native app-data copy before
 * modules read their initial state. On the first run after this feature is
 * installed, seed the native copy from the existing WebView storage instead.
 *
 * Command history is unioned rather than overwritten: an installed build and a
 * dev build see different WebView origins, so each side can hold commands the
 * other never saw. Ghost-text history must outlive updates, not ping-pong.
 *
 * Each key is restored independently: one save rejection must not skip history
 * or other durable rows later in the list.
 */
export async function restoreDurableStorage(): Promise<void> {
  if (!TAURI_RUNTIME) return;
  let saved: Record<string, string>;
  try {
    saved = await invoke<Record<string, string>>("settings_load");
  } catch (error) {
    // The WebView copy remains usable if native storage is temporarily
    // unavailable. Do not prevent the terminal from starting.
    console.error("failed to load durable settings", error);
    return;
  }

  for (const key of DURABLE_KEYS) {
    try {
      const nativeValue = saved[key];
      const existing = localStorage.getItem(key);

      if (key === COMMAND_HISTORY_KEY) {
        if (nativeValue === undefined && existing === null) continue;
        const merged = mergeHistoryRaw(nativeValue, existing);
        localStorage.setItem(key, merged);
        await invoke("settings_save", { key, value: merged });
        continue;
      }

      if (typeof nativeValue === "string") {
        localStorage.setItem(key, nativeValue);
      } else if (existing !== null) {
        await invoke("settings_save", { key, value: existing });
      }
    } catch (error) {
      console.error(`failed to restore durable setting ${key}`, error);
    }
  }
}

/**
 * Mirror a WebView value into the stable per-user app-data directory.
 *
 * Command history merges into the stored copy unless `replace` is set, so a
 * stale snapshot can never delete commands another window just recorded.
 */
export function saveDurably(
  key: DurableKey,
  value: string,
  options?: { replace?: boolean },
): void {
  if (!TAURI_RUNTIME) return;
  void invoke("settings_save", { key, value, replace: options?.replace ?? false }).catch(
    (error) => {
      console.error("failed to save durable settings", error);
    },
  );
}
