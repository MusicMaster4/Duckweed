import { describe, expect, test } from "bun:test";

import {
  COMPANION_BETA_URL,
  COMPANION_STABLE_URL,
  companionApkUrl,
} from "./mobileDownloads";

describe("Android companion downloads", () => {
  test("stable follows GitHub's newest non-prerelease release", () => {
    expect(companionApkUrl("stable")).toBe(COMPANION_STABLE_URL);
    expect(COMPANION_STABLE_URL).toContain("/releases/latest/download/duckweed-companion.apk");
  });

  test("beta follows the permanent beta pointer release", () => {
    expect(companionApkUrl("testing")).toBe(COMPANION_BETA_URL);
    expect(COMPANION_BETA_URL).toContain("/releases/download/channel-testing/");
  });
});
