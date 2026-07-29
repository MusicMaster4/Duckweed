import { type ReactNode, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  children: ReactNode;
  settingsActive: boolean;
  onOpenSettings: () => void;
  toolsOpen: boolean;
  onToggleTools: () => void;
  locked?: boolean;
}

export function TitleBar({
  children,
  settingsActive,
  onOpenSettings,
  toolsOpen,
  onToggleTools,
  locked = false,
}: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let disposed = false;
    const sync = async () => {
      const max = await win.isMaximized();
      if (!disposed) setMaximized(max);
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
        {/* Where the app icon used to sit. Warp puts its tool dock here too, and
            the corner is worth more as a control than as a logo. */}
        {!locked && (
          <button
            type="button"
            className={`tools-trigger ${toolsOpen ? "is-open" : ""}`}
            title={`${toolsOpen ? "Hide" : "Show"} the tools panel (Ctrl+Shift+X)`}
            aria-label="Tools panel"
            aria-expanded={toolsOpen}
            onClick={onToggleTools}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2" />
              <path d="M6.5 2.5v11" />
            </svg>
          </button>
        )}
      </div>

      <div className={`titlebar-tabs${locked ? " is-locked" : ""}`}>
        {locked ? <span className="titlebar-lock-label">Daily limit reached</span> : children}
      </div>

      <div className="titlebar-right">
        {!locked && (
          <button
            type="button"
            className={`win-btn settings-trigger ${settingsActive ? "is-open" : ""}`}
            title="Settings"
            aria-label="Settings"
            aria-pressed={settingsActive}
            onClick={onOpenSettings}
          >
            {/*
              Six-tooth cog: flat tips with a deep root (tip r 6.7 vs root r 4.35)
              so the teeth still read as teeth once the 1.4 stroke is applied at
              15px — the old shallow-tooth path collapsed into a blob.
            */}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="2" />
              <path d="M6.44 3.94 6.61 1.45h2.78l.17 2.49a4.35 4.35 0 0 1 1.18.68l2.24-1.1 1.39 2.41-2.07 1.39a4.35 4.35 0 0 1 0 1.36l2.07 1.39-1.39 2.41-2.24-1.1a4.35 4.35 0 0 1-1.18.68l-.17 2.49H6.61l-.17-2.49a4.35 4.35 0 0 1-1.18-.68l-2.24 1.1-1.39-2.41 2.07-1.39a4.35 4.35 0 0 1 0-1.36L1.63 5.93l1.39-2.41 2.24 1.1a4.35 4.35 0 0 1 1.18-.68z" />
            </svg>
          </button>
        )}
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
                {/*
                  The back square is drawn open — only the part that escapes the
                  front square. Two full rects overlapping read as a grid, not as
                  one window sitting on another.
                */}
                <path d="M4.25 3.75V2.25h5.5v5.5h-1.5" />
                <rect x="2.25" y="4.25" width="5.5" height="5.5" rx=".45" />
              </>
            ) : (
              <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1.2" />
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
