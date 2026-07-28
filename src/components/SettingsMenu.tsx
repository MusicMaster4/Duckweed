import { useLayoutEffect, useRef, useState } from "react";

import { UsagePanel } from "./UsagePanel";
import type { ShellIntegrationStatus } from "../lib/ipc";
import type { InputMode } from "../lib/terminals";
import type { ShellInfo } from "../lib/types";

interface Props {
  /** False while the settings tab exists but another tab is selected. */
  active?: boolean;
  fontSize: number;
  inputMode: InputMode;
  highlight: boolean;
  completionHighlights: boolean;
  completionSoundEnabled: boolean;
  /** Draw Duckweed's own interface over a recognised coding-agent CLI. */
  customAgentUi: boolean;
  confirmCloseRunning: boolean;
  /** Windows Explorer folder verbs; null when unavailable. */
  explorerIntegration: ShellIntegrationStatus | null;
  shell: string | null;
  shells: ShellInfo[];
  updateLabel: string;
  onFontSize: (size: number) => void;
  onToggleInputMode: () => void;
  onToggleHighlight: () => void;
  onToggleCompletionHighlights: () => void;
  onToggleCompletionSound: () => void;
  onToggleCustomAgentUi: () => void;
  onToggleConfirmCloseRunning: () => void;
  onToggleExplorerTab: () => void;
  onToggleExplorerWindow: () => void;
  /** Asks for confirmation first; resolves true when history was cleared. */
  onResetSuggestions: () => Promise<boolean>;
  onShell: (shellId: string | null) => void;
  onCheckUpdates: () => void;
}

function Toggle({ enabled }: { enabled: boolean }) {
  return (
    <span className={`settings-switch ${enabled ? "is-on" : ""}`} aria-hidden="true">
      <span />
    </span>
  );
}

type SettingsSection = "General" | "Appearance" | "Terminal" | "Usage" | "About";

// Survive SettingsMenu unmount when the settings tab is closed and reopened.
// (While the tab stays open, App keeps this tree mounted so the browser holds
// scroll natively when switching away to a terminal tab.)
let lastSettingsSection: SettingsSection = "General";
const lastSettingsScroll: Record<SettingsSection, number> = {
  General: 0,
  Appearance: 0,
  Terminal: 0,
  Usage: 0,
  About: 0,
};

