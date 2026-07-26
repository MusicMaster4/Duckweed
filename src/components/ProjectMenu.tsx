import { useEffect, useRef } from "react";

interface Props {
  /** Where the popup hangs from, in viewport coordinates. */
  anchor: { x: number; y: number };
  /** Says out loud what the pick applies to — this is never a window-wide setting. */
  scope: string;
  recents: string[];
  /** Folder already in use, marked in the list. */
  current: string | null;
  onPick: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The folder picker: browse, or one of the folders you have opened before.
 *
 * It is deliberately never mounted in the window chrome — it hangs off the tab
 * (or the new-tab button) it acts on, because a project belongs to a tab and a
 * control parked next to the app icon reads as a setting for the whole window.
 */
export function ProjectMenu({ anchor, scope, recents, current, onPick, onBrowse, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Anchored menus are placed from the left edge; near the right edge of the
  // window that would run off-screen, so pull it back in after layout.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.getBoundingClientRect().right - window.innerWidth + 8;
    if (overflow > 0) el.style.left = `${Math.max(8, anchor.x - overflow)}px`;
  }, [anchor.x]);

  return (
    <>
      <div className="menu-backdrop" onPointerDown={onClose} />
      <div className="menu menu-projects" ref={ref} style={{ left: anchor.x, top: anchor.y }}>
        <div className="menu-scope">{scope}</div>

        <button
          type="button"
          className="menu-item menu-browse"
          onClick={() => {
            onClose();
            onBrowse();
          }}
        >
          <span>Choose a folder…</span>
          <span className="menu-hint">Browse the file system</span>
        </button>

        {recents.length > 0 && <div className="menu-separator" />}

        {recents.map((path) => (
          <button
            key={path}
            type="button"
            className={`menu-item ${path === current ? "is-current" : ""}`}
            onClick={() => {
              onClose();
              onPick(path);
            }}
          >
            <span>{basename(path)}</span>
            <span className="menu-hint">{path}</span>
          </button>
        ))}
      </div>
    </>
  );
}
