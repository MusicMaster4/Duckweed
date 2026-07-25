/**
 * Builds the `latest.json` the Tauri updater reads, from the signed artifacts
 * `tauri build` just produced.
 *
 *   bun scripts/updater-manifest.mjs --version 1.2.3 --tag v1.2.3 \
 *     [--repo owner/name] [--notes "…"] [--bundle-dir …] [--out latest.json]
 *
 * Each updater artifact is written next to a `.sig` file holding its detached
 * signature; the manifest pairs the two and points at the copy uploaded to the
 * release. Windows-only for now — add entries here when other targets ship.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUNDLE_DIR = "src-tauri/target/release/bundle";

/** Updater artifacts produced by the NSIS bundler, newest naming first. */
const WINDOWS_ARTIFACT = /-setup\.exe(\.zip)?$|\.nsis\.zip$/;

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
 * The manifest body. Throws when no Windows artifact was found, so a build that
 * silently produced nothing installable can never be published as an update.
 */
export function buildManifest({ version, repo, tag, notes = "", pubDate = new Date().toISOString(), assets }) {
  if (!parseVersion(version)) throw new Error(`not a Duckweed version: ${version}`);
  const windows = assets.find((asset) => WINDOWS_ARTIFACT.test(asset.name));
  if (!windows) {
    throw new Error(`no signed Windows installer among: ${assets.map((a) => a.name).join(", ") || "(none)"}`);
  }
  const entry = { signature: windows.signature, url: downloadUrl(repo, tag, windows.name) };
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: { "windows-x86_64": entry, "windows-x86_64-nsis": entry },
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
  console.log(`${args.out} → ${manifest.platforms["windows-x86_64"].url}`);
}

if (import.meta.main) main();
