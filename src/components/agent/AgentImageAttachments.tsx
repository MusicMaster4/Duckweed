import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentImageAttachment } from "../../lib/agents/types";

interface Props {
  images: AgentImageAttachment[];
  onRemove?: (id: string) => void;
  variant?: "composer" | "message";
}

const IMAGE_REMOVE_FALLBACK_MS = 220;

/** Shared thumbnail strip and full-size viewer for drafts and sent messages. */
export function AgentImageAttachments({
  images,
  onRemove,
  variant = "message",
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const removalTimers = useRef<Map<string, number>>(new Map());
  const open = images.find((image) => image.id === openId) ?? null;

  useEffect(() => {
    return () => {
      for (const timer of removalTimers.current.values()) window.clearTimeout(timer);
      removalTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

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
          return (
            <div
              className={`agent-image-tile${removing ? " is-removing" : ""}`}
              key={image.id}
              onAnimationEnd={(event) => {
                if (
                  removing &&
                  event.target === event.currentTarget &&
                  event.animationName === "agent-image-attachment-out"
                ) {
                  finishRemove(image.id);
                }
              }}
            >
              <button
                type="button"
                className="agent-image-preview"
                onClick={() => setOpenId(image.id)}
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
              if (event.target === event.currentTarget) setOpenId(null);
            }}
          >
            <button
              type="button"
              className="agent-image-lightbox-close"
              onClick={() => setOpenId(null)}
              aria-label="Close image preview"
              title="Close image preview (Esc)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4 4 12" />
              </svg>
            </button>
            <figure>
              <img src={open.dataUrl} alt={open.name} />
              <figcaption>{open.name}</figcaption>
            </figure>
          </div>,
          document.body,
        )}
    </>
  );
}
