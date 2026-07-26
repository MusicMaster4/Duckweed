import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

describe("idle work stays bounded", () => {
  test("busy state uses one backend monitor instead of per-pane polling", () => {
    expect(read("src/components/TerminalPane.tsx")).not.toContain("setInterval");
    expect(read("src/lib/blocks.ts")).not.toContain("setInterval");
    expect(read("src-tauri/src/pty.rs")).toContain("pty-busy-monitor");
    expect(read("src-tauri/src/process_tree.rs")).toContain("parents_with_children");
  });

  test("persistent agents share one throttled completion monitor", () => {
    const activity = read("src-tauri/src/agent_activity.rs");
    expect(activity).toContain("agent-activity-monitor");
    expect(activity).toContain("DISCOVERY_POLL");
    expect(read("src/lib/terminals.ts")).not.toContain("setInterval");
  });

  test("project chrome is watcher-driven rather than timer-driven", () => {
    expect(read("src/hooks/useGitChanges.ts")).not.toContain("setInterval");
    expect(read("src/App.tsx")).not.toContain("BRANCH_POLL_MS");
    expect(read("src-tauri/src/watch.rs")).toContain('app.emit("project:changed"');
  });

  test("duck panes share one clock and stop offscreen", () => {
    const duck = read("src/components/PaneDuck.tsx");
    expect(duck).toContain("const ticks = new Set");
    expect(duck).toContain("IntersectionObserver");
    expect(duck).toContain("document.hidden");
    expect(duck).toContain("document.hasFocus()");
    expect(duck).not.toContain("requestAnimationFrame(clockStep)");
  });

  test("the Windows process snapshot is sampled at a bounded idle cadence", () => {
    const pty = read("src-tauri/src/pty.rs");
    expect(pty).toContain("Duration::from_millis(500)");
    expect(pty).not.toContain("Duration::from_millis(200)");
  });
});

describe("hot paths avoid global work", () => {
  test("PTY output is bounded and crosses IPC as raw binary", () => {
    const rust = read("src-tauri/src/pty.rs");
    const frontend = read("src/lib/terminals.ts");
    expect(rust).toContain("sync_channel::<Vec<u8>>(OUTPUT_QUEUE_CHUNKS)");
    expect(rust).toContain("Channel<Vec<u8>>");
    expect(rust).not.toContain("base64::");
    expect(frontend).toContain("Channel<ArrayBuffer>");
    expect(frontend).not.toContain("decodeBase64");
  });

  test("sessions have individual locks and scoped subscriptions", () => {
    const rust = read("src-tauri/src/pty.rs");
    const terminal = read("src/lib/terminals.ts");
    expect(rust).toContain("Arc<Mutex<Session>>");
    expect(terminal).toContain("subscribeSession");
    expect(terminal).toContain("subscribeSettings");
    expect(terminal).not.toContain("const listeners = new Set");
  });

  test("hidden terminals suspend WebGL and block overlay layout", () => {
    const terminal = read("src/lib/terminals.ts");
    expect(terminal).toContain("session.blocks.setActive(false)");
    expect(terminal).toContain("session.webgl?.dispose()");
  });

  test("interactive CLIs suspend shell block chrome", () => {
    const terminal = read("src/lib/terminals.ts");
    const blocks = read("src/lib/blocks.ts");
    expect(terminal).toContain("session.blocks.setEditorMode(enabled)");
    expect(blocks).toContain("if (!this.editorMode)");
    expect(blocks).toContain("if (busy)");
    expect(blocks).toContain("this.hideChrome()");
  });

  test("pointer gestures preview locally before committing state", () => {
    expect(read("src/hooks/useDragPane.ts")).toContain("--pane-drag-x");
    expect(read("src/components/ToolsPanel.tsx")).toContain("asideRef.current.style.width");
    expect(read("src/components/PaneTree.tsx")).toContain("onResize(state.next)");
  });
});

describe("large and blocking work is isolated", () => {
  test("filesystem and Git commands use blocking workers", () => {
    const main = read("src-tauri/src/main.rs");
    expect(main).toContain("tauri::async_runtime::spawn_blocking");
    expect(main).toContain("async fn git_diff_stats");
    expect(main).toContain("async fn list_dir");
  });

  test("large trees and diffs use native render virtualization", () => {
    const css = read("src/styles.css");
    expect(css.match(/content-visibility:\s*auto/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(css).toContain("contain-intrinsic-size");
  });

  test("first paint does not wait for shell or project discovery", () => {
    const app = read("src/App.tsx");
    expect(app.indexOf("setBooted(true)")).toBeLessThan(app.indexOf("await listShells()"));
    expect(app).toContain("frontendReady()");
  });

  test("CLI startup reuses shell discovery and Node's persistent compile cache", () => {
    const shells = read("src-tauri/src/shells.rs");
    const agents = read("src-tauri/src/agent_activity.rs");
    expect(shells).toContain("OnceLock<Vec<ShellInfo>>");
    expect(shells).toContain("SHELLS.get_or_init(discover_shells)");
    expect(agents).toContain("DISCOVERY_START_DELAY");
    expect(agents).toContain("!LOG_AGENTS.contains");
    expect(agents).toContain('"NODE_COMPILE_CACHE"');
    expect(agents).toContain('"NODE_DISABLE_COMPILE_CACHE"');
    expect(agents).toContain('"duckweed-node-compile-cache"');
  });

  test("usage work waits for Settings entry and polls only once a minute while open", () => {
    const app = read("src/App.tsx");
    const componentStart = app.indexOf("export default function App()");
    const openSettings = app.indexOf("const openSettings");
    const prefetch = app.indexOf("prefetchUsage(", componentStart);
    expect(prefetch).toBeGreaterThan(openSettings);
    expect(app.slice(componentStart, openSettings)).not.toContain("prefetchUsage(");
    const settings = read("src/components/SettingsMenu.tsx");
    expect(settings).toContain("{showUsage && <UsagePanel />}");
    const panel = read("src/components/UsagePanel.tsx");
    expect(panel).toContain("prefetchUsage(days, 0)");
    expect(panel).toContain("}, 60_000)");
  });

  test("a warm usage scan neither rewrites its index nor rediscovers Codex quotas", () => {
    const usage = read("src-tauri/src/usage/mod.rs");
    expect(usage).toContain("if index_dirty");
    expect(usage).toContain("latest_codex.as_ref()");
    const quota = read("src-tauri/src/usage/quota.rs");
    expect(quota).toContain("latest_codex_session: Option<&Path>");
  });

  test("release builds optimize runtime speed", () => {
    expect(read("src-tauri/Cargo.toml")).toMatch(/\[profile\.release\][\s\S]*opt-level\s*=\s*3/);
  });
});
