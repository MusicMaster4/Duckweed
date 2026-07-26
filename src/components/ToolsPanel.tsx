import { type ReactNode, useCallback, useRef, useState } from "react";

import { ProjectExplorer } from "./ProjectExplorer";
import type { ProjectInfo } from "../lib/types";

interface Props {
  project: ProjectInfo | null;
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  onInsertPath: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onBrowseProject: () => void;
}

export const TOOLS_MIN_WIDTH = 190;
export const TOOLS_MAX_WIDTH = 560;

type SectionId = "files";

/**
 * The rail at the top of the panel. One entry today; the shape is the point —
 * anything else that wants a sidebar (a chat, a search, a runbook) becomes a
 * section here rather than another modal.
 */
const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  {
    id: "files",
    label: "Project explorer",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z" />
        <path d="M9 2v3.5h3.5" />
      </svg>
    ),
  },
];

/**
 * Warp's left dock: a strip of tools that shares the window with the grid
 * instead of covering it, so a folder can be read while a command runs.
 */
export function ToolsPanel({
  project,
  width,
  onWidth,
  onClose,
  onInsertPath,
  onOpenFolder,
  onBrowseProject,
}: Props) {
  const [section, setSection] = useState<SectionId>("files");
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width });
  const asideRef = useRef<HTMLElement>(null);
  const liveWidth = useRef(width);
  if (!dragging) liveWidth.current = width;

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, width };
      liveWidth.current = width;
      setDragging(true);
    },
    [width],
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const next = start.current.width + (e.clientX - start.current.x);
      liveWidth.current = Math.min(TOOLS_MAX_WIDTH, Math.max(TOOLS_MIN_WIDTH, Math.round(next)));
      if (asideRef.current) asideRef.current.style.width = `${liveWidth.current}px`;
    },
    [],
  );

  const onResizeUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setDragging(false);
      onWidth(liveWidth.current);
    },
    [onWidth],
  );

  return (
    <aside ref={asideRef} className="tools" style={{ width }}>
      <header className="tools-rail">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tools-tab ${section === entry.id ? "is-active" : ""}`}
            title={entry.label}
            aria-label={entry.label}
            aria-pressed={section === entry.id}
            onClick={() => setSection(entry.id)}
          >
            {entry.icon}
          </button>
        ))}
        <span className="tools-spacer" />
        <button
          type="button"
          className="tools-tab"
          title="Hide the tools panel (Ctrl+Shift+X)"
          aria-label="Hide the tools panel"
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </header>

      <div className="tools-body">
        {section === "files" && (
          <ProjectExplorer
            project={project}
            onInsertPath={onInsertPath}
            onOpenFolder={onOpenFolder}
            onBrowseProject={onBrowseProject}
          />
        )}
      </div>

      <div
        className={`tools-resize ${dragging ? "is-dragging" : ""}`}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </aside>
  );
}
