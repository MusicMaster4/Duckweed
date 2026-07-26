import { useEffect, useRef, type CSSProperties } from "react";

import { TAB_COLORS } from "../lib/tabColors";

interface Props {
  anchor: { x: number; y: number };
  pinned: boolean;
  color: string | null;
  canCloseOthers: boolean;
  onPin: () => void;
  onRename: () => void;
  onColor: (colorId: string | null) => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onDismiss: () => void;
}

/**
 * Right-click menu for a tab — pin, rename, close helpers, and a Warp-style
 * colour strip so tabs stay easy to spot.
 */
export function TabContextMenu({
  anchor,
  pinned,
  color,
  canCloseOthers,
  onPin,
  onRename,
  onColor,
  onClose,
  onCloseOthers,
  onDismiss,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

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
      </div>
    </>
  );
}
