/**
 * Builds the `latest.json` the Tauri updater reads, from the signed artifacts
 * `tauri build` just produced.
 *
 *   bun scripts/updater-manifest.mjs --version 1.2.3 --tag v1.2.3 \
 *     [--repo owner/name] [--notes "…"] [--bundle-dir …] [--out latest.json]
 *
 * Each updater artifact is written next to a `.sig` file holding its detached
 * signature; the manifest pairs the two and points at the copy uploaded to the
 * release. The release workflow stages all native builds into one directory so
 * this script can refuse to publish unless every official updater target is
 * present.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUNDLE_DIR = "src-tauri/target/release/bundle";

/** Updater artifacts produced by each platform bundler. */
const WINDOWS_ARTIFACT = /-setup\.exe(\.zip)?$|\.nsis\.zip$/;
const LINUX_ARTIFACT = /\.AppImage(?:\.tar\.gz)?$/;
const DEB_ARTIFACT = /\.deb$/;
const MACOS_ARTIFACT = /\.app\.tar\.gz$/;

export const REQUIRED_PLATFORMS = [
  "windows-x86_64",
  "windows-x86_64-nsis",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "darwin-aarch64",
  "darwin-aarch64-app",
];

export function downloadUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

/**
 * Collects `{ name, signature }` for every signed artifact under `dir`.
 * `readFile` is injected so the tests can run without touching a disk.
 */
export function collectAssets(dir, { readdir = readdirSync, readFile } = {}) {
  const read = readFile ?? ((file) => readFileSync(file, "utf8"));
  const entries = readdir(dir, { recursive: true, withFileTypes: false });
  return entries
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".sig"))
    .map((entry) => ({
      name: entry.slice(entry.lastIndexOf("/") + 1, -".sig".length),
      signature: read(path.join(dir, entry)).trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Infer the updater targets encoded in a staged release asset name.
 *
 * Tauri's macOS updater archive normally omits the architecture, so the release
 * workflow gives its universal build a `_universal` suffix before staging it.
 */
export function platformsForAsset(name) {
  if (WINDOWS_ARTIFACT.test(name)) return ["windows-x86_64", "windows-x86_64-nsis"];
  if (LINUX_ARTIFACT.test(name)) {
    if (/(?:aarch64|arm64)/i.test(name)) return ["linux-aarch64", "linux-aarch64-appimage"];
    return ["linux-x86_64", "linux-x86_64-appimage"];
  }
  if (DEB_ARTIFACT.test(name)) {
    if (/(?:aarch64|arm64)/i.test(name)) return ["linux-aarch64-deb"];
    return ["linux-x86_64-deb"];
  }
  if (MACOS_ARTIFACT.test(name)) {
    if (/universal/i.test(name)) {
      return ["darwin-x86_64", "darwin-x86_64-app", "darwin-aarch64", "darwin-aarch64-app"];
    }
    if (/(?:aarch64|arm64)/i.test(name)) return ["darwin-aarch64", "darwin-aarch64-app"];
    if (/(?:x86_64|x64|amd64)/i.test(name)) return ["darwin-x86_64", "darwin-x86_64-app"];
  }
  return [];
}

/**
 * The manifest body. Throws when an official target is missing or ambiguous, so
 * a partial matrix can never become a release that strands existing installs.
 */
export function buildManifest({ version, repo, tag, notes = "", pubDate = new Date().toISOString(), assets }) {
  if (!parseVersion(version)) throw new Error(`not a Duckweed version: ${version}`);
  const platforms = {};

  for (const asset of assets) {
    const entry = { signature: asset.signature, url: downloadUrl(repo, tag, asset.name) };
    for (const platform of platformsForAsset(asset.name)) {
      if (platforms[platform]) {
        throw new Error(`multiple signed updater artifacts for ${platform}`);
      }
      platforms[platform] = entry;
    }
  }

  const missing = REQUIRED_PLATFORMS.filter((platform) => !platforms[platform]);
  if (missing.length) {
    throw new Error(
      `missing signed updater artifacts for ${missing.join(", ")} among: ${
        assets.map((asset) => asset.name).join(", ") || "(none)"
      }`,
    );
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

export function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "MusicMaster4/Duckweed",
    bundleDir: DEFAULT_BUNDLE_DIR,
    out: "latest.json",
    notes: "",
  };
  const keys = { "--version": "version", "--tag": "tag", "--repo": "repo", "--notes": "notes", "--bundle-dir": "bundleDir", "--out": "out" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    args[key] = argv[++i];
  }
  if (!args.version) throw new Error("--version is required");
  if (!args.tag) args.tag = `v${args.version}`;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.isAbsolute(args.bundleDir) ? args.bundleDir : path.join(ROOT, args.bundleDir);
  const assets = collectAssets(dir);
  const manifest = buildManifest({ ...args, assets });
  writeFileSync(path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${args.out} → ${REQUIRED_PLATFORMS.length} updater platforms`);
}

if (import.meta.main) main();
