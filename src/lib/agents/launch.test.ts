import { describe, expect, test } from "bun:test";

import { parseAgentLaunch, tokenize } from "./launch";

describe("tokenize", () => {
  test("keeps a quoted prompt as one word", () => {
    expect(tokenize(`claude "fix the login bug"`)).toEqual(["claude", "fix the login bug"]);
  });

  test("handles single quotes and escaped quotes", () => {
    expect(tokenize(`grok 'say "hi"'`)).toEqual(["grok", 'say "hi"']);
    expect(tokenize(`codex "a \\"b\\" c"`)).toEqual(["codex", 'a "b" c']);
  });

  test("keeps an empty quoted argument", () => {
    expect(tokenize(`claude ""`)).toEqual(["claude", ""]);
  });
});

describe("parseAgentLaunch", () => {
  test("claims a bare launch of every supported agent", () => {
    expect(parseAgentLaunch("claude")?.agent).toBe("claude");
    expect(parseAgentLaunch("codex")?.agent).toBe("codex");
    expect(parseAgentLaunch("cursor-agent")?.agent).toBe("cursor");
    expect(parseAgentLaunch("grok")?.agent).toBe("grok");
    expect(parseAgentLaunch("opencode")?.agent).toBe("opencode");
  });

  test("claims claudex as Claude protocol while spawning the wrapper", () => {
    const bare = parseAgentLaunch("claudex");
    expect(bare?.agent).toBe("claude");
    expect(bare?.program).toBe("claudex");
    expect(bare?.wrapperArgs).toEqual([]);

    // `--g` / `--o` select Claudex's proxied backend and must survive parsing
    // so the spawn line can put them before the headless protocol args.
    const grok = parseAgentLaunch("claudex --g --model grok-4.5");
    expect(grok?.agent).toBe("claude");
    expect(grok?.program).toBe("claudex");
    expect(grok?.wrapperArgs).toEqual(["--g"]);
    expect(grok?.model).toBe("grok-4.5");

    const openrouter = parseAgentLaunch("claudex --o \"fix the login\"");
    expect(openrouter?.program).toBe("claudex");
    expect(openrouter?.wrapperArgs).toEqual(["--o"]);
    expect(openrouter?.prompt).toBe("fix the login");

    const longForms = parseAgentLaunch("claudex --grok --effort high");
    expect(longForms?.wrapperArgs).toEqual(["--grok"]);
    expect(longForms?.effort).toBe("high");
  });

  test("records the typed program, falling back for profile wrappers", () => {
    expect(parseAgentLaunch("claude")?.program).toBe("claude");
    expect(parseAgentLaunch("omc")?.program).toBe("omc");
    // Profile wrappers are shell aliases; spawn the canonical binary.
    expect(parseAgentLaunch("claude-work")?.program).toBe("claude");
    expect(parseAgentLaunch("codex-personal")?.program).toBe("codex");
  });

  test("ignores agents the custom UI cannot drive", () => {
    expect(parseAgentLaunch("gemini")).toBeNull();
    expect(parseAgentLaunch("aider")).toBeNull();
    expect(parseAgentLaunch("ls")).toBeNull();
  });

  test("takes the opening prompt from a positional argument", () => {
    expect(parseAgentLaunch(`claude "fix the login bug"`)?.prompt).toBe("fix the login bug");
    expect(parseAgentLaunch(`grok 'add tests'`)?.prompt).toBe("add tests");
  });

  test("reads the requested model in both flag forms", () => {
    expect(parseAgentLaunch("claude --model opus")?.model).toBe("opus");
    expect(parseAgentLaunch("claude --model=opus")?.model).toBe("opus");
    expect(parseAgentLaunch("grok -m grok-4.5")?.model).toBe("grok-4.5");
  });

  test("reads the requested effort in its flag forms", () => {
    expect(parseAgentLaunch("claude --effort high")?.effort).toBe("high");
    expect(parseAgentLaunch("claude --effort=max")?.effort).toBe("max");
    expect(parseAgentLaunch("grok --reasoning-effort low")?.effort).toBe("low");
    expect(parseAgentLaunch("grok --effort medium")?.effort).toBe("medium");
    // An effort flag with no value does not turn the next flag into one.
    expect(parseAgentLaunch("claude --effort --model opus")?.effort).toBeNull();
  });

  test("reads model and effort out of codex config overrides", () => {
    expect(parseAgentLaunch("codex -c model_reasoning_effort=high")?.effort).toBe("high");
    expect(parseAgentLaunch('codex -c model="gpt-5.6-sol"')?.model).toBe("gpt-5.6-sol");
    expect(parseAgentLaunch("codex --config model_reasoning_effort=xhigh")?.effort).toBe("xhigh");
    // Between -m and a config override, the later word wins.
    expect(parseAgentLaunch("codex -c model=gpt-5.4 -m gpt-5.5")?.model).toBe("gpt-5.5");
  });

  test("preserves configuration and permission flags for the headless launch", () => {
    expect(
      parseAgentLaunch(
        "claude --add-dir ../shared --settings team.json --allowed-tools Read,Edit",
      )?.forwardArgs,
    ).toEqual([
      "--add-dir",
      "../shared",
      "--settings",
      "team.json",
      "--allowed-tools",
      "Read,Edit",
    ]);
    expect(parseAgentLaunch("codex --profile work --sandbox workspace-write")?.forwardArgs).toEqual(
      ["--profile", "work", "--sandbox", "workspace-write"],
    );
  });

  test("does not duplicate options reconstructed by the protocol adapter", () => {
    expect(
      parseAgentLaunch("claude --model opus --effort high --continue")?.forwardArgs,
    ).toEqual([]);
    expect(
      parseAgentLaunch("codex -c model_reasoning_effort=xhigh -c features.foo=true")
        ?.forwardArgs,
    ).toEqual(["-c", "features.foo=true"]);
  });

  test("recognises continuing a previous session", () => {
    expect(parseAgentLaunch("claude -c")?.resume).toBe(true);
    expect(parseAgentLaunch("claude --continue")?.resume).toBe(true);
    expect(parseAgentLaunch("opencode --continue")?.resume).toBe(true);
    expect(parseAgentLaunch("claude --resume")?.resume).toBe(true);
    // With an id, `--resume` consumes it rather than leaving it as a prompt.
    expect(parseAgentLaunch("claude --resume abc123")?.prompt).toBeNull();
  });

  test("keeps the session id when one was named", () => {
    expect(parseAgentLaunch("claude --resume abc123")?.resumeId).toBe("abc123");
    // Bare `--resume` means "the most recent one", which has no id yet.
    expect(parseAgentLaunch("claude --resume")?.resumeId).toBeNull();
    expect(parseAgentLaunch("claude -c")?.resumeId).toBeNull();
    // OpenCode's `-s` continues a session; Grok's `--session-id` starts one.
    expect(parseAgentLaunch("opencode -s ses_abc")?.resumeId).toBe("ses_abc");
    expect(parseAgentLaunch("opencode --session ses_abc")?.resumeId).toBe("ses_abc");
    expect(parseAgentLaunch("grok --session-id 019fa342")?.resumeId).toBeNull();
  });

  test("treats codex's -c as a config override, not continue", () => {
    const launch = parseAgentLaunch("codex -c model_reasoning_effort=high");
    expect(launch?.resume).toBe(false);
    expect(launch?.prompt).toBeNull();
  });

  test("leaves non-interactive subcommands to the shell", () => {
    expect(parseAgentLaunch("codex exec 'do a thing'")).toBeNull();
    expect(parseAgentLaunch("codex login")).toBeNull();
    expect(parseAgentLaunch("claude -p hello")).toBeNull();
    expect(parseAgentLaunch("claude --help")).toBeNull();
    expect(parseAgentLaunch("claude mcp list")).toBeNull();
    expect(parseAgentLaunch("opencode run hello")).toBeNull();
    expect(parseAgentLaunch("opencode serve")).toBeNull();
    expect(parseAgentLaunch("grok agent stdio")).toBeNull();
  });

  test("leaves anything the shell has to compose alone", () => {
    expect(parseAgentLaunch("claude | tee log.txt")).toBeNull();
    expect(parseAgentLaunch("claude > out.txt")).toBeNull();
    expect(parseAgentLaunch("git pull && claude")).toBeNull();
    expect(parseAgentLaunch("claude &")).toBeNull();
    expect(parseAgentLaunch("claude\nls")).toBeNull();
  });

  test("sees through runners and environment prefixes", () => {
    expect(parseAgentLaunch("npx claude")?.agent).toBe("claude");
    expect(parseAgentLaunch("bunx opencode")?.agent).toBe("opencode");
    expect(parseAgentLaunch("pnpm dlx codex")?.agent).toBe("codex");
    expect(parseAgentLaunch("ANTHROPIC_MODEL=opus claude")?.agent).toBe("claude");
    expect(parseAgentLaunch("ANTHROPIC_MODEL=opus claude")?.env).toEqual({
      ANTHROPIC_MODEL: "opus",
    });
    expect(parseAgentLaunch("env FOO=one BAR=two codex")?.env).toEqual({
      FOO: "one",
      BAR: "two",
    });
    expect(parseAgentLaunch("sudo claude")).toBeNull();
    expect(parseAgentLaunch("env -u ANTHROPIC_MODEL claude")).toBeNull();
  });

  test("sees through an explicit path and a Windows suffix", () => {
    const windows = parseAgentLaunch(`"C:\\Users\\me\\bin\\claude.cmd"`);
    expect(windows?.agent).toBe("claude");
    expect(windows?.program).toBe("C:\\Users\\me\\bin\\claude.cmd");
    const unix = parseAgentLaunch("/usr/local/bin/codex");
    expect(unix?.agent).toBe("codex");
    expect(unix?.program).toBe("/usr/local/bin/codex");
  });

  test("accepts profile-wrapper names", () => {
    expect(parseAgentLaunch("claude-work")?.agent).toBe("claude");
    expect(parseAgentLaunch("codex-personal")?.agent).toBe("codex");
  });

  test("refuses a second positional, which means a subcommand took an argument", () => {
    expect(parseAgentLaunch("claude something else")).toBeNull();
  });
});
