import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("settings tab", () => {
  test("the titlebar focuses one reusable settings tab", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("setSettingsTabOpen(true)");
    expect(app).toContain("setSettingsActive(true)");
    expect(app).not.toContain("setSettingsOpen((open) => !open)");
  });

  test("settings are rendered in the workspace instead of a popup", () => {
    const app = read("src/App.tsx");
    const settings = read("src/components/SettingsMenu.tsx");
    expect(app.indexOf("settingsActive ? (")).toBeLessThan(app.indexOf("<StatusBar"));
    expect(settings).toContain('className="settings-sidebar"');
    expect(settings).toContain('className="settings-content"');
    expect(settings).not.toContain("settings-backdrop");
  });

  test("only the visible view reports an active tab", () => {
    const strip = read("src/components/TabStrip.tsx");
    expect(strip).toContain("tab.id === activeTabId && !settingsActive");
    expect(strip).toContain("settingsOpen &&");
  });
});
