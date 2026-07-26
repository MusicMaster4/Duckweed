/**
 * Resolves the version the next release should carry, from the tags already in
 * the repository. Run by both release workflows; run it locally with
 * `--dry-run` to see what the next release would be called.
 *
 *   bun scripts/release-version.mjs --channel testing [--bump patch|minor|major]
 *
 * Prints `version=…`, `tag=…` and `channel=…`, and appends the same lines to
 * $GITHUB_OUTPUT when running inside Actions.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { channelForBranch, resolveVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const args = { channel: "stable", bump: "patch" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--channel" || arg === "--bump" || arg === "--branch") args[arg.slice(2)] = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  // An empty string arrives when a workflow forwards an input that was not set.
  if (!args.bump) args.bump = "patch";
  // `--branch` is how the workflow enforces "only these two branches release":
  // anything else stops the run here instead of publishing to a channel.
  if (args.branch) {
    const channel = channelForBranch(args.branch);
    if (!channel) throw new Error(`branch ${args.branch} does not publish releases (only main and testing do)`);
    args.channel = channel;
  }
  if (!["stable", "testing"].includes(args.channel)) {
    throw new Error(`--channel must be stable or testing, got: ${args.channel}`);
  }
  if (!["patch", "minor", "major"].includes(args.bump)) {
    throw new Error(`--bump must be patch, minor or major, got: ${args.bump}`);
  }
  return args;
}

function gitTags() {
  return execFileSync("git", ["tag", "--list"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const version = resolveVersion({
    channel: args.channel,
    tags: gitTags(),
    packageVersion,
    level: args.bump,
  });

  const output = [`version=${version}`, `tag=v${version}`, `channel=${args.channel}`];
  console.log(output.join("\n"));
  if (process.env.GITHUB_OUTPUT && !args.dryRun) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`);
  }
}

if (import.meta.main) main();
