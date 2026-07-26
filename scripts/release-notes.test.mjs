import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL,
  buildPrompt,
  commitsBetween,
  normalizeNotes,
  parseArgs,
  previousStableTag,
  requestChangelog,
} from "./release-notes.mjs";

const ENV = {}; // no GITHUB_REPOSITORY / OPENROUTER_* leaking in from the shell

describe("release-notes arguments", () => {
  test("--tag is required and must be a Duckweed version", () => {
    expect(() => parseArgs([], ENV)).toThrow();
    expect(() => parseArgs(["--tag", "soon"], ENV)).toThrow();
    expect(parseArgs(["--tag", "v1.2.3"], ENV).tag).toBe("v1.2.3");
  });

  test("the model comes from --model, then OPENROUTER_MODEL, then the default", () => {
    expect(parseArgs(["--tag", "v1.2.3"], ENV).model).toBe(DEFAULT_MODEL);
    expect(parseArgs(["--tag", "v1.2.3"], { OPENROUTER_MODEL: "a/b" }).model).toBe("a/b");
    expect(parseArgs(["--tag", "v1.2.3", "--model", "x/y"], { OPENROUTER_MODEL: "a/b" }).model).toBe("x/y");
    // An unset repository variable arrives as an empty string and falls back.
    expect(parseArgs(["--tag", "v1.2.3"], { OPENROUTER_MODEL: "" }).model).toBe(DEFAULT_MODEL);
  });

  test("the API key is read from the environment, never from an argument", () => {
    expect(parseArgs(["--tag", "v1.2.3"], ENV).apiKey).toBe("");
    expect(parseArgs(["--tag", "v1.2.3"], { OPENROUTER_API_KEY: "sk-or-x" }).apiKey).toBe("sk-or-x");
  });

  test("--base overrides the tag lookup and is normalised to the tags' v prefix", () => {
    expect(parseArgs(["--tag", "v1.0.4", "--base", "1.0.3"], ENV).base).toBe("v1.0.3");
    expect(parseArgs(["--tag", "v1.0.4", "--base", "v1.0.3"], ENV).base).toBe("v1.0.3");
    expect(() => parseArgs(["--tag", "v1.0.4", "--base", "junk"], ENV)).toThrow();
  });
});

describe("previous stable tag", () => {
  const tags = ["v1.0.0", "v1.0.1", "v1.0.2-testing.3", "v1.0.2", "channel-testing"];

  test("is the newest stable tag below the release", () => {
    expect(previousStableTag(tags, "v1.0.3")).toBe("v1.0.2");
  });

  test("ignores beta tags, even the ones that led up to this release", () => {
    expect(previousStableTag(["v1.0.2", "v1.0.3-testing.9"], "v1.0.3")).toBe("v1.0.2");
    expect(previousStableTag(tags, "v1.0.2")).toBe("v1.0.1");
  });

  test("is null for the first stable release", () => {
    expect(previousStableTag(["v0.1.0-testing.4"], "v1.0.0")).toBeNull();
    expect(previousStableTag([], "v1.0.0")).toBeNull();
  });

  test("the release's own tag never counts as its predecessor", () => {
    expect(previousStableTag(["v1.0.2", "v1.0.3"], "v1.0.3")).toBe("v1.0.2");
  });

  test("a tag that is not a Duckweed version is an error", () => {
    expect(() => previousStableTag(tags, "channel-testing")).toThrow();
  });
});

