import { useEffect, useRef, useState } from "react";

import type { ShellInfo, Tab } from "../lib/types";
import type { DragState } from "../hooks/useDragPane";

interface Props {
  tabs: Tab[];
  activeTabId: string;
  paneCounts: Record<string, number>;
  shells: ShellInfo[];
  activeShell: string | null;
  drag: DragState | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: (shellId?: string | null) => void;
  onReorder: (from: number, to: number) => void;
  onRename: (tabId: string, title: string) => void;
}

export function TabStrip({
  tabs,
  activeTabId,
  paneCounts,
  shells,
  activeShell,
  drag,
  onSelect,
  onClose,
  onNew,
  onReorder,
  onRename,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const reorder = useRef<{ tabId: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [shellMenu, setShellMenu] = useState(false);

  useEffect(() => {
    if (!shellMenu) return;
    const close = () => setShellMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [shellMenu]);

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

  return (
    <div className="tabstrip">
      <div className="tabs" ref={stripRef}>
        {tabs.map((tab) => {
          const count = paneCounts[tab.id] ?? 0;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={[
                "tab",
                tab.id === activeTabId ? "is-active" : "",
                paneDropTab === tab.id ? "is-drop" : "",
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
                  <span className="tab-title">{tab.title}</span>
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
            title="New tab (Ctrl+Shift+T)"
            onClick={() => onNew(null)}
          >
            +
          </button>
          {shells.length > 1 && (
            <button
              type="button"
              className="tab-new tab-new-caret"
              title="New tab with a specific shell"
              onPointerDown={(e) => {
                e.stopPropagation();
                setShellMenu((v) => !v);
              }}
            >
              ⌄
            </button>
          )}
          {shellMenu && (
            <div className="menu menu-shells" onPointerDown={(e) => e.stopPropagation()}>
              {shells.map((shell) => (
                <button
                  key={shell.id}
                  type="button"
                  className={`menu-item ${shell.id === activeShell ? "is-current" : ""}`}
                  onClick={() => {
                    setShellMenu(false);
                    onNew(shell.id);
                  }}
                >
                  <span>{shell.label}</span>
                  <span className="menu-hint">{shell.program}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
