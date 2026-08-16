/** Builds the channel-bound update feed consumed by Duckweed Companion. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function androidAssetName(channel) {
  if (channel === "stable") return "duckweed-companion.apk";
  if (channel === "testing") return "duckweed-companion-beta.apk";
  throw new Error(`unsupported Android update channel: ${channel}`);
}

export function androidManifestName(channel) {
  return channel === "testing" ? "android-update-beta.json" : "android-update.json";
}

export function buildAndroidUpdateManifest({
  channel,
  versionName,
  versionCode,
  repo,
  tag,
  sha256,
  publishedAt = new Date().toISOString(),
}) {
  const parsedCode = Number(versionCode);
  if (!Number.isSafeInteger(parsedCode) || parsedCode < 1) throw new Error("versionCode must be a positive integer");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("sha256 must contain 64 hexadecimal characters");
  const asset = androidAssetName(channel);
  return {
    schemaVersion: 1,
    channel,
    versionName,
    versionCode: parsedCode,
    apkUrl: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${asset}`,
    sha256: sha256.toLowerCase(),
    publishedAt,
  };
}

export function parseAndroidManifestArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "MusicMaster4/Duckweed",
    bundleDir: "release-assets",
  };
  const keys = {
    "--channel": "channel",
    "--version": "versionName",
    "--version-code": "versionCode",
    "--repo": "repo",
    "--tag": "tag",
    "--bundle-dir": "bundleDir",
    "--out": "out",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]];
    if (!key) throw new Error(`unknown argument: ${argv[index]}`);
    args[key] = argv[++index];
  }
  for (const key of ["channel", "versionName", "versionCode", "tag"]) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  args.out ||= androidManifestName(args.channel);
  return args;
}

function main() {
  const args = parseAndroidManifestArgs(process.argv.slice(2));
  const bundleDir = path.isAbsolute(args.bundleDir) ? args.bundleDir : path.join(ROOT, args.bundleDir);
  const apk = path.join(bundleDir, androidAssetName(args.channel));
  const sha256 = createHash("sha256").update(readFileSync(apk)).digest("hex");
  const manifest = buildAndroidUpdateManifest({ ...args, sha256 });
  const out = path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out);
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path.relative(ROOT, out)} -> ${manifest.versionName} (${manifest.channel})`);
}

if (import.meta.main) main();
