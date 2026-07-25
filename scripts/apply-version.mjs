/**
 * Stamps a resolved version onto the project and points the built app at the
 * update channel it belongs to.
 *
 *   bun scripts/apply-version.mjs --version 1.2.3-testing.4 --channel testing \
 *     [--repo MusicMaster4/Duckweed]
 *
 * Touches package.json, src-tauri/tauri.conf.json (version + updater
 * endpoints), src-tauri/Cargo.toml and the app's entry in src-tauri/Cargo.lock.
 * The workflows run this on a throwaway checkout — nothing is committed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { channelOf, parseVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = "duckweed";
export const DEFAULT_REPO = "MusicMaster4/Duckweed";

/**
 * Where a build of `channel` looks for updates.
 *
 * Stable rides GitHub's own "latest release" redirect, which by definition
 * skips prereleases. Beta manifests live on a fixed prerelease (tag
 * `channel-testing`) whose only asset is rewritten by every beta build. Neither
 * URL can ever serve the other channel's manifest, which is what keeps the two
 * populations of installs apart.
 */
export function endpointFor(channel, repo = DEFAULT_REPO) {
  return channel === "testing"
    ? `https://github.com/${repo}/releases/download/channel-testing/latest.json`
    : `https://github.com/${repo}/releases/latest/download/latest.json`;
}

/** Tag of the permanent release that carries the beta channel manifest. */
export const BETA_POINTER_TAG = "channel-testing";

export function withPackageVersion(pkg, version) {
  return { ...pkg, version };
}

export function withTauriConfig(config, { version, channel, repo = DEFAULT_REPO }) {
  const updater = { ...(config.plugins?.updater ?? {}), endpoints: [endpointFor(channel, repo)] };
  return { ...config, version, plugins: { ...(config.plugins ?? {}), updater } };
}

/** Rewrites the `version` of the `[package]` table only. */
export function withCargoVersion(text, version) {
  let inPackage = false;
  let replaced = false;
  const lines = text.split("\n").map((line) => {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) inPackage = section[1] === "package";
    else if (inPackage && !replaced && /^\s*version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  if (!replaced) throw new Error("no [package] version found in Cargo.toml");
  return lines.join("\n");
}

/** Rewrites the version of a single `[[package]]` entry in Cargo.lock. */
export function withCargoLockVersion(text, crate, version) {
  const pattern = new RegExp(`(name = "${crate}"\\r?\\n)version = "[^"]*"`);
  if (!pattern.test(text)) throw new Error(`crate ${crate} not found in Cargo.lock`);
  return text.replace(pattern, `$1version = "${version}"`);
}

export function parseArgs(argv) {
  const args = { repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "--channel" || arg === "--repo") args[arg.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.version || !parseVersion(args.version)) {
    throw new Error(`--version must be X.Y.Z or X.Y.Z-testing.N, got: ${args.version}`);
  }
  // The channel is implied by the version; an explicit one must agree with it.
  const implied = channelOf(args.version);
  if (!args.channel) args.channel = implied;
  if (args.channel !== implied) {
    throw new Error(`version ${args.version} belongs to the ${implied} channel, not ${args.channel}`);
  }
  return args;
}

function editJson(file, edit) {
  const abs = path.join(ROOT, file);
  const value = edit(JSON.parse(readFileSync(abs, "utf8")));
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
}

function editText(file, edit) {
  const abs = path.join(ROOT, file);
  writeFileSync(abs, edit(readFileSync(abs, "utf8")));
}

function main() {
  const { version, channel, repo } = parseArgs(process.argv.slice(2));

  editJson("package.json", (pkg) => withPackageVersion(pkg, version));
  editJson("src-tauri/tauri.conf.json", (config) => withTauriConfig(config, { version, channel, repo }));
  editText("src-tauri/Cargo.toml", (text) => withCargoVersion(text, version));
  editText("src-tauri/Cargo.lock", (text) => withCargoLockVersion(text, CRATE, version));

  console.log(`version ${version} applied (channel: ${channel}, endpoint: ${endpointFor(channel, repo)})`);
}

if (import.meta.main) main();
