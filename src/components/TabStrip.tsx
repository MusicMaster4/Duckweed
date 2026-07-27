import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { Tab } from "../lib/types";
import { tabColorHex } from "../lib/tabColors";
import { tabIconDef } from "../lib/tabIcons";
import {
  SETTINGS_TAB_ID,
  clampLeft,
  dropIndex,
  restingLeft,
  slotShift,
} from "../lib/tabReorder";
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
  /** Index of Settings among strip items (0..tabs.length). */
  settingsIndex: number;
  onSelectSettings: () => void;
  onCloseSettings: () => void;
}

/** Folder picker open on a tab. */
type Picker = { tabId: string; x: number; y: number };

type ContextMenu = { tabId: string; x: number; y: number };

/** Where a tab sat when the drag began. */
type Slot = { el: HTMLElement; left: number; width: number };

/** A tab being dragged along the strip. */
type Reorder = {
  tabId: string;
  /** Pointer x at pointerdown, measured against the slop threshold. */
  startX: number;
  /** Distance from the pointer to the tab's left edge — held constant. */
  grabOffset: number;
  /** Index the drag started from. */
  from: number;
  /** Index the tab would land on if dropped now. */
  to: number;
  /** The strip as it was when the drag began; never re-measured. */
  slots: Slot[];
  /**
   * Count of pinned tabs at drag start. Unpinned tabs reorder only to the
   * right of this block; pinned tabs never enter a drag at all.
   */
  pinnedCount: number;
  dragging: boolean;
};

/** Pointer travel before a press turns into a drag. */
const DRAG_SLOP = 4;

/** How long tabs take to slide into a new order. */
const SLIDE_MS = 170;
const SLIDE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

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

