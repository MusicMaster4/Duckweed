import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("settings survive app updates", () => {
  test("restores native app-data before settings modules initialize", () => {
    const main = read("src/main.tsx");
    expect(main.indexOf("await restoreDurableStorage()")).toBeLessThan(
      main.indexOf('await import("./App")'),
    );
  });

  test("all Duckweed preferences are mirrored outside WebView storage", () => {
    const durable = read("src/lib/durableStorage.ts");
    expect(durable).toContain('"duckweed:state:v1"');
    expect(durable).toContain('"duckweed:usage:v1"');
    expect(durable).toContain('"duckweed:agent-preferences:v1"');
    expect(durable).toContain('"duckweed:command-history:v1"');
    expect(read("src/lib/persist.ts")).toContain("saveDurably(KEY, raw)");
    expect(read("src/lib/usage.ts")).toContain("saveDurably(KEY, raw)");
    expect(read("src/lib/agents/preferences.ts")).toContain(
      "saveDurably(AGENT_PREFERENCES_KEY, raw)",
    );
  });

  test("native storage lives in the stable per-user app-data directory", () => {
    const backend = read("src-tauri/src/main.rs");
    expect(backend).toContain(".app_data_dir()");
    expect(backend).toContain('join("durable-settings.json")');
    expect(backend).toContain("DURABLE_SETTING_KEYS");
    expect(backend).toContain('"duckweed:agent-preferences:v1"');
  });
});
