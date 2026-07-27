import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** First line, set in the text colour. Keep it to a few words. */
  title: string;
  /** Optional second line explaining what the control actually does. */
  detail?: string;
  /** Keyboard shortcut shown on the right of the title, if there is one. */
  shortcut?: string;
  children: ReactNode;
}

/** Gap between the trigger and the bubble. */
const OFFSET = 8;
const MARGIN = 8;
const DELAY_MS = 320;

/**
 * A tooltip that belongs to this app rather than to the OS.
 *
 * Native `title` tooltips arrive late, in the system font, on a yellow-grey
 * slab, and they cannot hold two lines of explanation. Anywhere a control needs
 * a real sentence to justify itself, that is not good enough.
 *
 * Rendered into a portal because the tools dock clips its overflow, and
 * positioned from the trigger's own rect so the bubble can hang outside it.
 */
export function Tooltip({ title, detail, shortcut, children }: Props) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The rect to hang off. The anchor is `display: contents` so it does not
   * disturb the layout it wraps, which also means it has no box of its own;
   * the wrapped element is the one with a position on screen.
   */
  const triggerRect = useCallback((): DOMRect | null => {
    const node = anchor.current?.firstElementChild ?? anchor.current;
    return node ? node.getBoundingClientRect() : null;
  }, []);

  const hide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setAt(null);
  }, []);

  const show = useCallback(
    (immediate: boolean) => {
      if (timer.current !== null) clearTimeout(timer.current);
      const open = () => {
        const rect = triggerRect();
        if (rect) setAt({ x: rect.left + rect.width / 2, y: rect.bottom + OFFSET });
      };
      if (immediate) open();
      else timer.current = setTimeout(open, DELAY_MS);
    },
    [triggerRect],
  );

  useEffect(() => () => hide(), [hide]);

  // Anything that moves the trigger out from under the bubble should take the
  // bubble with it: a scroll, a resize, or the window losing focus.
  useEffect(() => {
    if (!at) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [at, hide]);

  // Nudge back inside the viewport once the bubble has a measured width. Done
  // after paint rather than guessed, because the text decides how wide it is.
  useEffect(() => {
    const node = bubble.current;
    if (!at || !node) return;
    const rect = node.getBoundingClientRect();
    const overflowRight = rect.right - (window.innerWidth - MARGIN);
    const overflowLeft = MARGIN - rect.left;
    if (overflowRight > 0) node.style.transform = `translateX(${-overflowRight}px)`;
    else if (overflowLeft > 0) node.style.transform = `translateX(${overflowLeft}px)`;
    // Flip above the trigger when there is no room below it.
    if (rect.bottom > window.innerHeight - MARGIN) {
      const top = triggerRect()?.top ?? 0;
      node.style.top = `${top - rect.height - OFFSET}px`;
    }
  }, [at, triggerRect]);

  return (
    <>
      <span
        ref={anchor}
        className="tip-anchor"
        onPointerEnter={() => show(false)}
        onPointerLeave={hide}
        onPointerDown={hide}
        // Keyboard users get it without the hover delay, since they cannot
        // hover to discover it in the first place.
        onFocusCapture={() => show(true)}
        onBlurCapture={hide}
      >
        {children}
      </span>

      {at &&
        createPortal(
          <div ref={bubble} className="tip" style={{ left: at.x, top: at.y }} role="tooltip">
            <div className="tip-title">
              <span>{title}</span>
              {shortcut && <kbd>{shortcut}</kbd>}
            </div>
            {detail && <p className="tip-detail">{detail}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
