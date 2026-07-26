import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { channelOf, isUpdateFor, type Channel } from "./version";

/**
 * The app's half of the update system.
 *
 * A build only ever knows one update endpoint — the workflow compiles it in
 * from the branch that produced the build — so a stable install is physically
 * unable to fetch the beta manifest, and vice versa. The channel check here is
 * the second lock on the same door: whatever a manifest claims, an update is
 * only offered when it belongs to the channel the running build was installed
 * from.
 */

export type { Channel };

/** Short label for the running build's channel. */
export function channelLabel(version: string): string {
  return channelOf(version) === "testing" ? "beta" : "stable";
}

let cached: string | null = null;

/** Version of the running binary (not of package.json). */
export async function appVersion(): Promise<string> {
  if (cached === null) cached = await getVersion();
  return cached;
}

export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
  /**
   * Downloads and runs the installer. `onProgress` gets a 0..1 fraction, or
   * null while the download size is still unknown.
   *
   * On Windows this hands over to the (per-user, so no admin prompt) installer
   * and the app exits — the installer restarts it. The relaunch below is for
   * the platforms where the process survives.
   */
  install: (onProgress?: (fraction: number | null) => void) => Promise<void>;
}

/** null when the app is already up to date on its own channel. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const current = await appVersion();
  const update = await check();
  if (!update) return null;
  if (!isUpdateFor(current, update.version)) return null;

  return {
    version: update.version,
    notes: update.body ?? null,
    date: update.date ?? null,
    install: async (onProgress) => {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          onProgress?.(total > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          onProgress?.(total > 0 ? Math.min(1, received / total) : null);
        } else if (event.event === "Finished") {
          onProgress?.(1);
        }
      });
      await relaunch();
    },
  };
}
