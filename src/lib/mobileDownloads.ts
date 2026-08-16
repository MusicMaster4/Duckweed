import type { Channel } from "./version";

export const COMPANION_STABLE_URL =
  "https://github.com/MusicMaster4/Duckweed/releases/latest/download/duckweed-companion.apk";
export const COMPANION_BETA_URL =
  "https://github.com/MusicMaster4/Duckweed/releases/download/channel-testing/duckweed-companion-beta.apk";

export function companionApkUrl(channel: Channel): string {
  return channel === "testing" ? COMPANION_BETA_URL : COMPANION_STABLE_URL;
}
