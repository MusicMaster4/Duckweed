import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import type { Tab } from "../lib/types";
import { tabColorHex } from "../lib/tabColors";
import { tabIconDef } from "../lib/tabIcons";
import type { DragState } from "../hooks/useDragPane";
import { CompletionDot } from "./CompletionDot";
import { ProjectMenu } from "./ProjectMenu";
import { TabContextMenu } from "./TabContextMenu";

/** Everything the tab strip needs to say which folder a tab is working in. */
export interface ProjectActions {
  recents: string[];
  /** Point an existing tab at a folder. */
  setFor: (tabId: string, path: string) => void;
  /** Open the folder picker for an existing tab. */
  browseFor: (tabId: string) => void;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  paneCounts: Record<string, number>;
  unreadCounts: Record<string, number>;
  /** When false, hide completion dots (tracking still runs in the app). */
  completionHighlights: boolean;
  drag: DragState | null;
  projects: ProjectActions;
  /** New empty tabs are locked until the active tab has a folder. */
  allowNewTab: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onNew: (shellId?: string | null) => void;
  onReorder: (from: number, to: number) => void;
  onRename: (tabId: string, title: string) => void;
  onPin: (tabId: string) => void;
  onColor: (tabId: string, colorId: string | null) => void;
  onIcon: (tabId: string, iconId: string | null) => void;
  settingsOpen: boolean;
  settingsActive: boolean;
  onSelectSettings: () => void;
  onCloseSettings: () => void;
}

/** Folder picker open on a tab. */
type Picker = { tabId: string; x: number; y: number };

type ContextMenu = { tabId: string; x: number; y: number };

const TabGlyph = ({ iconId }: { iconId: string | null | undefined }) => {
  const def = tabIconDef(iconId);
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="tab-glyph-fill">
      {def.paths.map((d, i) => (
        <path key={i} d={d} fillRule={def.evenodd ? "evenodd" : undefined} />
      ))}
    </svg>
  );
};

const PinIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="tab-pin">
    <path
      d="M9.6 2.4 8.2 3.8l.7 2.1-1.9 1.9-1.1-.4L4.5 8.8l2.7 2.7 1.4-1.4-.4-1.1 1.9-1.9 2.1.7 1.4-1.4zM5.2 11.5 3 13.7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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
  unreadCounts,
  completionHighlights,
  drag,
  projects,
  allowNewTab,
  onSelect,
  onClose,
  onCloseOthers,
  onNew,
  onReorder,
  onRename,
  onPin,
  onColor,
  onIcon,
  settingsOpen,
  settingsActive,
  onSelectSettings,
  onCloseSettings,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const reorder = useRef<{ tabId: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [context, setContext] = useState<ContextMenu | null>(null);

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
  const openPicker = (e: MouseEvent, tabId: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContext(null);
    setPicker({ tabId, x: rect.left, y: rect.bottom + 6 });
  };

  const pickerTab = picker ? tabs.find((t) => t.id === picker.tabId) : null;
  const contextTab = context ? tabs.find((t) => t.id === context.tabId) : null;

  return (
    <div className="tabstrip">
      <div className="tabs" ref={stripRef} role="tablist" aria-label="Open tabs">
        {tabs.map((tab) => {
          const count = paneCounts[tab.id] ?? 0;
          const unread = unreadCounts[tab.id] ?? 0;
          const showUnread = completionHighlights && unread > 0;
          const isActive = tab.id === activeTabId && !settingsActive;
          const accent = tabColorHex(tab.color);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-label={
                showUnread
                  ? `${tab.title}, ${unread} finished terminal${unread === 1 ? "" : "s"} not reviewed`
                  : tab.title
              }
              tabIndex={isActive ? 0 : -1}
              className={[
                "tab",
                isActive ? "is-active" : "",
                paneDropTab === tab.id ? "is-drop" : "",
                tab.project ? "" : "is-unclaimed",
                tab.pinned ? "is-pinned" : "",
                accent ? "is-colored" : "",
                showUnread ? "is-unread" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={accent ? ({ "--tab-color": accent } as CSSProperties) : undefined}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                onSelect(tab.id);
                reorder.current = { tabId: tab.id };
                document.body.classList.add("is-dragging-tab");
              }}
              onDoubleClick={() => setEditing(tab.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onSelect(tab.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(tab.id);
                setPicker(null);
                setContext({ tabId: tab.id, x: e.clientX, y: e.clientY });
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
                  {tab.pinned && <PinIcon />}
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
                      openPicker(e, tab.id);
                    }}
                  >
                    <TabGlyph iconId={tab.icon} />
                  </button>
                  <span className="tab-title">{tab.title}</span>
                  {count > 1 && <span className="tab-count">{count}</span>}
                  <CompletionDot
                    active={showUnread}
                    className="tab-completion-dot"
                    title={`${unread} finished terminal${unread === 1 ? "" : "s"} not reviewed`}
                    aria-hidden="true"
                  />
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

        {settingsOpen && (
          <div
            role="tab"
            aria-selected={settingsActive}
            tabIndex={settingsActive ? 0 : -1}
            className={`tab settings-tab ${settingsActive ? "is-active" : ""}`}
            onPointerDown={(event) => {
              if (event.button === 0) onSelectSettings();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelectSettings();
            }}
          >
            <span className="settings-tab-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="2" />
                <path d="M6.44 3.94 6.61 1.45h2.78l.17 2.49a4.35 4.35 0 0 1 1.18.68l2.24-1.1 1.39 2.41-2.07 1.39a4.35 4.35 0 0 1 0 1.36l2.07 1.39-1.39 2.41-2.24-1.1a4.35 4.35 0 0 1-1.18.68l-.17 2.49H6.61l-.17-2.49a4.35 4.35 0 0 1-1.18-.68l-2.24 1.1-1.39-2.41 2.07-1.39a4.35 4.35 0 0 1 0-1.36L1.63 5.93l1.39-2.41 2.24 1.1a4.35 4.35 0 0 1 1.18-.68z" />
              </svg>
            </span>
            <span className="tab-title">Settings</span>
            <button
              type="button"
              className="tab-close"
              title="Close settings"
              aria-label="Close settings"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onCloseSettings();
              }}
            >
              ✕
            </button>
          </div>
        )}

        <div className={`tab-new-wrap ${allowNewTab ? "" : "is-locked"}`}>
          <button
            type="button"
            {...(allowNewTab ? { "data-new-tab": "" } : {})}
            className={`tab-new ${paneDropNew && allowNewTab ? "is-drop" : ""}`}
            title={
              allowNewTab
                ? "New tab in the default folder (Ctrl+Shift+T)"
                : "Choose a folder for this tab before opening another"
            }
            disabled={!allowNewTab}
            onClick={() => {
              if (allowNewTab) onNew(null);
            }}
          >
            +
          </button>
        </div>
      </div>

      {picker && pickerTab && (
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

      {context && contextTab && (
        <TabContextMenu
          anchor={context}
          pinned={contextTab.pinned === true}
          color={contextTab.color ?? null}
          icon={contextTab.icon ?? null}
          canCloseOthers={tabs.length > 1}
          onPin={() => onPin(contextTab.id)}
          onRename={() => setEditing(contextTab.id)}
          onColor={(colorId) => onColor(contextTab.id, colorId)}
          onIcon={(iconId) => onIcon(contextTab.id, iconId)}
          onClose={() => onClose(contextTab.id)}
          onCloseOthers={() => onCloseOthers(contextTab.id)}
          onDismiss={() => setContext(null)}
        />
      )}
    </div>
  );
}
