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
    expect(app.indexOf("settingsTabOpen &&")).toBeLessThan(app.indexOf("<StatusBar"));
    expect(app).toContain("settings-host");
    expect(settings).toContain('className="settings-sidebar"');
    expect(settings).toContain('className="settings-content"');
    expect(settings).not.toContain("settings-backdrop");
  });

  test("settings stay mounted while the tab is open so scroll is preserved", () => {
    const app = read("src/App.tsx");
    const settings = read("src/components/SettingsMenu.tsx");
    const css = read("src/styles.css");
    // Keep-alive: tab open mounts host; inactive only hides it (not unmount).
    expect(app).toContain("settingsTabOpen &&");
    expect(app).toContain("settings-host");
    expect(app).toContain('is-active');
    expect(app).toContain("active={settingsActive}");
    expect(app).toContain("!settingsActive &&");
    expect(css).toContain(".settings-host:not(.is-active)");
    expect(css).not.toContain(".settings-host[hidden]");
    // Section + scroll memory for close/reopen and sidebar section switches.
    expect(settings).toContain("lastSettingsSection");
    expect(settings).toContain("lastSettingsScroll");
    expect(settings).toContain("onScroll={() => persistScroll()}");
    expect(settings).toContain("ignoreScrollRef");
  });

  test("only the visible view reports an active tab", () => {
    const strip = read("src/components/TabStrip.tsx");
    expect(strip).toContain("tab.id === activeTabId && !settingsActive");
    expect(strip).toContain("settingsOpen");
  });

  test("settings is a strip citizen that can be reordered", () => {
    const strip = read("src/components/TabStrip.tsx");
    const app = read("src/App.tsx");
    const reorder = read("src/lib/tabReorder.ts");
    expect(reorder).toContain('export const SETTINGS_TAB_ID = "__settings__"');
    expect(strip).toContain("data-strip-id={SETTINGS_TAB_ID}");
    expect(strip).toContain("beginReorder(event, SETTINGS_TAB_ID)");
    // Pane drops stay on real terminal tabs only.
    expect(strip).toContain("data-strip-id={tab.id}");
    expect(strip).toContain("data-tab-id={tab.id}");
    expect(app).toContain("settingsTabIndex");
    expect(app).toContain("applyStripReorder");
  });
});
