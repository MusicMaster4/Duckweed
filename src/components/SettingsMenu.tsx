import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { UsagePanel } from "./UsagePanel";
import { MobileNotificationsSettings } from "./MobileNotificationsSettings";
import {
  formatDailyLimit,
  formatUsageDuration,
  remainingMinutesOf,
} from "../lib/dailyUsage";
import type { ShellIntegrationStatus } from "../lib/ipc";
import type { InputMode } from "../lib/terminals";
import type { ShellInfo } from "../lib/types";
import type { AgentFollowupMode } from "../lib/agents/types";
import type { Channel } from "../lib/version";

interface Props {
  /** False while the settings tab exists but another tab is selected. */
  active?: boolean;
  fontSize: number;
  inputMode: InputMode;
  highlight: boolean;
  completionHighlights: boolean;
  completionSoundEnabled: boolean;
  tintWorkspaceWithTabColor: boolean;
  wellbeingEnabled: boolean;
  dailyLimitMinutes: number;
  dailyUsedMs: number;
  /** Recognised agent sessions currently open across all workspace panes. */
  openAgentCount: number;
  /** Draw Duckweed's own interface over a recognised coding-agent CLI. */
  customAgentUi: boolean;
  agentFollowupMode: AgentFollowupMode;
  autoApproveLockedRequests: boolean;
  confirmCloseRunning: boolean;
  /** Windows Explorer folder verbs; null when unavailable. */
  explorerIntegration: ShellIntegrationStatus | null;
  shell: string | null;
  shells: ShellInfo[];
  updateLabel: string;
  updateChannel: Channel;
  onFontSize: (size: number) => void;
  onToggleInputMode: () => void;
  onToggleHighlight: () => void;
  onToggleCompletionHighlights: () => void;
  onToggleCompletionSound: () => void;
  onToggleTintWorkspaceWithTabColor: () => void;
  onToggleWellbeing: () => void;
  onDailyLimitMinutes: (minutes: number) => void;
  onToggleCustomAgentUi: () => void;
  onAgentFollowupMode: (mode: AgentFollowupMode) => void;
  onAutoApproveLockedRequests: (enabled: boolean) => void;
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

function ApprovalConsentDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="approval-consent-backdrop" onPointerDown={onCancel}>
      <div
        className="approval-consent-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-consent-title"
        aria-describedby="approval-consent-body"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="approval-consent-kicker">Unattended access</span>
        <h2 id="approval-consent-title">Allow automatic approvals?</h2>
        <p id="approval-consent-body">
          While the daily limit screen is active, Duckweed will approve agent
          permission requests without asking you. This may run destructive
          commands, change or delete files, expose data, or cause other damage.
          If an agent asks a question, Duckweed will choose its first option.
        </p>
        <label className="approval-consent-check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>I understand and accept these risks.</span>
        </label>
        <div className="approval-consent-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="is-danger"
            disabled={!acknowledged}
            onClick={onConfirm}
          >
            Enable automatic approvals
          </button>
        </div>
      </div>
    </div>
  );
}

type SettingsSection =
  | "General"
  | "Appearance"
  | "Agents"
  | "Terminal"
  | "Usage"
  | "Wellbeing"
  | "About";

// Survive SettingsMenu unmount when the settings tab is closed and reopened.
// (While the tab stays open, App keeps this tree mounted so the browser holds
// scroll natively when switching away to a terminal tab.)
let lastSettingsSection: SettingsSection = "General";
const lastSettingsScroll: Record<SettingsSection, number> = {
  General: 0,
  Appearance: 0,
  Agents: 0,
  Terminal: 0,
  Usage: 0,
  Wellbeing: 0,
  About: 0,
};