export function SettingsMenu({
  active = true,
  fontSize,
  inputMode,
  highlight,
  completionHighlights,
  completionSoundEnabled,
  customAgentUi,
  confirmCloseRunning,
  explorerIntegration,
  shell,
  shells,
  updateLabel,
  onFontSize,
  onToggleInputMode,
  onToggleHighlight,
  onToggleCompletionHighlights,
  onToggleCompletionSound,
  onToggleCustomAgentUi,
  onToggleConfirmCloseRunning,
  onToggleExplorerTab,
  onToggleExplorerWindow,
  onResetSuggestions,
  onShell,
  onCheckUpdates,
}: Props) {
  const [section, setSectionState] = useState<SettingsSection>(lastSettingsSection);
  const [query, setQuery] = useState("");
  const [suggestionsCleared, setSuggestionsCleared] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);
  const sectionRef = useRef(section);
  const searchingRef = useRef(false);
  const activeRef = useRef(active);
  // While true, ignore scroll events so a clamped restore cannot overwrite the
  // real saved offset (that was the "lands in the middle" bug).
  const ignoreScrollRef = useRef(false);
  sectionRef.current = section;
  activeRef.current = active;

  const persistScroll = (forSection: SettingsSection = sectionRef.current) => {
    const el = contentRef.current;
    // Skip while hidden: some engines reset scrollTop on display:none and that
    // must not clobber the real offset we saved on deactivate.
    if (!el || !activeRef.current || searchingRef.current || ignoreScrollRef.current) return;
    lastSettingsScroll[forSection] = el.scrollTop;
  };

  const setSection = (next: SettingsSection) => {
    persistScroll(sectionRef.current);
    lastSettingsSection = next;
    setSectionState(next);
  };

  // Capture the exact scrollTop at the moment the scrollport is detached so a
  // full tab close still remembers position even if the last onScroll was missed.
  const setContentNode = (node: HTMLElement | null) => {
    if (contentRef.current && !node && activeRef.current && !searchingRef.current && !ignoreScrollRef.current) {
      lastSettingsScroll[sectionRef.current] = contentRef.current.scrollTop;
    }
    contentRef.current = node;
  };

  const roundedFontSize = Math.round(fontSize * 10) / 10;
  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  searchingRef.current = searching;
  const matches = (text: string) => !searching || text.toLowerCase().includes(normalizedQuery);
  const showAppearance =
    (section === "General" || section === "Appearance" || searching) &&
    (matches("appearance font size terminal text command editor") ||
      matches("syntax highlighting colour commands plain terminal output") ||
      matches("completion highlights finished process unread tab outline rose") ||
      matches("completion sound audio cue process agent finished") ||
      matches(
        "custom agent ui claude code codex cursor grok opencode coding agent interface overlay cli",
      ));
  const showTerminal =
    (section === "General" || section === "Terminal" || searching) &&
    (matches("terminal command editor compose commands grid type directly") ||
      matches("default shell system powershell") ||
      matches(
        "confirm close running process warn quit tab pane don't show again dont show",
      ) ||
      matches(
        "explorer open duckweed in new tab folder right click context menu shell integration",
      ) ||
      matches(
        "explorer open duckweed in new window folder right click context menu shell integration",
      ) ||
      matches("reset suggestions ghost autocomplete history learning clear forget"));
  const showAbout =
    (section === "General" || section === "About" || searching) &&
    matches("about updates version stable beta command palette");
  // The dashboard scans gigabytes of transcripts, so it loads only when asked
  // for by name — never as part of the General overview or a search sweep.
  const showUsage = section === "Usage" && !searching;
  const usageHit =
    searching && matches("usage statistics cost tokens spend quota limits agents models pricing");
  const visibleTitle = searching ? "Search results" : section;

  // When the host is about to hide, lock in the current scroll before the
  // engine can zero it via display:none.
  useLayoutEffect(() => {
    if (active) return;
    const el = contentRef.current;
    if (!el || searchingRef.current) return;
    lastSettingsScroll[sectionRef.current] = el.scrollTop;
  }, [active]);

  // Restore scroll after remount, section switch, or becoming active again.
  // Re-apply across frames while content is still shorter than the saved offset
  // (async Usage content); never write those clamped values into the store.
  useLayoutEffect(() => {
    if (!active) return;
    const el = contentRef.current;
    if (!el) return;

    if (searching) {
      ignoreScrollRef.current = true;
      el.scrollTop = 0;
      window.queueMicrotask(() => {
        ignoreScrollRef.current = false;
      });
      return;
    }

    const desired = lastSettingsScroll[section] ?? 0;
    let cancelled = false;
    let raf = 0;
    let attempts = 0;

    const apply = () => {
      if (cancelled || !contentRef.current) return;
      const node = contentRef.current;
      // Always read the module store — not a closed-over stale number — in case
      // the user scrolled during a previous frame of this same restore.
      const target = lastSettingsScroll[section] ?? desired;
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      ignoreScrollRef.current = true;
      node.scrollTop = Math.min(target, max);
      window.queueMicrotask(() => {
        if (!cancelled) ignoreScrollRef.current = false;
      });

      attempts += 1;
      // Content still too short for the real position (e.g. Usage still loading).
      if (target > max + 1 && attempts < 120) {
        raf = window.requestAnimationFrame(apply);
      }
    };

    apply();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      // Do not persist here: by cleanup time React has already committed the
      // next section's content, so scrollTop would belong to the wrong page.
      ignoreScrollRef.current = false;
    };
  }, [active, section, searching, showUsage]);

  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <label className="settings-search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="6.7" cy="6.7" r="4.2" />
            <path d="m10 10 3.3 3.3" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
          />
        </label>
        <nav aria-label="Settings sections">
          {(["General", "Appearance", "Terminal", "Usage", "About"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={section === item && !searching ? "is-active" : ""}
              onClick={() => {
                setQuery("");
                setSection(item);
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-foot">duckweed</div>
      </aside>

      <main
        ref={setContentNode}
        className="settings-content"
        aria-label="Settings"
        onScroll={() => persistScroll()}
      >
        <div className={`settings-content-inner${showUsage ? " is-wide" : ""}`}>
          <header className="settings-content-header">
            <span>Settings</span>
            <h1>{visibleTitle}</h1>
          </header>

          {usageHit && (
            <section className="settings-section">
              <h2>Usage</h2>
              <button
                type="button"
                className="settings-row settings-action"
                onClick={() => {
                  setQuery("");
                  setSection("Usage");
                }}
              >
                <span className="settings-copy">
                  <strong>Usage statistics</strong>
                  <span>Cost, tokens, models, and quotas across every coding agent</span>
                </span>
                <small className="settings-value">Open</small>
              </button>
            </section>
          )}

          {showUsage && <UsagePanel />}

          {showAppearance && (
            <section className="settings-section">
              <h2>Appearance</h2>
              {matches("appearance font size terminal text command editor") && (
                <div className="settings-row">
                  <div className="settings-copy">
                    <strong>Font size</strong>
                    <span>Terminal text and command editor</span>
                  </div>
                  <div className="settings-stepper">
                    <button type="button" aria-label="Decrease font size" onClick={() => onFontSize(fontSize - 1)}>
                      −
                    </button>
                    <span>{roundedFontSize}px</span>
                    <button type="button" aria-label="Increase font size" onClick={() => onFontSize(fontSize + 1)}>
                      +
                    </button>
                  </div>
                </div>
              )}
              {matches("syntax highlighting colour commands plain terminal output") && (
                <button type="button" className="settings-row settings-action" onClick={onToggleHighlight}>
                  <span className="settings-copy">
                    <strong>Syntax highlighting</strong>
                    <span>Colour commands and plain terminal output</span>
                  </span>
                  <Toggle enabled={highlight} />
                </button>
              )}
              {matches("completion highlights finished process unread tab outline rose") && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={onToggleCompletionHighlights}
                >
                  <span className="settings-copy">
                    <strong>Completion highlights</strong>
                    <span>Mark completed agent turns, or jobs that run over 30 seconds</span>
                  </span>
                  <Toggle enabled={completionHighlights} />
                </button>
              )}
              {matches("completion sound audio cue process agent finished") && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={onToggleCompletionSound}
                >
                  <span className="settings-copy">
                    <strong>Completion sound</strong>
                    <span>Play for finished agent turns and terminal jobs longer than one minute</span>
                  </span>
                  <Toggle enabled={completionSoundEnabled} />
                </button>
              )}
              {matches(
                "custom agent ui claude code codex cursor grok opencode coding agent interface overlay cli",
              ) && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={onToggleCustomAgentUi}
                >
                  <span className="settings-copy">
                    <strong>Custom Agent UI</strong>
                    <span>
                      Show thinking, tool calls, and live diffs instead of the terminal UI for
                      Claude Code, Codex, Cursor, Grok, and OpenCode
                    </span>
                  </span>
                  <Toggle enabled={customAgentUi} />
                </button>
              )}
            </section>
          )}

          {showTerminal && (
            <section className="settings-section">
              <h2>Terminal</h2>
              {matches("terminal command editor compose commands grid type directly") && (
                <button type="button" className="settings-row settings-action" onClick={onToggleInputMode}>
                  <span className="settings-copy">
                    <strong>Command editor</strong>
                    <span>{inputMode === "editor" ? "Compose commands below the grid" : "Type directly in the terminal"}</span>
                  </span>
                  <Toggle enabled={inputMode === "editor"} />
                </button>
              )}
              {matches("default shell system powershell") && (
                <label className="settings-field">
                  <span>
                    <strong>Default shell</strong>
                    <small>Shell used for new terminal sessions</small>
                  </span>
                  <select value={shell ?? ""} onChange={(event) => onShell(event.target.value || null)}>
                    <option value="">System default</option>
                    {shells.map((info) => (
                      <option key={info.id} value={info.id}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {matches(
                "confirm close running process warn quit tab pane don't show again dont show",
              ) && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={onToggleConfirmCloseRunning}
                >
                  <span className="settings-copy">
                    <strong>Confirm before closing</strong>
                    <span>Warn when a pane, tab, or the window still has a process running</span>
                  </span>
                  <Toggle enabled={confirmCloseRunning} />
                </button>
              )}
              {explorerIntegration !== null &&
                matches(
                  "explorer open duckweed in new tab folder right click context menu shell integration",
                ) && (
                  <button
                    type="button"
                    className="settings-row settings-action"
                    onClick={onToggleExplorerTab}
                  >
                    <span className="settings-copy">
                      <strong>Open in new tab</strong>
                      <span>Show “Open Duckweed in new tab” when right-clicking a folder</span>
                    </span>
                    <Toggle enabled={explorerIntegration.tab} />
                  </button>
                )}
              {explorerIntegration !== null &&
                matches(
                  "explorer open duckweed in new window folder right click context menu shell integration",
                ) && (
                  <button
                    type="button"
                    className="settings-row settings-action"
                    onClick={onToggleExplorerWindow}
                  >
                    <span className="settings-copy">
                      <strong>Open in new window</strong>
                      <span>Show “Open Duckweed in new window” when right-clicking a folder</span>
                    </span>
                    <Toggle enabled={explorerIntegration.window} />
                  </button>
                )}
              {(section === "Terminal" || searching) &&
                matches("reset suggestions ghost autocomplete history learning clear forget") && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={() => {
                    void onResetSuggestions().then((cleared) => {
                      if (!cleared) return;
                      setSuggestionsCleared(true);
                      window.setTimeout(() => setSuggestionsCleared(false), 2000);
                    });
                  }}
                >
                  <span className="settings-copy">
                    <strong>Reset suggestions</strong>
                    <span>Forget learned commands so ghost suggestions start fresh</span>
                  </span>
                  <small className="settings-value">{suggestionsCleared ? "Cleared" : "Reset"}</small>
                </button>
              )}
            </section>
          )}

          {showAbout && (
            <section className="settings-section">
              <h2>About</h2>
              <button type="button" className="settings-row settings-action" onClick={onCheckUpdates}>
                <span className="settings-copy">
                  <strong>Check for updates</strong>
                  <span>Look for a newer Duckweed release</span>
                </span>
                <small className="settings-value">{updateLabel}</small>
              </button>
              <div className="settings-row">
                <span className="settings-copy">
                  <strong>Command palette</strong>
                  <span>Search commands and app actions</span>
                </span>
                <kbd>Ctrl+Shift+P</kbd>
              </div>
            </section>
          )}

          {!showAppearance && !showTerminal && !showAbout && !showUsage && !usageHit && (
            <div className="settings-empty">
              <strong>No settings found</strong>
              <span>Try a different search.</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
