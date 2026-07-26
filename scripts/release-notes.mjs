/**
 * Writes the "What's Changed" section of a stable release. The commits since
 * the previous stable tag are handed to an OpenRouter chat model, which turns
 * them into a changelog written for the people using the app.
 *
 *   OPENROUTER_API_KEY=sk-or-… bun scripts/release-notes.mjs \
 *     --tag v1.0.4 [--repo MusicMaster4/Duckweed] [--model google/gemini-2.5-flash]
 *
 * Prints the changelog markdown to stdout. The clone needs the release tags
 * (actions/checkout with fetch-depth: 0) to find the previous stable tag; with
 * none — the first stable release — every commit up to --tag is analysed. The
 * model comes from --model, then $OPENROUTER_MODEL, then DEFAULT_MODEL below.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { compareVersions, formatVersion, parseTags, parseVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Used when neither --model nor the OPENROUTER_MODEL variable is set. */
export const DEFAULT_MODEL = "google/gemini-2.5-flash";
/** Prompt budget: the oldest commits beyond these limits are dropped. */
export const MAX_COMMITS = 250;
export const MAX_CHARS = 16000;
export const MAX_BODY_CHARS = 1000;

const SYSTEM_PROMPT = `You write the "What's Changed" section for Duckweed stable releases.

Duckweed is a local terminal workspace for Windows (Tauri: React/TypeScript + Rust). Users open a project folder and work with real shells, coding agents (Claude Code, Codex, Gemini CLI, …), Git context, diffs, tabs, and panes — no cloud account. Notes are shown in the GitHub release and inside the in-app updater, so they should help someone decide whether to update.

## Audience and voice
- Write for the person *using* the app, not for contributors.
- Plain, confident, concrete English. Short sentences. No marketing hype, no "we're excited to announce", no emoji.
- Prefer outcome over mechanism: "your command history now survives restarts" — not "add durable settings storage" or "wire SQLite for history".
- Second person is fine when it clarifies ("you can…", "X no longer…"); otherwise state the change directly.

## What to include
A change belongs in the notes if a user can *notice* it: something they can see, hear, click, type, configure, or that stops crashing / misbehaving.
Include, for example:
- New UI, shortcuts, panels, settings, sounds, or commands
- Behaviour changes in panes, tabs, shells, agents, Git, search, palette, updater
- Bug fixes that affect day-to-day use (crashes, wrong layout, broken shortcuts, bad rendering)
- Performance or reliability fixes the user would feel

Read commit *bodies* carefully. Subjects are often vague ("feat: update", "fix: styles") — the body usually has the real user impact. Infer the user-facing outcome from both.

## What to leave out
Skip anything a user cannot observe: pure refactors, renames, tests, CI/CD, release tooling, docs-only edits, dependency bumps with no behaviour change, internal type/cleanup commits.
Do **not** over-filter. If you are unsure whether something is user-visible, lean toward including a short bullet rather than dropping a real improvement.

## Structure
- One bullet per distinct user-facing change. Merge several commits that implement the same feature or fix into a single bullet.
- Bullet form: \`- **Short title** — one sentence of outcome.\`
  Example: \`- **Command history** — your commands now survive restarts.\`
- Title: 1–4 words, title case for proper nouns only when needed, no trailing punctuation.
- Order by user impact: new capabilities first, then improvements, then fixes.
- With three or more bullets, group under only the headings that apply:
  \`### New\` · \`### Improved\` · \`### Fixed\`
  With one or two bullets, skip headings and list them directly.
- At most ~12 bullets and 250 words. Prefer fewer, sharper bullets over a dump of every commit.

## Honesty
- Never invent a change that is not supported by the commits.
- Never mention version numbers, commit hashes, pull-request numbers, author names, or file paths.
- If *every* commit is internal (CI, release plumbing, deps, refactors, tests, docs) and none change observable behaviour, reply with exactly one line:
  \`No user-facing changes in this release.\`
  Do not invent a feature list to fill space, and do not add apology or explanation.

## Output
Return only the markdown body of the section.
- No \`## What's Changed\` heading (added for you).
- No preamble, no sign-off, no code fences around the whole answer.

## Examples

Commits (paraphrased):
* feat: persist command history across restarts
* fix: zoom button clipped at high DPI
* chore: bump CI actions
* test: cover history store

Good:
- **Command history** — your recent commands now come back after you restart Duckweed.
- **Zoom button** — the zoom control no longer clips on high-DPI displays.

Bad:
- **feat: persist command history** — add durable settings storage via SQLite.
- **CI** — bump actions/checkout to v5.
- **Tests** — cover history store.

Commits that are only release workflow + dependency bumps:

Good:
No user-facing changes in this release.

Bad:
- **Faster updates** — dependency upgrades improve performance.
- **Release pipeline** — stable releases now publish more reliably.`;

