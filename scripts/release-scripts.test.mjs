import { describe, expect, test } from "bun:test";

import {
  BETA_POINTER_TAG,
  endpointFor,
  parseArgs as parseApplyArgs,
  withCargoLockVersion,
  withCargoVersion,
  withPackageVersion,
  withTauriConfig,
} from "./apply-version.mjs";
import { parseArgs as parseVersionArgs } from "./release-version.mjs";
import {
  REQUIRED_PLATFORMS,
  buildManifest,
  collectAssets,
  downloadUrl,
  platformsForAsset,
} from "./updater-manifest.mjs";

const REPO = "MusicMaster4/Duckweed";

describe("update endpoints", () => {
  test("stable rides GitHub's latest-release redirect, which skips prereleases", () => {
    expect(endpointFor("stable", REPO)).toBe(`https://github.com/${REPO}/releases/latest/download/latest.json`);
  });

  test("beta reads a manifest that only beta builds ever write", () => {
    expect(endpointFor("testing", REPO)).toBe(
      `https://github.com/${REPO}/releases/download/${BETA_POINTER_TAG}/latest.json`,
    );
  });

  test("the two channels can never resolve to the same manifest", () => {
    expect(endpointFor("stable", REPO)).not.toBe(endpointFor("testing", REPO));
  });
});

describe("stamping the version", () => {
  const config = {
    productName: "Duckweed",
    version: "0.1.0",
    plugins: { updater: { pubkey: "PUBKEY", endpoints: ["https://example.invalid/x.json"], windows: { installMode: "passive" } } },
  };

  test("package.json keeps everything but the version", () => {
    expect(withPackageVersion({ name: "duckweed", version: "0.1.0" }, "1.2.3")).toEqual({
      name: "duckweed",
      version: "1.2.3",
    });
  });

  test("a beta build is pointed at the beta manifest", () => {
    const next = withTauriConfig(config, { version: "1.2.3-testing.4", channel: "testing", repo: REPO });
    expect(next.version).toBe("1.2.3-testing.4");
    expect(next.plugins.updater.endpoints).toEqual([endpointFor("testing", REPO)]);
    expect(next.plugins.updater.pubkey).toBe("PUBKEY");
    expect(next.plugins.updater.windows).toEqual({ installMode: "passive" });
    expect(next.productName).toBe("Duckweed");
    expect(config.version).toBe("0.1.0"); // input untouched
  });

  test("a stable build is pointed at the stable manifest", () => {
    const next = withTauriConfig(config, { version: "1.2.3", channel: "stable", repo: REPO });
    expect(next.plugins.updater.endpoints).toEqual([endpointFor("stable", REPO)]);
  });

  test("exactly one endpoint is configured, so a build cannot fall back to the other channel", () => {
    for (const channel of ["stable", "testing"]) {
      const next = withTauriConfig(config, { version: "1.2.3", channel, repo: REPO });
      expect(next.plugins.updater.endpoints).toHaveLength(1);
    }
  });

  test("Cargo.toml: only the [package] version moves", () => {
    const toml = [
      "[package]",
      'name = "duckweed"',
      'version = "0.1.0"',
      "",
      "[dependencies]",
      'tauri = { version = "2", features = [] }',
      'serde_json = "1"',
      "",
      "[profile.release]",
      "lto = true",
      "",
    ].join("\n");
    const next = withCargoVersion(toml, "1.2.3-testing.4");
    expect(next).toContain('version = "1.2.3-testing.4"');
    expect(next).toContain('tauri = { version = "2", features = [] }');
    expect(next.match(/^version = /gm)).toHaveLength(1);
  });

  test("Cargo.toml without a package version is an error", () => {
    expect(() => withCargoVersion('[dependencies]\nserde = "1"\n', "1.2.3")).toThrow();
  });

  test("Cargo.lock: only our crate's entry moves", () => {
    const lock = [
      "[[package]]",
      'name = "duckweed"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "dunce"',
      'version = "0.1.0"',
      "",
    ].join("\n");
    const next = withCargoLockVersion(lock, "duckweed", "1.2.3");
    expect(next).toContain('name = "duckweed"\nversion = "1.2.3"');
    expect(next).toContain('name = "dunce"\nversion = "0.1.0"');
  });

  test("Cargo.lock: a missing crate is an error rather than a no-op", () => {
    expect(() => withCargoLockVersion("[[package]]\n", "duckweed", "1.2.3")).toThrow();
  });
});