describe("commit collection", () => {
  const log = ["feat: add tabs\x1eSome body\x1f", "fix: crash on zoom\x1e\x1f"].join("\n");

  test("queries the range between the base and the tag, skipping merges", () => {
    const seen = [];
    const commits = commitsBetween("v1.0.1", "v1.0.2", {
      exec: (args) => {
        seen.push(args);
        return log;
      },
    });
    expect(seen[0].join(" ")).toContain("v1.0.1..v1.0.2");
    expect(seen[0].join(" ")).toContain("--no-merges");
    expect(commits).toEqual([
      { subject: "feat: add tabs", body: "Some body" },
      { subject: "fix: crash on zoom", body: "" },
    ]);
  });

  test("the first release has no range: everything up to the tag", () => {
    const seen = [];
    commitsBetween(null, "v1.0.0", {
      exec: (args) => {
        seen.push(args);
        return log;
      },
    });
    expect(seen[0].at(-1)).toBe("v1.0.0");
    expect(seen[0].at(-1)).not.toContain("..");
  });

  test("an empty history is an empty list, not a phantom commit", () => {
    expect(commitsBetween("v1.0.1", "v1.0.2", { exec: () => "" })).toEqual([]);
  });

  test("the history is capped so a huge one cannot blow up the prompt", () => {
    const big = Array.from({ length: 500 }, (_, i) => `feat: change ${i}\x1e${"x".repeat(1000)}\x1f`).join("\n");
    const commits = commitsBetween(null, "v9.9.9", { exec: () => big, maxChars: 5000 });
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.length).toBeLessThan(10);
  });
});

describe("the prompt", () => {
  const commits = [
    { subject: "feat: add command history", body: "persists across restarts" },
    { subject: "fix: zoom icon size", body: "" },
  ];
  const [system, user] = buildPrompt({ tag: "v1.0.4", base: "v1.0.3", commits });

  test("carries every commit so the model can analyse what changed", () => {
    expect(user.content).toContain("feat: add command history");
    expect(user.content).toContain("persists across restarts");
    expect(user.content).toContain("fix: zoom icon size");
  });

  test("names the release and the range it covers", () => {
    expect(user.content).toContain("v1.0.4");
    expect(user.content).toContain("v1.0.3");
  });

  test("the first release is described without a base to compare against", () => {
    const [, firstUser] = buildPrompt({ tag: "v1.0.0", base: null, commits });
    expect(firstUser.content).not.toContain("between");
    expect(firstUser.content).toContain("v1.0.0");
  });

  test("keeps the model on-task: user-facing markdown and no invented changes", () => {
    expect(system.role).toBe("system");
    expect(user.role).toBe("user");
    expect(system.content).toContain("What's Changed");
    expect(system.content).toContain("Never invent");
    expect(user.content).toContain("What's Changed");
  });
});

describe("the OpenRouter call", () => {
  const messages = [{ role: "user", content: "hi" }];
  const ok = (content) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  });

  test("posts the model and messages with the key, and returns the content", async () => {
    let seen;
    const notes = await requestChangelog({
      apiKey: "sk-or-test",
      model: "google/gemini-2.5-flash",
      messages,
      repo: "MusicMaster4/Duckweed",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return ok("- **Tabs** — you can now split panes.")(url, init);
      },
    });
    expect(notes).toContain("Tabs");
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers.authorization).toBe("Bearer sk-or-test");
    const payload = JSON.parse(seen.init.body);
    expect(payload.model).toBe("google/gemini-2.5-flash");
    expect(payload.messages).toEqual(messages);
  });

  test("an API error becomes an exception the workflow can warn about", async () => {
    await expect(
      requestChangelog({
        apiKey: "bad",
        model: "m",
        messages,
        repo: "r",
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
      }),
    ).rejects.toThrow("401");
  });

  test("an empty answer is an error, not an empty changelog", async () => {
    const empty = async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) });
    await expect(
      requestChangelog({ apiKey: "k", model: "m", messages, repo: "r", fetchImpl: empty }),
    ).rejects.toThrow();
  });
});

describe("normalising the model's answer", () => {
  test("a heading the model added anyway is stripped before ours is prepended", () => {
    expect(normalizeNotes("## What's Changed\n\n- stuff")).toBe("- stuff");
    expect(normalizeNotes("### What’s Changed\n- stuff")).toBe("- stuff");
    expect(normalizeNotes("- stuff")).toBe("- stuff");
  });
});
