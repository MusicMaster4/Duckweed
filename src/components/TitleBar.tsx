import { type ReactNode, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../../src-tauri/icons/32x32.png";

import { isFullscreen, toggleFullscreen } from "../lib/window";

interface Props {
  children: ReactNode;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}

export function TitleBar({ children, settingsOpen, onToggleSettings }: Props) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let disposed = false;
    const sync = async () => {
      const full = await isFullscreen();
      if (!disposed) setFullscreen(full);
    };
    void sync();
    const unlisten = win.onResized(() => void sync());
    return () => {
      disposed = true;
      void unlisten.then((off) => off());
    };
  }, []);

  const win = () => getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <span className="brand" data-tauri-drag-region title="Duckweed">
          <img src={appIcon} alt="" draggable={false} />
        </span>
      </div>

      <div className="titlebar-tabs">{children}</div>

      <div className="titlebar-right">
        <button
          type="button"
          className="win-btn"
          title={fullscreen ? "Exit fullscreen (F11)" : "Fullscreen (F11)"}
          onClick={() => void toggleFullscreen().then(setFullscreen)}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {fullscreen ? (
              <>
                <path d="M5 1.5v3.5H1.5" />
                <path d="M7 10.5V7h3.5" />
              </>
            ) : (
              <>
                <path d="M4.5 1.5H1.5V4.5" />
                <path d="M7.5 10.5h3v-3" />
              </>
            )}
          </svg>
        </button>
        <button type="button" className="win-btn" title="Minimize" onClick={() => void win().minimize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <line x1="2.5" y1="6" x2="9.5" y2="6" />
          </svg>
        </button>
        <button
          type="button"
          className={`win-btn settings-trigger ${settingsOpen ? "is-open" : ""}`}
          title="Settings"
          aria-label="Settings"
          aria-expanded={settingsOpen}
          onClick={onToggleSettings}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="2.25" />
            <path d="M6.9 2.1h2.2l.45 1.55c.3.12.58.28.84.48l1.55-.4 1.1 1.9-1.1 1.15c.03.2.05.4.05.62s-.02.42-.05.62l1.1 1.15-1.1 1.9-1.55-.4c-.26.2-.54.36-.84.48l-.45 1.55H6.9l-.45-1.55a4.3 4.3 0 0 1-.84-.48l-1.55.4-1.1-1.9 1.1-1.15A4 4 0 0 1 4 7.4c0-.21.02-.42.05-.62l-1.1-1.15 1.1-1.9 1.55.4c.26-.2.54-.36.84-.48z" />
          </svg>
        </button>
        <button type="button" className="win-btn win-close" title="Close" onClick={() => void win().close()}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        </button>
      </div>
    </header>
  );
}