describe("release script arguments", () => {
  test("the channel is inferred from the version", () => {
    expect(parseApplyArgs(["--version", "1.2.3"]).channel).toBe("stable");
    expect(parseApplyArgs(["--version", "1.2.3-testing.4"]).channel).toBe("testing");
  });

  test("a version that disagrees with the channel is refused", () => {
    expect(() => parseApplyArgs(["--version", "1.2.3", "--channel", "testing"])).toThrow();
    expect(() => parseApplyArgs(["--version", "1.2.3-testing.1", "--channel", "stable"])).toThrow();
  });

  test("a malformed version is refused before anything is written", () => {
    expect(() => parseApplyArgs(["--version", "1.2"])).toThrow();
    expect(() => parseApplyArgs([])).toThrow();
  });

  test("version resolution defaults to a patch bump and rejects unknown channels", () => {
    expect(parseVersionArgs(["--channel", "testing"])).toMatchObject({ channel: "testing", bump: "patch" });
    // workflow_dispatch inputs arrive empty on a push event
    expect(parseVersionArgs(["--channel", "stable", "--bump", ""])).toMatchObject({ bump: "patch" });
    expect(() => parseVersionArgs(["--channel", "nightly"])).toThrow();
    expect(() => parseVersionArgs(["--bump", "huge"])).toThrow();
  });

  test("the release branch decides the channel, and no other branch releases", () => {
    expect(parseVersionArgs(["--branch", "main"]).channel).toBe("stable");
    expect(parseVersionArgs(["--branch", "testing"]).channel).toBe("testing");
    for (const branch of ["master", "develop", "feature/updates", "release/1.0"]) {
      expect(() => parseVersionArgs(["--branch", branch])).toThrow();
    }
  });
});

