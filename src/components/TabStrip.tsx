import { useEffect, useRef, useState } from "react";

import type { Tab } from "../lib/types";
import type { DragState } from "../hooks/useDragPane";
import { BranchMenu } from "./BranchMenu";
import { ProjectMenu } from "./ProjectMenu";

/** Everything the tab strip needs to say which folder a tab is working in. */
export interface ProjectActions {
  recents: string[];
  /** Point an existing tab at a folder. */
  setFor: (tabId: string, path: string) => void;
  /** Open the folder picker for an existing tab. */
  browseFor: (tabId: string) => void;
  /** Open a new tab, already in that folder. */
  openInNewTab: (path: string) => void;
  browseInNewTab: () => void;
  /** Re-read the tab's project after a branch switch. */
  refresh: (tabId: string) => void;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  paneCounts: Record<string, number>;
  drag: DragState | null;
  projects: ProjectActions;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: (shellId?: string | null) => void;
  onReorder: (from: number, to: number) => void;
  onRename: (tabId: string, title: string) => void;
}

/** Which folder picker is open: one tab's, or the new-tab button's. */
type Picker = { kind: "tab"; tabId: string; x: number; y: number } | { kind: "new"; x: number; y: number };
type PickerRequest = { kind: "tab"; tabId: string } | { kind: "new" };

const FolderIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.8h4.5A1.5 1.5 0 0 1 14 6.3v5.2A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
);

/**
 * The tab strip is where a project lives.
 *
 * Every tab carries its own folder, so the folder is drawn inside the tab —
 * icon, name, and (on the tab you are in) the git branch. Warp puts the same
 * two facts in its tabs, and it is the one place the association cannot be
 * misread as a window-wide setting.
 */
export function TabStrip({
  tabs,
  activeTabId,
  paneCounts,
  drag,
  projects,
  onSelect,
  onClose,
  onNew,
  onReorder,
  onRename,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const reorder = useRef<{ tabId: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const state = reorder.current;
      const strip = stripRef.current;
      if (!state || !strip) return;
      const buttons = [...strip.querySelectorAll<HTMLElement>("[data-tab-id]")];
      const from = buttons.findIndex((b) => b.dataset.tabId === state.tabId);
      if (from < 0) return;
      let to = from;
      for (let i = 0; i < buttons.length; i++) {
        const rect = buttons[i].getBoundingClientRect();
        if (e.clientX > rect.left + rect.width / 2) to = i;
      }
      if (e.clientX < buttons[0].getBoundingClientRect().left) to = 0;
      if (to !== from) onReorder(from, to);
    };
    const up = () => {
      reorder.current = null;
      document.body.classList.remove("is-dragging-tab");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [onReorder]);

  const paneDropTab = drag?.target?.kind === "tab" ? drag.target.tabId : null;
  const paneDropNew = drag?.target?.kind === "newTab";

  /** Hang the folder picker under whatever was clicked. */
  const openPicker = (e: React.MouseEvent, picker: PickerRequest) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPicker({ ...picker, x: rect.left, y: rect.bottom + 6 } as Picker);
  };

  const pickerTab = picker?.kind === "tab" ? tabs.find((t) => t.id === picker.tabId) : null;

  return (
    <div className="tabstrip">
      <div className="tabs" ref={stripRef}>
        {tabs.map((tab) => {
          const count = paneCounts[tab.id] ?? 0;
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={[
                "tab",
                isActive ? "is-active" : "",
                paneDropTab === tab.id ? "is-drop" : "",
                tab.project ? "" : "is-unclaimed",
              ]
                .filter(Boolean)
                .join(" ")}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                onSelect(tab.id);
                reorder.current = { tabId: tab.id };
                document.body.classList.add("is-dragging-tab");
              }}
              onDoubleClick={() => setEditing(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab.id);
              }}
              onContextMenu={(e) => {
                // Right-click is the folder picker for that tab, wherever on the
                // tab it lands — no aiming at a 16px icon required.
                e.preventDefault();
                onSelect(tab.id);
                openPicker(e, { kind: "tab", tabId: tab.id });
              }}
            >
              {editing === tab.id ? (
                <input
                  className="tab-rename"
                  autoFocus
                  defaultValue={tab.title}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    onRename(tab.id, e.target.value.trim() || tab.title);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="tab-folder"
                    title={
                      tab.project
                        ? `${tab.project.path} — click to change this tab's folder`
                        : "This tab has no folder — click to choose one"
                    }
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(tab.id);
                      openPicker(e, { kind: "tab", tabId: tab.id });
                    }}
                  >
                    <FolderIcon />
                  </button>
                  <span className="tab-title">{tab.title}</span>
                  {isActive && tab.project?.is_git && (
                    <BranchMenu
                      project={tab.project}
                      onSwitched={() => projects.refresh(tab.id)}
                    />
                  )}
                  {count > 1 && <span className="tab-count">{count}</span>}
                  <button
                    type="button"
                    className="tab-close"
                    title="Close tab (Ctrl+Shift+Q)"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          );
        })}

        <div className="tab-new-wrap">
          <button
            type="button"
            data-new-tab=""
            className={`tab-new ${paneDropNew ? "is-drop" : ""}`}
            title="New tab in the default folder (Ctrl+Shift+T)"
            onClick={() => onNew(null)}
          >
            +
          </button>
          <button
            type="button"
            className={`tab-new tab-new-menu ${picker?.kind === "new" ? "is-open" : ""}`}
            title="Choose a folder for a new tab…"
            onClick={(e) => openPicker(e, { kind: "new" })}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.75 6 7.75l3-3" />
            </svg>
          </button>
        </div>
      </div>

      {picker?.kind === "tab" && pickerTab && (
        <ProjectMenu
          anchor={picker}
          scope={`Folder for “${pickerTab.title}”`}
          recents={projects.recents}
          current={pickerTab.project?.path ?? null}
          onPick={(path) => projects.setFor(pickerTab.id, path)}
          onBrowse={() => projects.browseFor(pickerTab.id)}
          onClose={() => setPicker(null)}
        />
      )}

      {picker?.kind === "new" && (
        <ProjectMenu
          anchor={picker}
          scope="Folder for a new tab"
          recents={projects.recents}
          current={null}
          onPick={projects.openInNewTab}
          onBrowse={projects.browseInNewTab}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
