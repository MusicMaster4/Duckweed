import { type ReactNode, useCallback, useRef, useState, useSyncExternalStore } from "react";

import { ChecklistTool } from "./ChecklistTool";
import { PowerWatchTool } from "./PowerWatchTool";
import { ProjectExplorer } from "./ProjectExplorer";
import { Tooltip } from "./Tooltip";
import * as checklist from "../lib/checklist";
import * as powerWatch from "../lib/powerWatch";
import type { ProjectInfo } from "../lib/types";

interface Props {
  project: ProjectInfo | null;
  /** Visible tab. Checklists are filed per tab, and named after it. */
  tabId: string | null;
  tabTitle: string;
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
  onInsertPath: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onBrowseProject: () => void;
  onOpenFile: (path: string) => void;
}

export const TOOLS_MIN_WIDTH = 190;
export const TOOLS_MAX_WIDTH = 560;

type SectionId = "files" | "checklist" | "power";

/**
 * The picker at the top of the panel: every tool the dock holds, named, in one
 * row of clickable chips. Icons alone stop being legible the moment there is
 * more than one of them, and this list is meant to grow.
 */
const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  {
    id: "files",
    label: "Files",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z" />
        <path d="M9 2v3.5h3.5" />
      </svg>
    ),
  },
  {
    id: "checklist",
    label: "Checklist",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.5 4.5l1.5 1.5 2.5-3" />
        <path d="M2.5 11l1.5 1.5 2.5-3" />
        <path d="M8.5 4.5h5M8.5 11h5" />
      </svg>
    ),
  },
  {
    id: "power",
    label: "Power",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2v5" />
        <path d="M4.9 4.4a5 5 0 1 0 6.2 0" />
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
  tabId,
  tabTitle,
  width,
  onWidth,
  onClose,
  onInsertPath,
  onOpenFolder,
  onBrowseProject,
  onOpenFile,
}: Props) {
  const [section, setSection] = useState<SectionId>("files");
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width });
  const asideRef = useRef<HTMLElement>(null);
  const liveWidth = useRef(width);
  if (!dragging) liveWidth.current = width;

  // Badges on the picker, so a list with work left in it and an armed power
  // watch are both visible from whichever tool happens to be open.
  const readOpenItems = useCallback(() => (tabId ? checklist.openCount(tabId) : 0), [tabId]);
  const openItems = useSyncExternalStore(checklist.subscribe, readOpenItems, readOpenItems);
  const watchPhase = useSyncExternalStore(
    powerWatch.subscribe,
    () => powerWatch.getState().phase,
    () => powerWatch.getState().phase,
  );

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

  const badgeFor = (id: SectionId): ReactNode => {
    if (id === "checklist" && openItems > 0) {
      return <span className="tools-tab-badge">{openItems}</span>;
    }
    if (id === "power" && (watchPhase === "armed" || watchPhase === "countdown")) {
      return (
        <span
          className={`tools-tab-dot ${watchPhase === "countdown" ? "is-hot" : ""}`}
          aria-label="armed"
        />
      );
    }
    return null;
  };

  return (
    <aside ref={asideRef} className="tools" style={{ width }}>
      <header className="tools-rail">
        <div className="tools-picker" role="tablist" aria-label="Tools">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={`tools-tab ${section === entry.id ? "is-active" : ""}`}
              aria-selected={section === entry.id}
              onClick={() => setSection(entry.id)}
            >
              {entry.icon}
              <span className="tools-tab-label">{entry.label}</span>
              {badgeFor(entry.id)}
            </button>
          ))}
        </div>
        <Tooltip title="Hide the dock" detail="The panel closes and the grid takes the room back." shortcut="Ctrl+Shift+X">
          <button
            type="button"
            className="tools-hide"
            aria-label="Hide the tools panel"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
          </button>
        </Tooltip>
      </header>

      <div className="tools-body">
        {section === "files" && (
          <ProjectExplorer
            project={project}
            onInsertPath={onInsertPath}
            onOpenFolder={onOpenFolder}
            onBrowseProject={onBrowseProject}
            onOpenFile={onOpenFile}
          />
        )}
        {section === "checklist" && <ChecklistTool scope={tabId} scopeLabel={tabTitle} />}
        {section === "power" && <PowerWatchTool />}
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