describe("updater manifest", () => {
  const assetsFor = (version, windowsName = `Duckweed_${version}_x64-setup.exe`) => [
    { name: windowsName, signature: "WINDOWS_SIGNATURE" },
    { name: `Duckweed_${version}_amd64.AppImage`, signature: "LINUX_SIGNATURE" },
    { name: `Duckweed_${version}_amd64.deb`, signature: "DEB_SIGNATURE" },
    { name: `Duckweed_${version}_universal.app.tar.gz`, signature: "MACOS_SIGNATURE" },
  ];
  const assets = assetsFor("1.2.3");

  test("points every official target at its signed artifact on the release", () => {
    const manifest = buildManifest({ version: "1.2.3", repo: REPO, tag: "v1.2.3", notes: "hi", assets });
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.notes).toBe("hi");
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "WINDOWS_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Duckweed_1.2.3_x64-setup.exe`,
    });
    expect(manifest.platforms["linux-x86_64"]).toEqual({
      signature: "LINUX_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Duckweed_1.2.3_amd64.AppImage`,
    });
    expect(manifest.platforms["linux-x86_64-appimage"]).toEqual(manifest.platforms["linux-x86_64"]);
    expect(manifest.platforms["linux-x86_64-deb"]).toEqual({
      signature: "DEB_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Duckweed_1.2.3_amd64.deb`,
    });
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "MACOS_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Duckweed_1.2.3_universal.app.tar.gz`,
    });
    expect(manifest.platforms["darwin-x86_64"]).toEqual(manifest.platforms["darwin-aarch64"]);
    expect(manifest.platforms["darwin-aarch64-app"]).toEqual(manifest.platforms["darwin-aarch64"]);
    expect(manifest.platforms["darwin-x86_64-app"]).toEqual(manifest.platforms["darwin-x86_64"]);
    expect(manifest.platforms["windows-x86_64-nsis"]).toEqual(manifest.platforms["windows-x86_64"]);
    expect(REQUIRED_PLATFORMS.every((platform) => manifest.platforms[platform])).toBe(true);
    expect(Date.parse(manifest.pub_date)).not.toBeNaN();
  });

  test("beta manifests carry the beta version, so only beta installs accept them", () => {
    const manifest = buildManifest({
      version: "1.2.3-testing.4",
      repo: REPO,
      tag: "v1.2.3-testing.4",
      assets: assetsFor("1.2.3-testing.4"),
    });
    expect(manifest.version).toBe("1.2.3-testing.4");
    expect(manifest.platforms["windows-x86_64"].url).toContain("v1.2.3-testing.4");
    expect(manifest.platforms["linux-x86_64"].url).toContain("v1.2.3-testing.4");
    expect(manifest.platforms["darwin-aarch64"].url).toContain("v1.2.3-testing.4");
  });

  test("accepts the zipped installer layout too", () => {
    for (const name of ["Duckweed_1.2.3_x64-setup.exe.zip", "Duckweed_1.2.3_x64.nsis.zip"]) {
      const manifest = buildManifest({
        version: "1.2.3",
        repo: REPO,
        tag: "v1.2.3",
        assets: assetsFor("1.2.3", name),
      });
      expect(manifest.platforms["windows-x86_64"].url).toContain(name);
    }
  });

  test("recognises universal and architecture-specific native updater artifacts", () => {
    expect(platformsForAsset("Duckweed_1.2.3_amd64.AppImage")).toEqual([
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
    expect(platformsForAsset("Duckweed_1.2.3_arm64.AppImage")).toEqual([
      "linux-aarch64",
      "linux-aarch64-appimage",
    ]);
    expect(platformsForAsset("Duckweed_1.2.3_amd64.deb")).toEqual(["linux-x86_64-deb"]);
    expect(platformsForAsset("Duckweed_1.2.3_universal.app.tar.gz")).toEqual([
      "darwin-x86_64",
      "darwin-x86_64-app",
      "darwin-aarch64",
      "darwin-aarch64-app",
    ]);
    expect(platformsForAsset("Duckweed_1.2.3_aarch64.app.tar.gz")).toEqual([
      "darwin-aarch64",
      "darwin-aarch64-app",
    ]);
    expect(platformsForAsset("Duckweed_1.2.3_x86_64.app.tar.gz")).toEqual([
      "darwin-x86_64",
      "darwin-x86_64-app",
    ]);
  });

  test("a partial or ambiguous matrix refuses to publish a manifest", () => {
    expect(() => buildManifest({ version: "1.2.3", repo: REPO, tag: "v1.2.3", assets: [] })).toThrow();
    expect(() =>
      buildManifest({ version: "1.2.3", repo: REPO, tag: "v1.2.3", assets: [{ name: "notes.txt", signature: "S" }] }),
    ).toThrow();
    expect(() =>
      buildManifest({
        version: "1.2.3",
        repo: REPO,
        tag: "v1.2.3",
        assets: [...assets, { ...assets[1], name: "Duckweed_1.2.3_x86_64.AppImage" }],
      }),
    ).toThrow(/multiple signed updater artifacts for linux-x86_64/);
  });

  test("a version we do not recognise never reaches a manifest", () => {
    expect(() => buildManifest({ version: "1.2.3-beta.1", repo: REPO, tag: "x", assets })).toThrow();
  });

  test("spaces in a release asset name survive the URL", () => {
    expect(downloadUrl(REPO, "v1.0.0", "Duck weed_setup.exe")).toBe(
      `https://github.com/${REPO}/releases/download/v1.0.0/Duck%20weed_setup.exe`,
    );
  });

  test("collects one asset per .sig file and ignores everything else", () => {
    const files = ["nsis/Duckweed_1.2.3_x64-setup.exe", "nsis/Duckweed_1.2.3_x64-setup.exe.sig", "nsis/notes.txt"];
    const assets = collectAssets("bundle", {
      readdir: () => files,
      readFile: (file) => (file.includes("setup.exe.sig") ? "SIG\n" : "?"),
    });
    expect(assets).toEqual([{ name: "Duckweed_1.2.3_x64-setup.exe", signature: "SIG" }]);
  });
});
