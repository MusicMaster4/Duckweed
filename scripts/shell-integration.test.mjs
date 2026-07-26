import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("explorer shell integration", () => {
  test("installer enables only the new-tab verb by default", () => {
    const hooks = read("src-tauri/windows/hooks.nsh");
    const postInstall = hooks.slice(
      hooks.indexOf("NSIS_HOOK_POSTINSTALL"),
      hooks.indexOf("NSIS_HOOK_PREUNINSTALL"),
    );
    expect(postInstall).toContain("Open Duckweed in new tab");
    expect(postInstall).toContain("duckweed://action/new_tab?path=%1");
    expect(postInstall).toContain("duckweed://action/new_tab?path=%V");
    expect(postInstall).toContain("DefaultsApplied");
    // Window is opt-in from Settings — not written at install time.
    expect(postInstall).not.toContain("DuckweedWindow");
    expect(postInstall).not.toContain("new_window");
    // Uninstall still cleans up a window verb the user may have enabled later.
    expect(hooks).toContain("NSIS_HOOK_PREUNINSTALL");
    expect(hooks).toContain('DeleteRegKey HKCU "Software\\Classes\\Directory\\shell\\DuckweedWindow"');
  });

  test("tauri conf wires the NSIS installer hooks", () => {
    const conf = read("src-tauri/tauri.conf.json");
    expect(conf).toContain("installerHooks");
    expect(conf).toContain("./windows/hooks.nsh");
  });

  test("settings exposes separate tab and window toggles", () => {
    const settings = read("src/components/SettingsMenu.tsx");
    expect(settings).toContain("Open in new tab");
    expect(settings).toContain("Open in new window");
    expect(settings).toContain("onToggleExplorerTab");
    expect(settings).toContain("onToggleExplorerWindow");
    expect(settings).toContain("explorerIntegration.tab");
    expect(settings).toContain("explorerIntegration.window");
  });

  test("app opens launch intents as new project tabs", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("takeLaunchIntent");
    expect(app).toContain("launch-intent");
    expect(app).toContain("handleLaunchIntent");
    expect(app).toContain('shellIntegrationSet("tab"');
    expect(app).toContain('shellIntegrationSet("window"');
  });

  test("backend treats tab and window as independent verbs", () => {
    const main = read("src-tauri/src/main.rs");
    const shell = read("src-tauri/src/shell_integration.rs");
    expect(main).toContain("shell_integration_set");
    expect(main).toContain("ensure_defaults");
    expect(shell).toContain("ShellVerb");
    expect(shell).toContain("Open Duckweed in new tab");
    expect(shell).toContain("Open Duckweed in new window");
    expect(shell).toContain("ensure_defaults");
    expect(shell).toContain("// Window stays off unless the user opts in.");
  });
});