export function SettingsMenu({
  active = true,
  fontSize,
  inputMode,
  highlight,
  completionHighlights,
  completionSoundEnabled,
  tintWorkspaceWithTabColor,
  wellbeingEnabled,
  dailyLimitMinutes,
  dailyUsedMs,
  openAgentCount,
  customAgentUi,
  agentFollowupMode,
  autoApproveLockedRequests,
  confirmCloseRunning,
  explorerIntegration,
  shell,
  shells,
  updateLabel,
  updateChannel,
  onFontSize,
  onToggleInputMode,
  onToggleHighlight,
  onToggleCompletionHighlights,
  onToggleCompletionSound,
  onToggleTintWorkspaceWithTabColor,
  onToggleWellbeing,
  onDailyLimitMinutes,
  onToggleCustomAgentUi,
  onAgentFollowupMode,
  onAutoApproveLockedRequests,
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
  const [approvalConsentOpen, setApprovalConsentOpen] = useState(false);
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
      matches("tint workspace background active tab colour frame status bar") ||
      matches("completion highlights finished process unread tab outline rose") ||
      matches("completion sound audio cue process agent finished"));
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
  const showAgents =
    (section === "General" || section === "Agents" || searching) &&
    (matches(
      "custom agent ui claude code codex cursor grok opencode coding agent interface overlay cli",
    ) ||
      matches(
        "active turn messages follow-up queue steer send now alt shift enter agent delivery",
      ) ||
      matches(
        "mobile notifications android companion phone pair qr apk encrypted response project",
      ));
  const showAbout =
    (section === "General" || section === "About" || searching) &&
    matches("about updates version stable beta command palette");
  // The dashboard scans gigabytes of transcripts, so it loads only when asked
  // for by name — never as part of the General overview or a search sweep.
  const showUsage = section === "Usage" && !searching;
  const usageHit =
    searching && matches("usage statistics cost tokens spend quota limits agents models pricing");
  const showWellbeing =
    (section === "Wellbeing" || searching) &&
    (matches("wellbeing health daily usage time limit focus lock lockout hours") ||
      matches("today focused time remaining midnight agents background") ||
      matches(
        "automatic approvals unattended agents permission requests risk damage destructive",
      ));
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
          {(["General", "Appearance", "Agents", "Terminal", "Usage", "Wellbeing", "About"] as const).map((item) => (
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

          {showUsage && <UsagePanel openAgentCount={openAgentCount} />}

          {showWellbeing && (
            <>
              <section className="settings-section">
                <h2>Daily usage</h2>
              {matches("wellbeing health daily usage time limit focus lock lockout hours") && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={onToggleWellbeing}
                >
                  <span className="settings-copy">
                    <strong>Daily time limit</strong>
                    <span>
                      Lock Duckweed after this much focused use, without stopping active work
                    </span>
                  </span>
                  <Toggle enabled={wellbeingEnabled} />
                </button>
              )}
              {matches("wellbeing health daily usage time limit focus lock lockout hours") && (
                <div className={`settings-row${wellbeingEnabled ? "" : " is-disabled"}`}>
                  <span className="settings-copy">
                    <strong>Time allowed per day</strong>
                    <span>Focused time only. Background and minimized time do not count</span>
                  </span>
                  <div className="settings-stepper wellbeing-stepper">
                    <button
                      type="button"
                      aria-label="Decrease daily time limit"
                      disabled={!wellbeingEnabled || dailyLimitMinutes <= 30}
                      onClick={() => onDailyLimitMinutes(dailyLimitMinutes - 30)}
                    >
                      −
                    </button>
                    <span>{formatDailyLimit(dailyLimitMinutes)}</span>
                    <button
                      type="button"
                      aria-label="Increase daily time limit"
                      disabled={!wellbeingEnabled || dailyLimitMinutes >= 24 * 60}
                      onClick={() => onDailyLimitMinutes(dailyLimitMinutes + 30)}
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
              {matches("today focused time remaining midnight agents background") && (
                <div className="settings-row wellbeing-today">
                  <span className="settings-copy">
                    <strong>Today</strong>
                    <span>
                      {wellbeingEnabled
                        ? `${formatUsageDuration(dailyUsedMs)} used · ${formatDailyLimit(
                            remainingMinutesOf(dailyLimitMinutes, dailyUsedMs),
                          )} remaining`
                        : "Turn on the daily limit to begin tracking focused time"}
                    </span>
                  </span>
                  <div
                    className="wellbeing-progress"
                    role="progressbar"
                    aria-label="Daily focused usage"
                    aria-valuemin={0}
                    aria-valuemax={dailyLimitMinutes * 60_000}
                    aria-valuenow={Math.min(
                      dailyUsedMs,
                      dailyLimitMinutes * 60_000,
                    )}
                  >
                    <span
                      style={{
                        width: wellbeingEnabled
                          ? `${Math.min(
                              100,
                              (dailyUsedMs / (dailyLimitMinutes * 60_000)) * 100,
                            )}%`
                          : "0%",
                      }}
                    />
                  </div>
                </div>
              )}
              </section>

              {matches(
                "automatic approvals unattended agents permission requests risk damage destructive",
              ) && (
                <section className="settings-section">
                  <h2>Unattended agents</h2>
                  <button
                    type="button"
                    className="settings-row settings-action"
                    aria-pressed={autoApproveLockedRequests}
                    onClick={() => {
                      if (autoApproveLockedRequests) {
                        onAutoApproveLockedRequests(false);
                        return;
                      }
                      setApprovalConsentOpen(true);
                    }}
                  >
                    <span className="settings-copy">
                      <strong>Approve requests during lockout</strong>
                      <span>
                        Let agents continue by automatically approving permission
                        requests after the daily limit is reached
                      </span>
                    </span>
                    <Toggle enabled={autoApproveLockedRequests} />
                  </button>
                  <p className="settings-risk-note">
                    Automatic approvals can run destructive actions and cause data
                    loss. Agent questions automatically use their first option.
                  </p>
                </section>
              )}
            </>
          )}

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
              {matches("tint workspace background active tab colour frame status bar") && (
                <button
                  type="button"
                  className="settings-row settings-action"
                  onClick={onToggleTintWorkspaceWithTabColor}
                >
                  <span className="settings-copy">
                    <strong>Tint workspace background</strong>
                    <span>Use the active tab colour in the workspace frame and status bar</span>
                  </span>
                  <Toggle enabled={tintWorkspaceWithTabColor} />
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
            </section>
          )}

          {showAgents && (
            <>
            <section className="settings-section">
              <h2>Agents</h2>
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
                      Use thinking, tool calls, and live diffs for new Claude Code, Codex,
                      Cursor, Grok, and OpenCode sessions. Current sessions keep running
                    </span>
                  </span>
                  <Toggle enabled={customAgentUi} />
                </button>
              )}
              {matches(
                "active turn messages follow-up queue steer send now alt shift enter agent delivery",
              ) && (
                <label className="settings-field">
                  <span>
                    <strong>Active-turn messages</strong>
                    <small>
                      Unsupported agents keep queueing. Alt+Shift+Enter uses the other method
                    </small>
                  </span>
                  <select
                    value={agentFollowupMode}
                    onChange={(event) =>
                      onAgentFollowupMode(event.target.value === "steer" ? "steer" : "queue")
                    }
                  >
                    <option value="queue">Queue follow-up</option>
                    <option value="steer">Steer immediately</option>
                  </select>
                </label>
              )}
            </section>
            {matches(
              "mobile notifications android companion phone pair qr apk encrypted response project",
            ) && <MobileNotificationsSettings channel={updateChannel} />}
            </>
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

          {!showAppearance &&
            !showAgents &&
            !showTerminal &&
            !showAbout &&
            !showUsage &&
            !showWellbeing &&
            !usageHit && (
            <div className="settings-empty">
              <strong>No settings found</strong>
              <span>Try a different search.</span>
            </div>
          )}
        </div>
      </main>
      {approvalConsentOpen && (
        <ApprovalConsentDialog
          onCancel={() => setApprovalConsentOpen(false)}
          onConfirm={() => {
            onAutoApproveLockedRequests(true);
            setApprovalConsentOpen(false);
          }}
        />
      )}
    </div>
  );
}
