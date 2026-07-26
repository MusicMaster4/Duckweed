import { describe, expect, test } from "bun:test";

import {
  bump,
  channelForBranch,
  channelOf,
  compareVersions,
  formatVersion,
  isUpdateFor,
  latestIteration,
  latestStable,
  parseVersion,
  resolveVersion,
} from "../src/lib/version.ts";

const v = (input) => {
  const parsed = parseVersion(input);
  if (!parsed) throw new Error(`bad test fixture: ${input}`);
  return parsed;
};

describe("parsing", () => {
  test("reads stable and beta versions, with or without the tag prefix", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, channel: "stable", iteration: 0 });
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, channel: "stable", iteration: 0 });
    expect(parseVersion("v10.0.99-testing.7")).toEqual({
      major: 10,
      minor: 0,
      patch: 99,
      channel: "testing",
      iteration: 7,
    });
  });

  test("rejects anything that is not one of our two shapes", () => {
    for (const input of ["", "1.2", "1.2.3.4", "1.2.3-beta.1", "1.2.3-testing", "1.2.3-testing.x", "nightly"]) {
      expect(parseVersion(input)).toBeNull();
    }
  });

  test("round-trips through formatVersion", () => {
    for (const input of ["0.0.0", "1.2.3", "1.2.3-testing.1", "99.99.99-testing.100"]) {
      expect(formatVersion(v(input))).toBe(input);
    }
  });

  test("an unrecognised version counts as stable, never as beta", () => {
    expect(channelOf("1.2.3")).toBe("stable");
    expect(channelOf("1.2.3-testing.4")).toBe("testing");
    expect(channelOf("banana")).toBe("stable");
  });
});

describe("odometer", () => {
  test("patch fills up to 99 then carries into minor", () => {
    expect(formatVersion(bump(v("1.0.0"), "patch"))).toBe("1.0.1");
    expect(formatVersion(bump(v("1.0.98"), "patch"))).toBe("1.0.99");
    expect(formatVersion(bump(v("1.0.99"), "patch"))).toBe("1.1.0");
  });

  test("minor fills up to 99 then carries into major", () => {
    expect(formatVersion(bump(v("1.99.0"), "minor"))).toBe("2.0.0");
    expect(formatVersion(bump(v("1.99.99"), "patch"))).toBe("2.0.0");
    expect(formatVersion(bump(v("0.99.99"), "patch"))).toBe("1.0.0");
  });

  test("explicit minor and major bumps reset what sits below them", () => {
    expect(formatVersion(bump(v("1.2.34"), "minor"))).toBe("1.3.0");
    expect(formatVersion(bump(v("1.2.34"), "major"))).toBe("2.0.0");
    expect(formatVersion(bump(v("9.99.99"), "major"))).toBe("10.0.0");
  });

  test("a bump off a beta lands on a plain stable version", () => {
    expect(formatVersion(bump(v("1.0.3-testing.9"), "patch"))).toBe("1.0.4");
  });

  test("stays on the rails over a long run of patches", () => {
    let current = v("1.0.0");
    for (let i = 0; i < 250; i += 1) current = bump(current, "patch");
    expect(formatVersion(current)).toBe("1.2.50");
    expect(current.patch).toBeLessThanOrEqual(99);
    expect(current.minor).toBeLessThanOrEqual(99);
  });
});

