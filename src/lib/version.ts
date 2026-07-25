/**
 * Version arithmetic for Duckweed's two release channels.
 *
 * Stable builds (branch `main`) carry a plain `X.Y.Z`. Beta builds (branch
 * `testing`) carry `X.Y.Z-testing.N`, where `X.Y.Z` is the stable release the
 * betas are working toward and `N` counts the betas published for that base.
 *
 * Numbers roll like an odometer: patch fills 0..99 and then carries into minor,
 * minor fills 0..99 and then carries into major, and major is unbounded.
 *
 * This module is deliberately free of Tauri and Node imports — the app, the
 * release scripts and the tests all share it.
 */

export const BETA_CHANNEL = "testing";
/** Highest patch before it carries into minor. */
export const PATCH_MAX = 99;
/** Highest minor before it carries into major. */
export const MINOR_MAX = 99;

export type Channel = "stable" | "testing";
export type BumpLevel = "patch" | "minor" | "major";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  channel: Channel;
  /** Beta counter for `X.Y.Z`; always 0 on the stable channel. */
  iteration: number;
}

const VERSION_RE = new RegExp(`^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-${BETA_CHANNEL}\\.(\\d+))?$`);

/** `1.2.3` / `v1.2.3` / `1.2.3-testing.4` → a version, or null if unrecognised. */
export function parseVersion(input: string): Version | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, iteration] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    channel: iteration === undefined ? "stable" : "testing",
    iteration: iteration === undefined ? 0 : Number(iteration),
  };
}

export function formatVersion(version: Version): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.channel === "stable" ? base : `${base}-${BETA_CHANNEL}.${version.iteration}`;
}

/** The channel a build belongs to. Anything we cannot parse is treated as stable. */
export function channelOf(version: string): Channel {
  return parseVersion(version)?.channel ?? "stable";
}

/** Drop any beta suffix: the `X.Y.Z` a version belongs to. */
export function baseOf(version: Version): Version {
  return { major: version.major, minor: version.minor, patch: version.patch, channel: "stable", iteration: 0 };
}

/**
 * Next stable version above `version`, with odometer carries. Beta suffixes are
 * ignored: bumping `1.0.3-testing.7` by a patch gives `1.0.4`.
 */
export function bump(version: Version, level: BumpLevel = "patch"): Version {
  let { major, minor, patch } = version;
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  if (patch > PATCH_MAX) {
    patch = 0;
    minor += 1;
  }
  if (minor > MINOR_MAX) {
    minor = 0;
    major += 1;
  }
  return { major, minor, patch, channel: "stable", iteration: 0 };
}

/** Semver ordering: `1.0.3-testing.9` sorts before `1.0.3`. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.channel !== b.channel) return a.channel === "stable" ? 1 : -1;
  return a.iteration - b.iteration;
}

/**
 * True when `candidate` is an update the running build should be offered: the
 * two channels are fully isolated, so a stable install never sees a beta and a
 * beta install never sees a stable.
 */
export function isUpdateFor(currentVersion: string, candidateVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (!current || !candidate) return false;
  if (current.channel !== candidate.channel) return false;
  return compareVersions(candidate, current) > 0;
}

/** Parse a list of git tags, keeping only the ones shaped like our versions. */
export function parseTags(tags: readonly string[]): Version[] {
  return tags.map((tag) => parseVersion(tag)).filter((v): v is Version => v !== null);
}

function highest(versions: Version[]): Version | null {
  return versions.reduce<Version | null>(
    (best, v) => (best === null || compareVersions(v, best) > 0 ? v : best),
    null,
  );
}

/** Newest plain `X.Y.Z` tag, ignoring betas. */
export function latestStable(tags: readonly string[]): Version | null {
  return highest(parseTags(tags).filter((v) => v.channel === "stable"));
}

/** Highest beta counter published for `base`, or 0 when there is none. */
export function latestIteration(tags: readonly string[], base: Version): number {
  const betas = parseTags(tags).filter(
    (v) =>
      v.channel === "testing" &&
      v.major === base.major &&
      v.minor === base.minor &&
      v.patch === base.patch,
  );
  return betas.reduce((max, v) => Math.max(max, v.iteration), 0);
}

export interface ResolveOptions {
  channel: Channel;
  /** Every tag in the repository; anything unparseable is ignored. */
  tags: readonly string[];
  /** Version currently in package.json — an escape hatch for a manual jump. */
  packageVersion: string;
  level?: BumpLevel;
}

/**
 * The version the next release should carry.
 *
 * Both channels count from the latest *stable* tag, so the beta base is always
 * the release the betas lead to. A package.json version higher than the latest
 * stable tag wins, which is how you jump to an exact number by hand.
 */
export function resolveVersion({ channel, tags, packageVersion, level = "patch" }: ResolveOptions): string {
  const parsedPackage = parseVersion(packageVersion);
  if (!parsedPackage) throw new Error(`package version is not a Duckweed version: ${packageVersion}`);
  const pkg = baseOf(parsedPackage);
  const stable = latestStable(tags);

  let base: Version;
  if (stable === null) base = pkg;
  else if (compareVersions(pkg, stable) > 0) base = pkg;
  else base = bump(stable, level);

  if (channel === "stable") return formatVersion(base);
  return formatVersion({ ...base, channel: "testing", iteration: latestIteration(tags, base) + 1 });
}

/** Branch → channel. Only these two branches ever produce a release. */
export function channelForBranch(branch: string): Channel | null {
  const name = branch.replace(/^refs\/heads\//, "");
  if (name === "main") return "stable";
  if (name === BETA_CHANNEL) return "testing";
  return null;
}
