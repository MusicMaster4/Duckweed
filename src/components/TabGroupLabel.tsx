import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { TabGroup } from "../lib/types";
import { TAB_COLORS, tabColorHex } from "../lib/tabColors";

interface Props {
  group: TabGroup;
  count: number;
  working: boolean;
  active: boolean;
  unread: boolean;
  onCollapseOthers?: () => void;
  onExpandAll?: () => void;
  onUpdate: (patch: Partial<Pick<TabGroup, "name" | "collapsed" | "color">> | null) => void;
}

export function TabGroupLabel({ group, count, working, active, unread, onUpdate, onCollapseOthers, onExpandAll }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const color = tabColorHex(group.color);
  const dismiss = () => { setMenu(null); buttonRef.current?.focus(); };
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
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [menu]);

  const update = (patch: Partial<Pick<TabGroup, "name" | "collapsed" | "color">> | null) => {
    onUpdate(patch ? { name: inputRef.current?.value.trim() || group.name, ...patch } : null);
    dismiss();
  };
  const saveName = () => update({});

  return <>
    <button
      type="button"
      ref={buttonRef}
      className={`tab-group-label${active ? " is-active" : ""}${unread ? " is-unread" : ""}${color ? " is-colored" : ""}`}
      style={color ? { "--group-color": color } as CSSProperties : undefined}
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
      <svg className="tab-group-chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m6 4 4 4-4 4" />
      </svg>
      <span className="tab-title">{group.name}</span>
      <span className="tab-group-count">{count}</span>
    </button>
    {menu && <>
      <div className="menu-backdrop" onPointerDown={saveName} />
      <div className="menu tab-group-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }} role="dialog" aria-label="Edit tab group">
        <form onSubmit={(event) => { event.preventDefault(); saveName(); }}>
          <label className="tab-group-name-label">Group name
          <input ref={inputRef} autoFocus className="tab-rename" aria-label="Group name" defaultValue={group.name} maxLength={80} />
          </label>
          <button type="submit" className="menu-item">Save name</button>
        </form>
        <div className="menu-separator" />
        <div className="tab-group-color-label">Group color</div>
        <div className="menu-colors" role="group" aria-label="Group color">
          <button type="button" className={`menu-color menu-color-none${!color ? " is-selected" : ""}`}
            title="Default" aria-label="Default color" aria-pressed={!color} onClick={() => update({ color: null })}>
            <span className="menu-color-slash" />
          </button>
          {TAB_COLORS.map((swatch) => <button key={swatch.id} type="button"
            className={`menu-color${group.color === swatch.id ? " is-selected" : ""}`}
            title={swatch.label} aria-label={swatch.label} aria-pressed={group.color === swatch.id}
            style={{ "--swatch": swatch.hex } as CSSProperties} onClick={() => update({ color: swatch.id })} />)}
        </div>
        <div className="menu-separator" />
        <button type="button" className="menu-item" onClick={() => update({ collapsed: !group.collapsed })}>{group.collapsed ? "Expand group" : "Collapse group"}</button>
        <button type="button" className="menu-item menu-item-row" disabled={!onCollapseOthers} onClick={() => { saveName(); onCollapseOthers?.(); }}>Collapse other groups</button>
        <button type="button" className="menu-item menu-item-row" disabled={!onExpandAll} onClick={() => { saveName(); onExpandAll?.(); }}>Expand all groups</button>
        <div className="menu-separator" />
        <button type="button" className="menu-item" onClick={() => update(null)}>Ungroup tabs</button>
      </div>
    </>}
  </>;
}
