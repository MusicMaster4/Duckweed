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

interface TipContent {
  title: string;
  detail?: string;
  shortcut?: string;
}

function clampTipHorizontally(node: HTMLDivElement, rect: DOMRect) {
  const overflowRight = rect.right - (window.innerWidth - MARGIN);
  const overflowLeft = MARGIN - rect.left;

  // Tips are centered on their trigger by default. Keep that -50% translation
  // when applying the viewport correction instead of replacing it.
  if (overflowRight > 0) {
    node.style.transform = `translateX(calc(-50% - ${overflowRight}px))`;
  } else if (overflowLeft > 0) {
    node.style.transform = `translateX(calc(-50% + ${overflowLeft}px))`;
  } else {
    node.style.transform = "translateX(-50%)";
  }
}

function splitNativeTitle(value: string): TipContent {
  const [firstLine, ...detailLines] = value.split("\n");
  const shortcutMatch = firstLine.match(/^(.*?)\s+\(([^()]*(?:Ctrl|Alt|Shift|Cmd|Enter|Esc|F\d)[^()]*)\)$/i);
  const detail = detailLines.join(" ").trim() || undefined;

  if (!shortcutMatch) return { title: firstLine, detail };
  return {
    title: shortcutMatch[1],
    detail,
    shortcut: shortcutMatch[2],
  };
}

function TipBubble({ content, at, bubble }: {
  content: TipContent;
  at: { x: number; y: number };
  bubble: React.RefObject<HTMLDivElement>;
}) {
  return createPortal(
    <div ref={bubble} className="tip" style={{ left: at.x, top: at.y }} role="tooltip">
      <div className="tip-title">
        <span>{content.title}</span>
        {content.shortcut && <kbd>{content.shortcut}</kbd>}
      </div>
      {content.detail && <p className="tip-detail">{content.detail}</p>}
    </div>,
    document.body,
  );
}

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
    clampTipHorizontally(node, rect);
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
        <TipBubble content={{ title, detail, shortcut }} at={at} bubble={bubble} />}
    </>
  );
}

/**
 * Replaces every remaining HTML `title` tooltip with the app tooltip.
 *
 * Keeping this at the application root covers controls, truncated paths and
 * dynamically rendered agent surfaces without adding wrappers that can alter
 * their layout. The native attribute is restored as soon as the pointer or
 * keyboard focus leaves the trigger.
 */
export function NativeTitleTooltips() {
  const [content, setContent] = useState<TipContent | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const active = useRef<{
    node: HTMLElement;
    title: string;
    addedAriaLabel: boolean;
  } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const restoreTitle = useCallback(() => {
    const current = active.current;
    if (current?.node.isConnected) {
      if (!current.node.hasAttribute("title")) {
        current.node.setAttribute("title", current.title);
      }
      if (current.addedAriaLabel) current.node.removeAttribute("aria-label");
    }
    active.current = null;
  }, []);

  const hide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    restoreTitle();
    setAt(null);
    setContent(null);
  }, [restoreTitle]);

  const show = useCallback((node: HTMLElement, immediate: boolean) => {
    const title = node.getAttribute("title");
    if (!title) return;

    if (timer.current !== null) clearTimeout(timer.current);
    restoreTitle();
    const hasAccessibleName =
      node.hasAttribute("aria-label") ||
      node.hasAttribute("aria-labelledby") ||
      Boolean(node.textContent?.trim()) ||
      (node instanceof HTMLImageElement && Boolean(node.alt)) ||
      ("labels" in node && Boolean((node as HTMLInputElement).labels?.length));
    const addedAriaLabel = !hasAccessibleName;
    if (addedAriaLabel) node.setAttribute("aria-label", splitNativeTitle(title).title);
    active.current = { node, title, addedAriaLabel };
    node.removeAttribute("title");

    const open = () => {
      const rect = node.getBoundingClientRect();
      setContent(splitNativeTitle(title));
      setAt({ x: rect.left + rect.width / 2, y: rect.bottom + OFFSET });
      timer.current = null;
    };

    if (immediate) open();
    else timer.current = setTimeout(open, DELAY_MS);
  }, [restoreTitle]);

  useEffect(() => {
    const titledElement = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("[title]") : null;

    const onPointerOver = (event: PointerEvent) => {
      if (active.current?.node.contains(event.target as Node)) return;
      const node = titledElement(event.target);
      if (node) show(node, false);
    };
    const onPointerOut = (event: PointerEvent) => {
      const node = active.current?.node;
      if (!node || (event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const node = titledElement(event.target);
      if (node) show(node, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const node = active.current?.node;
      if (!node || (event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) return;
      hide();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      hide();
    };
  }, [hide, show]);

  useEffect(() => {
    const node = bubble.current;
    if (!at || !node) return;
    const rect = node.getBoundingClientRect();
    clampTipHorizontally(node, rect);
    if (rect.bottom > window.innerHeight - MARGIN) {
      const top = active.current?.node.getBoundingClientRect().top ?? 0;
      node.style.top = `${top - rect.height - OFFSET}px`;
    }
  }, [at]);

  return content && at ? <TipBubble content={content} at={at} bubble={bubble} /> : null;
}
