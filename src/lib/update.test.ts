import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * The app-side channel guard. The Tauri plugins are mocked, so these tests
 * exercise exactly what src/lib/update.ts decides once a manifest is in hand:
 * a build must never install an update from the other channel, however the
 * manifest it was served describes itself.
 */

let served = null; // what the updater plugin reports, or null for "up to date"
let servedLength = 200; // Content-Length of the download; undefined when unknown
let installed = 0;
let relaunched = 0;
let currentVersion = "1.0.0";

mock.module("@tauri-apps/api/app", () => ({ getVersion: async () => currentVersion }));
mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: async () => {
    relaunched += 1;
  },
}));
mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () =>
    served && {
      ...served,
      downloadAndInstall: async (onEvent) => {
        installed += 1;
        onEvent?.({ event: "Started", data: { contentLength: servedLength } });
        onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
        onEvent?.({ event: "Finished" });
      },
    },
}));

/** Fresh import each time: update.ts caches the running version. */
async function updateModule(version) {
  currentVersion = version;
  const module = await import(`./update.ts?v=${Math.random()}`);
  return module;
}

afterEach(() => {
  served = null;
  servedLength = 200;
  installed = 0;
  relaunched = 0;
});

describe("what the app accepts as an update", () => {
  test("a stable install takes a newer stable release", async () => {
    served = { version: "1.0.1", body: "notes", date: "2026-01-01" };
    const { checkForUpdate } = await updateModule("1.0.0");
    const update = await checkForUpdate();
    expect(update?.version).toBe("1.0.1");
    expect(update?.notes).toBe("notes");
  });

  test("a stable install refuses a beta, even a newer one", async () => {
    served = { version: "9.9.9-testing.1" };
    const { checkForUpdate } = await updateModule("1.0.0");
    expect(await checkForUpdate()).toBeNull();
  });

  test("a beta install takes a newer beta", async () => {
    served = { version: "1.0.1-testing.2" };
    const { checkForUpdate } = await updateModule("1.0.1-testing.1");
    expect((await checkForUpdate())?.version).toBe("1.0.1-testing.2");
  });

  test("a beta install refuses a stable release", async () => {
    served = { version: "1.0.1" };
    const { checkForUpdate } = await updateModule("1.0.1-testing.1");
    expect(await checkForUpdate()).toBeNull();
  });

  test("nothing to install when the plugin reports no update", async () => {
    served = null;
    const { checkForUpdate } = await updateModule("1.0.0");
    expect(await checkForUpdate()).toBeNull();
  });

  test("a manifest with a version we cannot read is ignored", async () => {
    served = { version: "2026.07-nightly" };
    const { checkForUpdate } = await updateModule("1.0.0");
    expect(await checkForUpdate()).toBeNull();
  });
});

describe("installing", () => {
  test("reports progress and hands over to the installer", async () => {
    served = { version: "1.0.1" };
    const { checkForUpdate } = await updateModule("1.0.0");
    const update = await checkForUpdate();
    const seen = [];
    await update.install((fraction) => seen.push(fraction));
    expect(installed).toBe(1);
    expect(seen).toEqual([0, 0.5, 1]);
    expect(relaunched).toBe(1);
  });

  test("a download of unknown size reports indeterminate progress, not 0%", async () => {
    served = { version: "1.0.1" };
    servedLength = undefined;
    const { checkForUpdate } = await updateModule("1.0.0");
    const update = await checkForUpdate();
    const seen = [];
    await update.install((fraction) => seen.push(fraction));
    expect(seen).toEqual([null, null, 1]);
  });

  test("progress is optional", async () => {
    served = { version: "1.0.1" };
    const { checkForUpdate } = await updateModule("1.0.0");
    await (await checkForUpdate()).install();
    expect(installed).toBe(1);
  });
});

describe("channel labelling", () => {
  test("names the channel the build belongs to", async () => {
    const { channelLabel } = await updateModule("1.0.0");
    expect(channelLabel("1.0.0")).toBe("stable");
    expect(channelLabel("1.0.1-testing.3")).toBe("beta");
  });
});
