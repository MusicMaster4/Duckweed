import { useEffect, useRef, useState } from "react";
import type { TabGroup } from "../lib/types";

interface Props {
  group: TabGroup;
  count: number;
  working: boolean;
  active: boolean;
  unread: boolean;
  onUpdate: (patch: Partial<Pick<TabGroup, "name" | "collapsed">> | null) => void;
}

export function TabGroupLabel({ group, count, working, active, unread, onUpdate }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    }
    inputRef.current?.select();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setMenu(null); }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [menu]);

  const saveName = () => {
    onUpdate({ name: inputRef.current?.value.trim() || group.name });
    setMenu(null);
  };

  return <>
    <button
      type="button"
      className={`tab-group-label${active ? " is-active" : ""}${unread ? " is-unread" : ""}`}
      data-group-id={group.id}
      aria-expanded={!group.collapsed}
      aria-label={`${group.name}, ${count} tabs${working ? ", agent working" : ""}`}
      title={`${group.name}: click to ${group.collapsed ? "expand" : "collapse"}, right-click to edit`}
      onClick={() => onUpdate({ collapsed: !group.collapsed })}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "F2" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom });
        }
      }}
    >
      {working && <span className="tab-work-shimmer" aria-hidden="true" />}
      <span aria-hidden="true">{group.collapsed ? "›" : "⌄"}</span>
      <span className="tab-title">{group.name}</span>
      <span className="tab-count">{count}</span>
    </button>
    {menu && <>
      <div className="menu-backdrop" onPointerDown={saveName} />
      <div className="menu tab-group-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }} role="dialog" aria-label="Edit tab group">
        <form onSubmit={(event) => { event.preventDefault(); saveName(); }}>
          <input ref={inputRef} autoFocus className="tab-rename" aria-label="Group name" defaultValue={group.name} maxLength={80} />
          <button type="submit" className="menu-item">Save name</button>
        </form>
        <div className="menu-separator" />
        <button type="button" className="menu-item" onClick={() => { onUpdate(null); setMenu(null); }}>Ungroup tabs</button>
      </div>
    </>}
  </>;
}
