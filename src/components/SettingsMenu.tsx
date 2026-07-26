import { useState } from "react";

import { UsagePanel } from "./UsagePanel";
import type { InputMode } from "../lib/terminals";
import type { ShellInfo } from "../lib/types";

interface Props {
  fontSize: number;
  inputMode: InputMode;
  highlight: boolean;
  confirmCloseRunning: boolean;
  shell: string | null;
  shells: ShellInfo[];
  updateLabel: string;
  onFontSize: (size: number) => void;
  onToggleInputMode: () => void;
  onToggleHighlight: () => void;
  onToggleConfirmCloseRunning: () => void;
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

export function SettingsMenu({
  fontSize,
  inputMode,
  highlight,
  confirmCloseRunning,
  shell,
  shells,
  updateLabel,
  onFontSize,
  onToggleInputMode,
  onToggleHighlight,
  onToggleConfirmCloseRunning,
  onShell,
  onCheckUpdates,
}: Props) {
  const [section, setSection] = useState<SettingsSection>("General");
  const [query, setQuery] = useState("");
  const roundedFontSize = Math.round(fontSize * 10) / 10;
  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const matches = (text: string) => !searching || text.toLowerCase().includes(normalizedQuery);
  const showAppearance =
    (section === "General" || section === "Appearance" || searching) &&
    (matches("appearance font size terminal text command editor") ||
      matches("syntax highlighting colour commands plain terminal output"));
  const showTerminal =
    (section === "General" || section === "Terminal" || searching) &&
    (matches("terminal command editor compose commands grid type directly") ||
      matches("default shell system powershell") ||
      matches(
        "confirm close running process warn quit tab pane don't show again dont show",
      ));
  const showAbout =
    (section === "General" || section === "About" || searching) &&
    matches("about updates version stable beta command palette");
  // The dashboard scans gigabytes of transcripts, so it loads only when asked
  // for by name — never as part of the General overview or a search sweep.
  const showUsage = section === "Usage" && !searching;
  const usageHit =
    searching && matches("usage statistics cost tokens spend quota limits agents models pricing");
  const visibleTitle = searching ? "Search results" : section;

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

      <main className="settings-content" aria-label="Settings">
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
