import { describe, expect, test } from "bun:test";

import {
  androidAssetName,
  androidManifestName,
  buildAndroidUpdateManifest,
  parseAndroidManifestArgs,
} from "./android-update-manifest.mjs";

const HASH = "a".repeat(64);

describe("Android update manifest", () => {
  test("stable and beta use isolated permanent feed names", () => {
    expect(androidManifestName("stable")).toBe("android-update.json");
    expect(androidManifestName("testing")).toBe("android-update-beta.json");
    expect(androidAssetName("stable")).toBe("duckweed-companion.apk");
    expect(androidAssetName("testing")).toBe("duckweed-companion-beta.apk");
  });

  test("points an update at the signed release APK", () => {
    expect(
      buildAndroidUpdateManifest({
        channel: "testing",
        versionName: "1.2.3-testing.4",
        versionCode: "42",
        repo: "MusicMaster4/Duckweed",
        tag: "v1.2.3-testing.4",
        sha256: HASH,
        publishedAt: "2026-08-16T00:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: 1,
      channel: "testing",
      versionName: "1.2.3-testing.4",
      versionCode: 42,
      apkUrl:
        "https://github.com/MusicMaster4/Duckweed/releases/download/v1.2.3-testing.4/duckweed-companion-beta.apk",
      sha256: HASH,
      publishedAt: "2026-08-16T00:00:00.000Z",
    });
  });

  test("derives the output filename from the channel", () => {
    expect(
      parseAndroidManifestArgs([
        "--channel", "testing",
        "--version", "1.2.3-testing.4",
        "--version-code", "42",
        "--tag", "v1.2.3-testing.4",
      ]).out,
    ).toBe("android-update-beta.json");
  });
});