export function parseArgs(argv, env = process.env) {
  const args = {
    repo: env.GITHUB_REPOSITORY || "MusicMaster4/Duckweed",
    model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
    apiKey: env.OPENROUTER_API_KEY || "",
  };
  const keys = { "--tag": "tag", "--base": "base", "--repo": "repo", "--model": "model" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    args[key] = argv[++i];
  }
  if (!args.tag) throw new Error("--tag is required");
  if (!parseVersion(args.tag)) throw new Error(`not a Duckweed version: ${args.tag}`);
  if (!args.model) args.model = DEFAULT_MODEL; // an empty --model or variable falls back
  if (args.base) {
    const base = parseVersion(args.base);
    if (!base) throw new Error(`not a Duckweed version: ${args.base}`);
    args.base = `v${formatVersion(base)}`; // the git tags carry the v prefix
  }
  return args;
}

function gitTags() {
  return execFileSync("git", ["tag", "--list"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Newest stable tag strictly below `tag`, or null when `tag` is the first
 * stable release. Beta tags never count, not even the ones that led up to
 * this release.
 */
export function previousStableTag(tags, tag) {
  const current = parseVersion(tag);
  if (!current) throw new Error(`not a Duckweed version: ${tag}`);
  const previous = parseTags(tags)
    .filter((v) => v.channel === "stable" && compareVersions(v, current) < 0)
    .reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
  return previous === null ? null : `v${formatVersion(previous)}`;
}

/**
 * Subjects and bodies of the non-merge commits in `base..tag` (or everything
 * up to `tag` when there is no base), newest first. `exec` is injected so the
 * tests never touch a repository; the sizes are capped so a long-lived branch
 * cannot blow the prompt up.
 */
export function commitsBetween(base, tag, { exec, maxCommits = MAX_COMMITS, maxChars = MAX_CHARS, maxBodyChars = MAX_BODY_CHARS } = {}) {
  const run = exec ?? ((args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }));
  const range = base ? `${base}..${tag}` : tag;
  // %x1e ends the subject, %x1f ends the commit — control characters that
  // never appear inside a commit message.
  const raw = run(["log", "--no-merges", "--pretty=format:%s%x1e%b%x1f", range]);
  let size = 0;
  const commits = [];
  for (const entry of raw.split("\x1f")) {
    const [subject = "", body = ""] = entry.split("\x1e");
    const commit = { subject: subject.trim(), body: body.trim().slice(0, maxBodyChars) };
    if (!commit.subject) continue;
    size += commit.subject.length + commit.body.length;
    if (commits.length >= maxCommits || size > maxChars) break;
    commits.push(commit);
  }
  return commits;
}

/**
 * The chat handed to the model: one system message fixing the style, one user
 * message with the commits. Kept as data (not a formatted string) so the API
 * call needs no further assembly.
 */
export function buildPrompt({ tag, base, commits }) {
  const listing = commits
    .map((commit) => (commit.body ? `* ${commit.subject}\n  ${commit.body.replace(/\n+/g, "\n  ")}` : `* ${commit.subject}`))
    .join("\n");
  const intro = base
    ? `These are the commits between ${base} and ${tag} of Duckweed (newest first). Subjects may be terse — use bodies when present to judge user impact:`
    : `These are all the commits leading up to ${tag}, the first stable release of Duckweed (newest first). Subjects may be terse — use bodies when present to judge user impact:`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${intro}\n\n${listing}\n\nWrite the "What's Changed" section for ${tag}. Include every user-noticeable change; if there are none, say so in one line as specified.`,
    },
  ];
}

/**
 * One chat-completion call. `fetchImpl` is injected for the tests. Throws on
 * any transport, API or content problem — the workflow turns that into a
 * warning and keeps GitHub's auto-generated notes.
 */
export async function requestChangelog({ apiKey, model, messages, repo, fetchImpl = fetch }) {
  const response = await fetchImpl(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // OpenRouter's optional attribution headers.
      "http-referer": `https://github.com/${repo}`,
      "x-title": "Duckweed release notes",
    },
    body: JSON.stringify({ model, messages, temperature: 0.3 }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenRouter request failed with ${response.status}: ${detail.slice(0, 300)}`);
  }
  const content = (await response.json())?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenRouter returned an empty changelog");
  return content;
}

/** The script adds the heading itself; drop one the model added anyway. */
export function normalizeNotes(notes) {
  return notes
    .trim()
    .replace(/^#{1,3}\s+what.s changed[^\n]*(\n+|$)/i, "")
    .trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const base = args.base ?? previousStableTag(gitTags(), args.tag);
  const commits = commitsBetween(base, args.tag);
  if (commits.length === 0) {
    throw new Error(`no commits between ${base ?? "the first commit"} and ${args.tag} — is the clone missing tags?`);
  }
  const messages = buildPrompt({ tag: args.tag, base, commits });
  const notes = normalizeNotes(await requestChangelog({ ...args, messages }));
  console.log(`## What's Changed\n\n${notes}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
