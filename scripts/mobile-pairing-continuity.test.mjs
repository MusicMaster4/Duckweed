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

  test("logging responses is independent from notification delivery", () => {
    const service = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/DuckweedMessagingService.kt",
    );
    const activity = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MainActivity.kt",
    );
    const store = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MessageStore.kt",
    );

    expect(service.indexOf("store.put(preview)")).toBeLessThan(
      service.indexOf("NotificationPreference.isEnabled(this)"),
    );
    expect(service).toContain("store.markNotified(preview.id, preview.sentAt)");
    expect(activity).toContain("store.dismissPendingNotifications()");
    expect(activity).toContain("latestForOpenAgents(openAgentTerminals, 50)");
    expect(store).toContain("fun latestForOpenAgents(");
    expect(store).toContain(".take(limit.coerceIn(1, 50))");
  });

  test("workspace state can refresh automatically and on a phone gesture", () => {
    const desktop = read("src/App.tsx");
    const activity = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MainActivity.kt",
    );
    const relay = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/RelayClient.kt",
    );
    const build = read("android/app/build.gradle.kts");

    expect(desktop).toContain('window.addEventListener("duckweed:mobile-refresh", paired)');
    expect(desktop).toContain("}, 30_000);");
    expect(desktop).toContain('command.kind === "refresh"');
    expect(activity).toContain("setOnRefreshListener { requestRemoteRefresh() }");
    expect(relay).toContain('put("kind", "refresh")');
    expect(build).toContain("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0");
  });

  test("workspace snapshots retain compact readable conversation history", () => {
    const desktop = read("src/App.tsx");
    const worker = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MessageFetchWorker.kt",
    );
    const store = read(
      "android/app/src/main/java/dev/slop/duckweed/companion/MessageStore.kt",
    );

    expect(desktop).toContain("remainingConversationChars = 120_000");
    expect(desktop).toContain('.slice(-6)');
    expect(desktop).toContain('item.kind === "assistant" && !item.streaming');
    expect(worker).toContain("putSyncedConversation(message.workspace)");
    expect(store).toContain("fun putSyncedConversation(snapshot: WorkspaceSnapshot)");
  });

  test("desktop pairing rows reconcile phone-side disconnects", () => {
    const settings = read("src/components/MobileNotificationsSettings.tsx");
    const push = read("src-tauri/src/mobile_push.rs");

    expect(settings).toContain("window.setInterval(refresh, 5_000)");
    expect(push).toContain("Reconcile local rows whenever Settings asks");
    expect(push).toContain("Local removal is authoritative and idempotent");
  });
});
