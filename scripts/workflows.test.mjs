import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BETA_POINTER_TAG, endpointFor } from "./apply-version.mjs";
import { channelForBranch, channelOf } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const yaml = (file) => Bun.YAML.parse(read(file));

const release = yaml(".github/workflows/release.yml");
const releaseText = read(".github/workflows/release.yml");
const ci = yaml(".github/workflows/ci.yml");
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));

/** Every `run:` script in a workflow, flattened. */
function runSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) => typeof step.run === "string"),
  );
}

describe("release triggers", () => {
  test("only main and testing can start a release", () => {
    expect(release.on.push.branches).toEqual(["main", "testing"]);
    for (const branch of release.on.push.branches) expect(channelForBranch(branch)).not.toBeNull();
  });

  test("no tag, schedule or pull_request trigger can sneak a release out", () => {
    expect(Object.keys(release.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(release.on.push.tags).toBeUndefined();
  });

  test("a manual run still has to be on a release branch", () => {
    // The guard is the same code the tests above cover: --branch refuses
    // anything channelForBranch() does not recognise.
    const step = runSteps(release).find((s) => s.run.includes("release-version.mjs"));
    expect(step.run).toContain("--branch");
    expect(step.run).toContain("$GITHUB_REF_NAME");
  });

  test("releases run one at a time per branch, so two pushes cannot claim one version", () => {
    expect(release.concurrency.group).toContain("github.ref");
    expect(release.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("the workflow may write releases", () => {
    expect(release.permissions.contents).toBe("write");
  });
});

describe("channel isolation in the published releases", () => {
  const publish = release.jobs.publish;
  const stableStep = publish.steps.find((s) => s.if?.includes("'stable'") && s.run?.includes("--draft=false --latest"));
  const betaStep = publish.steps.find((s) => s.if?.includes("'testing'") && s.run.includes("release edit"));

  test("a stable release becomes the repository's Latest", () => {
    expect(stableStep.run).toContain("--draft=false");
    expect(stableStep.run).toContain("--latest");
    expect(stableStep.run).not.toContain("--prerelease");
  });

  test("a beta release is a prerelease and never Latest — stable installs cannot reach it", () => {
    expect(betaStep.run).toContain("--prerelease");
    expect(betaStep.run).toContain("--latest=false");
  });

  test("the beta pointer release the workflow writes is the one beta builds read", () => {
    const pointerStep = runSteps(release).find((s) => s.run.includes("release upload") && s.run.includes("BETA_POINTER"));
    expect(release.env.BETA_POINTER_TAG).toBe(BETA_POINTER_TAG);
    expect(endpointFor("testing")).toContain(`/releases/download/${release.env.BETA_POINTER_TAG}/latest.json`);
    expect(pointerStep.run).toContain("latest.json");
    expect(pointerStep.run).toContain("duckweed-beta-setup.exe");
    expect(pointerStep.run).toContain("--clobber");
    // Created as a prerelease so it is skipped by the stable endpoint's
    // "latest release" lookup.
    expect(pointerStep.run).toContain("--prerelease");
  });

  test("keeps a permanent installer URL for the newest beta", () => {
    const pointerStep = runSteps(release).find((s) => s.run.includes("release upload") && s.run.includes("BETA_POINTER"));
    const readme = read("README.md");
    const betaInstaller = `/releases/download/${BETA_POINTER_TAG}/duckweed-beta-setup.exe`;

    expect(pointerStep.run).toContain('--pattern "*.exe"');
    expect(pointerStep.run).toContain("mv");
    expect(pointerStep.run).toContain("duckweed-beta-setup.exe");
    expect(readme).toContain(betaInstaller);
  });

  test("the pointer is only ever written from the beta channel", () => {
    for (const step of release.jobs.publish.steps) {
      if (step.run?.includes("BETA_POINTER_TAG")) expect(step.if).toContain("'testing'");
    }
  });
});

describe("AI-written stable changelogs", () => {
  const steps = release.jobs.publish.steps;
  const notesStep = steps.find((s) => s.run?.includes("release-notes.mjs"));

  test("only stable releases get their What's Changed written by OpenRouter", () => {
    expect(notesStep).toBeDefined();
    expect(notesStep.if).toContain("'stable'");
    expect(notesStep.env.OPENROUTER_API_KEY).toContain("secrets.OPENROUTER_API_KEY");
    expect(notesStep.env.OPENROUTER_MODEL).toContain("vars.OPENROUTER_MODEL");
  });

  test("the generated notes are attached to the release they describe", () => {
    expect(notesStep.run).toContain("gh release edit");
    expect(notesStep.run).toContain("--notes-file");
    expect(notesStep.run).toContain('"$TAG"');
    expect(notesStep.run).toContain('"$REPO"');
  });

  test("a missing key or a failed call keeps the auto-generated notes and never blocks the release", () => {
    expect(notesStep.run).toContain("OPENROUTER_API_KEY:-");
    expect(notesStep.run).toContain("::warning::");
  });

  test("the notes are written before the release leaves draft", () => {
    const notesIndex = steps.findIndex((s) => s.run?.includes("release-notes.mjs"));
    const publishIndex = steps.findIndex((s) => s.run?.includes("--draft=false --latest"));
    expect(notesIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(notesIndex).toBeLessThan(publishIndex);
  });

  test("the publish job fetches every tag, so the changelog can range over them", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout.if).toContain("'stable'");
    expect(checkout.with["fetch-depth"]).toBe(0);
  });
});

describe("the build job", () => {
  const build = release.jobs.build;

  test("builds on Windows", () => {
    expect(build["runs-on"]).toBe("windows-latest");
    expect(runSteps(release).some((s) => s.run.includes("tauri build") && s.run.includes("--bundles nsis"))).toBe(true);
  });

  test("stamps the resolved version and channel before building", () => {
    const apply = build.steps.findIndex((s) => s.run?.includes("apply-version.mjs"));
    const compile = build.steps.findIndex((s) => s.run?.includes("tauri build"));
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(apply).toBeLessThan(compile);
    expect(build.steps[apply].run).toContain("--channel");
  });

  test("runs the checks before spending ten minutes on a compile", () => {
    const checks = build.steps.findIndex((s) => s.run?.includes("bun test"));
    const compile = build.steps.findIndex((s) => s.run?.includes("tauri build"));
    expect(checks).toBeGreaterThanOrEqual(0);
    expect(checks).toBeLessThan(compile);
  });

  test("signs the update with the repository's private key", () => {
    const step = build.steps.find((s) => s.run?.includes("tauri build"));
    expect(step.env.TAURI_SIGNING_PRIVATE_KEY).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    expect(step.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  });

  test("uploads the installer and the manifest to the release it belongs to", () => {
    const step = build.steps.find((s) => s.run?.includes("release upload"));
    expect(step.run).toContain("bundle/nsis/*");
    expect(step.run).toContain("latest.json");
    expect(step.run).toContain("needs.version.outputs.tag");
  });

  test("a test build publishes nothing", () => {
    const upload = build.steps.find((s) => s.run?.includes("release upload"));
    const artifact = build.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload.if).toContain("publish == 'true'");
    expect(artifact.if).toContain("publish != 'true'");
    expect(release.jobs.publish.if).toContain("publish == 'true'");
  });
});

describe("CI workflow", () => {
  test("covers the branches the release workflow ignores", () => {
    expect(ci.on.push["branches-ignore"]).toEqual(["main", "testing"]);
    expect(ci.on).toHaveProperty("pull_request");
  });

  test("cannot publish a release", () => {
    expect(read(".github/workflows/ci.yml")).not.toContain("gh release");
    expect(ci.permissions).toBeUndefined();
  });

  test("runs the same checks the release build runs", () => {
    const commands = runSteps(ci).map((s) => s.run.trim());
    expect(commands).toContain("bun run typecheck");
    expect(commands).toContain("bun test");
  });
});

describe("the shipped app configuration", () => {
  // In the repository this is the stable endpoint; inside a release build the
  // step before the tests has already rewritten it for the channel being built.
  // Either way the endpoint and the version have to agree, or a build would ask
  // the wrong channel for updates.
  test("reads the endpoint of the channel its version belongs to, and only that one", () => {
    const endpoints = tauriConfig.plugins.updater.endpoints;
    expect(endpoints).toHaveLength(1);
    const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(endpoints[0])?.[1];
    expect(repo).toBeTruthy();
    expect(endpoints[0]).toBe(endpointFor(channelOf(tauriConfig.version), repo));
  });

  test("carries a public key, so an unsigned update is rejected", () => {
    expect(tauriConfig.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
  });

  test("produces the artifacts the updater downloads", () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.bundle.targets).toContain("nsis");
  });

  test("installs per user, so neither installing nor updating asks for admin", () => {
    expect(tauriConfig.bundle.windows.nsis.installMode).toBe("currentUser");
    expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
  });

  test("the version in the repository is a version the release scripts understand", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe(tauriConfig.version);
    expect(read("src-tauri/Cargo.toml")).toContain(`version = "${pkg.version}"`);
  });

  test("the app can call the updater and restart itself", () => {
    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capabilities.permissions).toContain("updater:default");
    expect(capabilities.permissions).toContain("process:allow-restart");
  });

  test("the custom close handler can finish destroying the window", () => {
    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capabilities.permissions).toContain("core:window:allow-close");
    expect(capabilities.permissions).toContain("core:window:allow-destroy");
  });

  test("the window can paint the taskbar completion badge", () => {
    // Without the grant the overlay call fails at runtime, silently: the badge
    // simply never appears.
    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capabilities.permissions).toContain("core:window:allow-set-overlay-icon");
  });

  test("the release workflow is the only workflow that touches versions", () => {
    expect(releaseText).toContain("apply-version.mjs");
    expect(read(".github/workflows/ci.yml")).not.toContain("apply-version");
  });
});