/** Upright pushpin — filled so the global stroke-only svg rule does not distort it. */
const PinIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="tab-pin">
    <path d="M8 1.25c-1.52 0-2.75 1.23-2.75 2.75v1.1H4.5a.75.75 0 0 0 0 1.5h.42c.22 1.35 1.2 2.45 2.48 2.85v3.8a.75.75 0 0 0 1.5 0v-3.8c1.28-.4 2.26-1.5 2.48-2.85h.37a.75.75 0 0 0 0-1.5h-.75V4c0-1.52-1.23-2.75-2.75-2.75z" />
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
  settingsIndex,
  onSelectSettings,
  onCloseSettings,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const reorder = useRef<Reorder | null>(null);
  /** Drop animation in flight — run it early if another gesture starts. */
  const settling = useRef<(() => void) | null>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [context, setContext] = useState<ContextMenu | null>(null);

  useEffect(() => {
    /**
     * Snapshot the strip once, when the gesture turns into a drag. Every later
     * decision is made against this frozen layout: the tabs are being moved
     * around by transforms, so live rects would feed the gesture its own
     * output and the drag would fight itself.
     *
     * Strip items use `data-strip-id` (tabs + Settings). Pane drops still use
     * `data-tab-id`, which only real terminal tabs carry.
     */
    const snapshot = (tabId: string) => {
      const strip = stripRef.current;
      if (!strip) return null;
      const els = [...strip.querySelectorAll<HTMLElement>("[data-strip-id]")];
      const from = els.findIndex((el) => el.dataset.stripId === tabId);
      if (from < 0) return null;
      // Pinned tabs are fixed — never start a drag for them.
      if (els[from].dataset.pinned === "true") return null;
      const slots = els.map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, left: rect.left, width: rect.width };
      });
      // Contiguous pinned block on the left (pin/unpin always reorders this way).
      let pinnedCount = 0;
      for (const el of els) {
        if (el.dataset.pinned !== "true") break;
        pinnedCount++;
      }
      return { slots, from, pinnedCount };
    };

    /** Slide everything into the new order, then hand it to React. */
    const settle = (state: Reorder) => {
      const { slots, from, to, pinnedCount } = state;
      const width = slots[from].width;
      const rest = restingLeft(slots, from, to);

      for (let i = 0; i < slots.length; i++) {
        const { el } = slots[i];
        const shift =
          i === from ? rest - slots[from].left : slotShift(i, from, to, width, pinnedCount);
        el.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASE}`;
        el.style.transform = shift ? `translateX(${shift}px)` : "translateX(0px)";
      }

      // The transforms are only a preview: once they have played out the tabs
      // are already sitting in the new order, so dropping them and letting
      // React re-render the real order is invisible.
      const commit = () => {
        settling.current = null;
        for (const { el } of slots) {
          el.style.transition = "";
          el.style.transform = "";
        }
        document.body.classList.remove("is-dragging-tab");
        setDragTabId(null);
        if (to !== from) onReorder(from, to);
      };
      settling.current = commit;
      window.setTimeout(() => {
        if (settling.current === commit) commit();
      }, SLIDE_MS);
    };

    /** End the gesture — dropping the tab where it currently reads as being. */
    const finish = () => {
      const state = reorder.current;
      reorder.current = null;
      if (!state) return;
      if (!state.dragging) return; // A plain click: nothing was ever moved.
      settle(state);
    };

    const move = (e: PointerEvent) => {
      const state = reorder.current;
      if (!state) return;
      // A click is a click until the pointer has travelled far enough that the
      // user clearly means to move the tab rather than just select it.
      if (!state.dragging) {
        if (Math.abs(e.clientX - state.startX) < DRAG_SLOP) return;
        const shot = snapshot(state.tabId);
        if (!shot) {
          // Pinned (or gone) — abandon the gesture so it never becomes a drag.
          reorder.current = null;
          return;
        }
        state.dragging = true;
        state.slots = shot.slots;
        state.from = shot.from;
        state.to = shot.from;
        state.pinnedCount = shot.pinnedCount;
        document.body.classList.add("is-dragging-tab");
        setDragTabId(state.tabId);
      }

      const { slots, from, pinnedCount } = state;
      const width = slots[from].width;
      const left = clampLeft(slots, from, e.clientX - state.grabOffset, pinnedCount);
      const to = dropIndex(slots, from, left, pinnedCount);
      state.to = to;

      // The dragged tab tracks the pointer exactly; the tabs it has passed
      // step aside by its width and are eased there by CSS. Pinned tabs stay put.
      slots[from].el.style.transform = `translateX(${left - slots[from].left}px)`;
      for (let i = 0; i < slots.length; i++) {
        if (i === from) continue;
        const shift = slotShift(i, from, to, width, pinnedCount);
        slots[i].el.style.transform = shift ? `translateX(${shift}px)` : "translateX(0px)";
      }
    };

    /** Escape puts the tab back where the drag started. */
    const key = (e: KeyboardEvent) => {
      const state = reorder.current;
      if (!state || !state.dragging || e.key !== "Escape") return;
      reorder.current = null;
      state.to = state.from;
      settle(state);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", key);
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

  /** Begin a strip reorder after the pointer moves past the slop threshold. */
  const beginReorder = (e: ReactPointerEvent<HTMLElement>, stripId: string) => {
    if (e.button !== 0) return;
    settling.current?.();
    const rect = e.currentTarget.getBoundingClientRect();
    reorder.current = {
      tabId: stripId,
      startX: e.clientX,
      grabOffset: e.clientX - rect.left,
      from: 0,
      to: 0,
      slots: [],
      pinnedCount: 0,
      dragging: false,
    };
  };

  const pickerTab = picker ? tabs.find((t) => t.id === picker.tabId) : null;
  const contextTab = context ? tabs.find((t) => t.id === context.tabId) : null;

  // Interleave Settings at `settingsIndex` so it reorders with the rest.
  type StripItem =
    | { kind: "tab"; tab: Tab }
    | { kind: "settings" };
  const stripItems: StripItem[] = [];
  if (settingsOpen) {
    const insertAt = Math.min(Math.max(0, settingsIndex), tabs.length);
    tabs.forEach((tab, i) => {
      if (i === insertAt) stripItems.push({ kind: "settings" });
      stripItems.push({ kind: "tab", tab });
    });
    if (insertAt >= tabs.length) stripItems.push({ kind: "settings" });
  } else {
    for (const tab of tabs) stripItems.push({ kind: "tab", tab });
  }

  return (
    <div className="tabstrip">
      <div className="tabs" ref={stripRef} role="tablist" aria-label="Open tabs">
        {stripItems.map((item) => {
          if (item.kind === "settings") {
            return (
              <div
                key={SETTINGS_TAB_ID}
                data-strip-id={SETTINGS_TAB_ID}
                role="tab"
                aria-selected={settingsActive}
                tabIndex={settingsActive ? 0 : -1}
                className={[
                  "tab",
                  "settings-tab",
                  settingsActive ? "is-active" : "",
                  dragTabId === SETTINGS_TAB_ID ? "is-reordering" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  onSelectSettings();
                  beginReorder(event, SETTINGS_TAB_ID);
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
            );
          }

          const tab = item.tab;
          const count = paneCounts[tab.id] ?? 0;
          const unread = unreadCounts[tab.id] ?? 0;
          const showUnread = completionHighlights && unread > 0;
          const isActive = tab.id === activeTabId && !settingsActive;
          const accent = tabColorHex(tab.color);
          return (
            <div
              key={tab.id}
              data-strip-id={tab.id}
              data-tab-id={tab.id}
              data-pinned={tab.pinned ? "true" : undefined}
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
                dragTabId === tab.id ? "is-reordering" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={accent ? ({ "--tab-color": accent } as CSSProperties) : undefined}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                onSelect(tab.id);
                // Pinned tabs stay put — select only, no reorder gesture.
                if (tab.pinned) {
                  settling.current?.();
                  reorder.current = null;
                  return;
                }
                beginReorder(e, tab.id);
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
