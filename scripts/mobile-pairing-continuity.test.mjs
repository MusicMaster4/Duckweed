import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

describe("mobile pairing continuity", () => {
  test("updates keep the Android package and encrypted credential locations stable", () => {
    const build = read("android/app/build.gradle.kts");
    const secrets = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/SecretStore.kt",
    );

    expect(build).toContain('applicationId = "dev.slop.duckweed.companion"');
    expect(secrets).toContain('ALIAS = "duckweed-companion-pairing"');
    expect(secrets).toContain('PREFERENCES = "duckweed-secure-pairing"');
    expect(secrets).toContain('VALUE = "credentials"');
  });

  test("desktop updates keep the application data and keyring identities stable", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    const push = read("src-tauri/src/mobile_push.rs");

    expect(config.identifier).toBe("dev.slop.duckweed");
    expect(push).toContain(
      'const KEYRING_SERVICE: &str = "dev.slop.duckweed.mobile";',
    );
    expect(push).toContain('dir.join("mobile-notifications.json")');
  });

  test("the companion refreshes push routing from the retained pairing on launch", () => {
    const activity = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MainActivity.kt",
    );

    expect(activity).toContain("refreshPushRegistration()\n        refreshRemoteState()");
    expect(activity).toContain("RelayClient.refreshFcmToken(pairing, token)");
  });

  test("opening the companion clears its delivered notifications", () => {
    const activity = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MainActivity.kt",
    );
    const notifications = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/NotificationTools.kt",
    );

    expect(activity).toContain(
      "override fun onResume() {\n        super.onResume()\n        NotificationTools.cancelAll(this)",
    );
    expect(notifications).toContain(
      "NotificationManagerCompat.from(context).cancelAll()",
    );
  });
});