describe("ordering", () => {
  test("sorts by major, minor, patch, then beta counter", () => {
    const sorted = ["1.0.3", "1.0.3-testing.2", "0.9.9", "1.0.3-testing.10", "2.0.0"]
      .map(v)
      .sort(compareVersions)
      .map(formatVersion);
    expect(sorted).toEqual(["0.9.9", "1.0.3-testing.2", "1.0.3-testing.10", "1.0.3", "2.0.0"]);
  });

  test("a beta sorts below the stable release it leads to", () => {
    expect(compareVersions(v("1.0.3-testing.99"), v("1.0.3"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.3"), v("1.0.3"))).toBe(0);
  });
});

describe("channel isolation", () => {
  test("a beta install is offered newer betas only", () => {
    expect(isUpdateFor("1.0.3-testing.1", "1.0.3-testing.2")).toBe(true);
    expect(isUpdateFor("1.0.3-testing.2", "1.0.3-testing.2")).toBe(false);
    expect(isUpdateFor("1.0.3-testing.2", "1.0.3-testing.1")).toBe(false);
  });

  test("a beta install never sees a stable release, even a newer one", () => {
    expect(isUpdateFor("1.0.3-testing.1", "1.0.3")).toBe(false);
    expect(isUpdateFor("1.0.3-testing.1", "9.9.9")).toBe(false);
  });

  test("a stable install never sees a beta, even a newer one", () => {
    expect(isUpdateFor("1.0.2", "1.0.3-testing.4")).toBe(false);
    expect(isUpdateFor("1.0.2", "9.9.9-testing.1")).toBe(false);
  });

  test("a stable install is offered newer stable releases only", () => {
    expect(isUpdateFor("1.0.2", "1.0.3")).toBe(true);
    expect(isUpdateFor("1.0.99", "1.1.0")).toBe(true);
    expect(isUpdateFor("1.0.3", "1.0.2")).toBe(false);
  });

  test("nonsense versions are never an update", () => {
    expect(isUpdateFor("banana", "1.0.0")).toBe(false);
    expect(isUpdateFor("1.0.0", "banana")).toBe(false);
  });
});

describe("reading the tag list", () => {
  const tags = ["v0.9.0", "v1.0.0", "v1.0.1-testing.1", "v1.0.1-testing.2", "not-a-tag", "v1.0.1-testing.10"];

  test("the latest stable ignores betas and junk", () => {
    expect(formatVersion(latestStable(tags))).toBe("1.0.0");
    expect(latestStable(["nightly", "v1.0.1-testing.1"])).toBeNull();
  });

  test("the beta counter is per base version and compares numerically", () => {
    expect(latestIteration(tags, v("1.0.1"))).toBe(10);
    expect(latestIteration(tags, v("1.0.2"))).toBe(0);
  });
});

describe("resolving the next release", () => {
  test("the first main release is 1.0.0 while testing still comes from package.json", () => {
    expect(resolveVersion({ channel: "stable", tags: [], packageVersion: "0.1.0" })).toBe("1.0.0");
    expect(resolveVersion({ channel: "testing", tags: [], packageVersion: "0.1.0" })).toBe("0.1.0-testing.1");
  });

  test("beta tags do not stop the first main merge from becoming 1.0.0", () => {
    const tags = ["v0.1.0-testing.1", "v0.1.0-testing.17"];
    expect(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0" })).toBe("1.0.0");
  });

  test("stable releases after 1.0.0 increment the patch", () => {
    expect(resolveVersion({ channel: "stable", tags: ["v1.0.0"], packageVersion: "0.1.0" })).toBe("1.0.1");
    expect(resolveVersion({ channel: "stable", tags: ["v1.0.0", "v1.0.1"], packageVersion: "0.1.0" })).toBe(
      "1.0.2",
    );
  });

  test("stable steps one patch past the latest stable tag", () => {
    const tags = ["v1.0.0", "v1.0.1"];
    expect(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0" })).toBe("1.0.2");
    expect(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0", level: "minor" })).toBe("1.1.0");
    expect(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0", level: "major" })).toBe("2.0.0");
  });

  test("betas count up against the stable release they lead to", () => {
    const tags = ["v1.0.0"];
    expect(resolveVersion({ channel: "testing", tags, packageVersion: "0.1.0" })).toBe("1.0.1-testing.1");
    expect(
      resolveVersion({ channel: "testing", tags: [...tags, "v1.0.1-testing.1"], packageVersion: "0.1.0" }),
    ).toBe("1.0.1-testing.2");
  });

  test("betas of an older base do not bleed into a new base", () => {
    const tags = ["v1.0.0", "v1.0.1-testing.1", "v1.0.1-testing.2", "v1.0.1"];
    expect(resolveVersion({ channel: "testing", tags, packageVersion: "0.1.0" })).toBe("1.0.2-testing.1");
  });

  test("publishing stable does not reuse a beta counter", () => {
    const tags = ["v1.0.0", "v1.0.1-testing.1", "v1.0.1-testing.2"];
    expect(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0" })).toBe("1.0.1");
  });

  test("a higher package.json version wins on both channels after stable releases begin", () => {
    const tags = ["v1.0.0"];
    expect(resolveVersion({ channel: "stable", tags, packageVersion: "2.5.0" })).toBe("2.5.0");
    expect(resolveVersion({ channel: "testing", tags, packageVersion: "2.5.0" })).toBe("2.5.0-testing.1");
  });

  test("a stale package.json version is ignored", () => {
    expect(resolveVersion({ channel: "stable", tags: ["v1.0.0"], packageVersion: "0.1.0" })).toBe("1.0.1");
  });

  test("carries hold when resolving", () => {
    expect(resolveVersion({ channel: "stable", tags: ["v1.0.99"], packageVersion: "0.1.0" })).toBe("1.1.0");
    expect(resolveVersion({ channel: "testing", tags: ["v1.99.99"], packageVersion: "0.1.0" })).toBe(
      "2.0.0-testing.1",
    );
  });

  test("an unusable package.json version is an error, not a silent 0.0.0", () => {
    expect(() => resolveVersion({ channel: "stable", tags: [], packageVersion: "" })).toThrow();
  });
});

describe("branch to channel", () => {
  test("only main and testing map to a channel", () => {
    expect(channelForBranch("main")).toBe("stable");
    expect(channelForBranch("refs/heads/main")).toBe("stable");
    expect(channelForBranch("testing")).toBe("testing");
    expect(channelForBranch("refs/heads/testing")).toBe("testing");
    for (const branch of ["master", "develop", "feature/x", "release", "main-2", "testing/x"]) {
      expect(channelForBranch(branch)).toBeNull();
    }
  });
});
