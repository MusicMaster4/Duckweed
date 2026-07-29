import { useEffect, useRef, type CSSProperties } from "react";

import { TAB_COLORS } from "../lib/tabColors";
import { isDefaultTabIcon, TAB_ICONS, tabIconDef } from "../lib/tabIcons";

interface Props {
  anchor: { x: number; y: number };
  pinned: boolean;
  color: string | null;
  icon: string | null;
  canCloseOthers: boolean;
  onPin: () => void;
  onRename: () => void;
  onChangeFolder: () => void;
  onColor: (colorId: string | null) => void;
  onIcon: (iconId: string | null) => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onDismiss: () => void;
}

function MenuIcon({ id }: { id: string }) {
  const def = tabIconDef(id);
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="menu-icon-svg tab-glyph-fill">
      {def.paths.map((d, i) => (
        <path key={i} d={d} fillRule={def.evenodd ? "evenodd" : undefined} />
      ))}
    </svg>
  );
}

/**
 * Right-click menu for a tab — pin, rename, close helpers, and Warp-style
 * colour / icon strips so tabs stay easy to spot.
 */
export function TabContextMenu({
  anchor,
  pinned,
  color,
  icon,
  canCloseOthers,
  onPin,
  onRename,
  onChangeFolder,
  onColor,
  onIcon,
  onClose,
  onCloseOthers,
  onDismiss,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedIcon = isDefaultTabIcon(icon) ? null : icon;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = anchor.x;
    let top = anchor.y;
    if (rect.right > window.innerWidth - 8) left = Math.max(8, window.innerWidth - rect.width - 8);
    if (rect.bottom > window.innerHeight - 8) top = Math.max(8, anchor.y - rect.height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [anchor.x, anchor.y]);

  return (
    <>
      <div className="menu-backdrop" onPointerDown={onDismiss} />
      <div className="menu menu-tab" ref={ref} style={{ left: anchor.x, top: anchor.y }} role="menu">
        <button
          type="button"
          className="menu-item menu-item-row"
          role="menuitem"
          onClick={() => {
            onPin();
            onDismiss();
          }}
        >
          <span>{pinned ? "Unpin tab" : "Pin tab"}</span>
        </button>

        <button
          type="button"
          className="menu-item menu-item-row"
          role="menuitem"
          onClick={() => {
            onRename();
            onDismiss();
          }}
        >
          <span>Rename tab</span>
        </button>

        <button
          type="button"
          className="menu-item menu-item-row"
          role="menuitem"
          onClick={() => {
            onDismiss();
            onChangeFolder();
          }}
        >
          <span>Change folder…</span>
        </button>

        <div className="menu-separator" />

        <button
          type="button"
          className="menu-item menu-item-row"
          role="menuitem"
          onClick={() => {
            onClose();
            onDismiss();
          }}
        >
          <span>Close tab</span>
        </button>

        <button
          type="button"
          className="menu-item menu-item-row"
          role="menuitem"
          disabled={!canCloseOthers}
          onClick={() => {
            onCloseOthers();
            onDismiss();
          }}
        >
          <span>Close other tabs</span>
        </button>

        <div className="menu-separator" />

        <div className="menu-section-label">Color</div>
        <div className="menu-colors" role="group" aria-label="Tab color">
          <button
            type="button"
            className={`menu-color menu-color-none ${color == null ? "is-selected" : ""}`}
            title="Default"
            aria-label="Default color"
            aria-pressed={color == null}
            onClick={() => {
              onColor(null);
              onDismiss();
            }}
          >
            <span className="menu-color-slash" />
          </button>
          {TAB_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`menu-color ${color === c.id ? "is-selected" : ""}`}
              title={c.label}
              aria-label={c.label}
              aria-pressed={color === c.id}
              style={{ "--swatch": c.hex } as CSSProperties}
              onClick={() => {
                onColor(c.id);
                onDismiss();
              }}
            />
          ))}
        </div>

        <div className="menu-section-label">Icon</div>
        <div className="menu-icons" role="group" aria-label="Tab icon">
          {TAB_ICONS.map((ic) => {
            const isDefault = ic.id === "folder";
            const selected = isDefault ? selectedIcon == null : selectedIcon === ic.id;
            return (
              <button
                key={ic.id}
                type="button"
                className={`menu-icon ${selected ? "is-selected" : ""}`}
                title={ic.label}
                aria-label={ic.label}
                aria-pressed={selected}
                onClick={() => {
                  onIcon(isDefault ? null : ic.id);
                  onDismiss();
                }}
              >
                <MenuIcon id={ic.id} />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
