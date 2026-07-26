import { useEffect } from "react";

import type { InputMode } from "../lib/terminals";
import type { ShellInfo } from "../lib/types";

interface Props {
  fontSize: number;
  inputMode: InputMode;
  highlight: boolean;
  shell: string | null;
  shells: ShellInfo[];
  updateLabel: string;
  onFontSize: (size: number) => void;
  onToggleInputMode: () => void;
  onToggleHighlight: () => void;
  onShell: (shellId: string | null) => void;
  onCheckUpdates: () => void;
  onClose: () => void;
}

function Toggle({ enabled }: { enabled: boolean }) {
  return (
    <span className={`settings-switch ${enabled ? "is-on" : ""}`} aria-hidden="true">
      <span />
    </span>
  );
}

export function SettingsMenu({
  fontSize,
  inputMode,
  highlight,
  shell,
  shells,
  updateLabel,
  onFontSize,
  onToggleInputMode,
  onToggleHighlight,
  onShell,
  onCheckUpdates,
  onClose,
}: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const roundedFontSize = Math.round(fontSize * 10) / 10;

  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <section
        className="settings-menu"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <strong>Settings</strong>
            <span>Terminal preferences</span>
          </div>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="settings-section">
          <span className="settings-section-title">Appearance</span>
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
          <button type="button" className="settings-row settings-action" onClick={onToggleHighlight}>
            <span className="settings-copy">
              <strong>Syntax highlighting</strong>
              <span>Colour plain terminal output</span>
            </span>
            <Toggle enabled={highlight} />
          </button>
        </div>

        <div className="settings-section">
          <span className="settings-section-title">Terminal</span>
          <button type="button" className="settings-row settings-action" onClick={onToggleInputMode}>
            <span className="settings-copy">
              <strong>Command editor</strong>
              <span>{inputMode === "editor" ? "Compose commands below the grid" : "Type directly in the terminal"}</span>
            </span>
            <Toggle enabled={inputMode === "editor"} />
          </button>
          <label className="settings-field">
            <span>Default shell</span>
            <select value={shell ?? ""} onChange={(event) => onShell(event.target.value || null)}>
              <option value="">System default</option>
              {shells.map((info) => (
                <option key={info.id} value={info.id}>
                  {info.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-footer">
          <button
            type="button"
            className="settings-update"
            onClick={() => {
              onClose();
              onCheckUpdates();
            }}
          >
            <span>Check for updates</span>
            <small>{updateLabel}</small>
          </button>
          <span className="settings-shortcut">
            Command palette <kbd>Ctrl+Shift+P</kbd>
          </span>
        </div>
      </section>
    </div>
  );
}
