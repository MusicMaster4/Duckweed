import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentImageAttachment } from "../../lib/agents/types";
import { writeClipboardImage } from "../../lib/clipboard";

interface Props {
  images: AgentImageAttachment[];
  onRemove?: (id: string) => void;
  variant?: "composer" | "message";
}

const IMAGE_REMOVE_FALLBACK_MS = 220;

interface ImageContextMenu {
  x: number;
  y: number;
  copyFailed: boolean;
}

/** Shared thumbnail strip and full-size viewer for drafts and sent messages. */
export function AgentImageAttachments({
  images,
  onRemove,
  variant = "message",
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ImageContextMenu | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const removalTimers = useRef<Map<string, number>>(new Map());
  const contextMenuRef = useRef<HTMLDivElement>(null);
  /**
   * Attachment ids already painted in this mount. Seeded on the first layout so
   * remounts (inactive tabs unmount their panes) do not replay paste-in for
   * draft images that were already attached.
   */
  const knownIdsRef = useRef<Set<string> | null>(null);
  const open = images.find((image) => image.id === openId) ?? null;

  useLayoutEffect(() => {
    // Messages are history; only the composer paste strip should enter-animate.
    if (variant !== "composer") return;

    if (knownIdsRef.current === null) {
      knownIdsRef.current = new Set(images.map((image) => image.id));
      return;
    }

    const known = knownIdsRef.current;
    const fresh: string[] = [];
    for (const image of images) {
      if (known.has(image.id)) continue;
      known.add(image.id);
      fresh.push(image.id);
    }
    if (!fresh.length) return;

    setEnteringIds((current) => {
      const next = new Set(current);
      for (const id of fresh) next.add(id);
      return next;
    });
  }, [images, variant]);

  useEffect(() => {
    return () => {
      for (const timer of removalTimers.current.values()) window.clearTimeout(timer);
      removalTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (contextMenu) setContextMenu(null);
      else setOpenId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextMenu, open]);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!menu || !contextMenu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(contextMenu.x, window.innerWidth - rect.width - 8);
    const top = Math.min(contextMenu.y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }, [contextMenu]);

  const finishEnter = (id: string) => {
    setEnteringIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const finishRemove = (id: string) => {
    const timer = removalTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    removalTimers.current.delete(id);
    onRemove?.(id);
    setRemovingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const remove = (id: string) => {
    if (!onRemove || removingIds.has(id)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onRemove(id);
      return;
    }
    setRemovingIds((current) => new Set(current).add(id));
    removalTimers.current.set(
      id,
      window.setTimeout(() => finishRemove(id), IMAGE_REMOVE_FALLBACK_MS),
    );
  };

  if (!images.length) return null;

  return (
    <>
      <div
        className={`agent-image-strip is-${variant}`}
        aria-label={`${images.length} attached ${images.length === 1 ? "image" : "images"}`}
      >
        {images.map((image) => {
          const removing = removingIds.has(image.id);
          const entering = enteringIds.has(image.id);
          return (
            <div
              className={`agent-image-tile${entering ? " is-entering" : ""}${removing ? " is-removing" : ""}`}
              key={image.id}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return;
                if (removing && event.animationName === "agent-image-attachment-out") {
                  finishRemove(image.id);
                  return;
                }
                if (entering && event.animationName === "agent-image-attachment-in") {
                  finishEnter(image.id);
                }
              }}
            >
              <button
                type="button"
                className="agent-image-preview"
                onClick={() => {
                  setContextMenu(null);
                  setOpenId(image.id);
                }}
                title={`View ${image.name}`}
                aria-label={`View ${image.name} full size`}
              >
                <img src={image.thumbnailDataUrl ?? image.dataUrl} alt={image.name} />
              </button>
              {onRemove && (
                <button
                  type="button"
                  className="agent-image-remove"
                  disabled={removing}
                  onClick={() => remove(image.id)}
                  title={`Remove ${image.name}`}
                  aria-label={`Remove ${image.name}`}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 3l6 6M9 3 3 9" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      {open &&
        createPortal(
          <div
            className="agent-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${open.name}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setContextMenu(null);
                setOpenId(null);
              }
            }}
          >
            <button
              type="button"
              className="agent-image-lightbox-close"
              onClick={() => {
                setContextMenu(null);
                setOpenId(null);
              }}
              aria-label="Close image preview"
              title="Close image preview (Esc)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4 4 12" />
              </svg>
            </button>
            <figure>
              <img
                src={open.dataUrl}
                alt={open.name}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenu({ x: event.clientX, y: event.clientY, copyFailed: false });
                }}
              />
              <figcaption>{open.name}</figcaption>
            </figure>
            {contextMenu && (
              <>
                <div
                  className="agent-image-context-backdrop"
                  onPointerDown={() => setContextMenu(null)}
                />
                <div
                  ref={contextMenuRef}
                  className="menu agent-image-context-menu"
                  role="menu"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                  aria-label="Image actions"
                >
                  <button
                    type="button"
                    className="menu-item menu-item-row"
                    role="menuitem"
                    onClick={() => {
                      void writeClipboardImage(open.dataUrl).then((copied) => {
                        if (copied) setContextMenu(null);
                        else setContextMenu((current) =>
                          current ? { ...current, copyFailed: true } : current,
                        );
                      });
                    }}
                  >
                    <span>{contextMenu.copyFailed ? "Could not copy image" : "Copy image"}</span>
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
