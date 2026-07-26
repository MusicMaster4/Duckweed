import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../../src-tauri/icons/32x32.png";

import { isFullscreen, toggleFullscreen } from "../lib/window";

interface Props {
  onOpenPalette: () => void;
}

export function TitleBar({ onOpenPalette }: Props) {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let disposed = false;
    const sync = async () => {
      const [max, full] = await Promise.all([win.isMaximized(), isFullscreen()]);
      if (disposed) return;
      setMaximized(max);
      setFullscreen(full);
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

      <div className="titlebar-center" data-tauri-drag-region>
        <button type="button" className="omni" onClick={onOpenPalette} title="Command palette (Ctrl+Shift+P)">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2 13.5 13.5" />
          </svg>
          <span>Search actions…</span>
          <kbd>Ctrl+Shift+P</kbd>
        </button>
      </div>

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
          className="win-btn"
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void win().toggleMaximize()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {maximized ? (
              <>
                <rect x="2" y="3.5" width="6" height="6" rx="1" />
                <path d="M4.2 3.5V2.5h5.3v5.3H8.5" />
              </>
            ) : (
              <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
            )}
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
