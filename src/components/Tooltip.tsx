import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
const TOOLTIP_OPEN_EVENT = "duckweed:tooltip-open";

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
      document.dispatchEvent(new Event(TOOLTIP_OPEN_EVENT));
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

  useEffect(() => {
    document.addEventListener(TOOLTIP_OPEN_EVENT, hide);
    return () => {
      document.removeEventListener(TOOLTIP_OPEN_EVENT, hide);
      hide();
    };
  }, [hide]);

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
 * their layout. Titles stay in a data attribute for the lifetime of this
 * component, so pointer dismissal and React updates cannot revive native tips.
 */
export function NativeTitleTooltips() {
  const [content, setContent] = useState<TipContent | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const active = useRef<{
    node: HTMLElement;
  } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    active.current = null;
    setAt(null);
    setContent(null);
  }, []);

  const show = useCallback((node: HTMLElement, immediate: boolean) => {
    const title = node.getAttribute("data-app-tooltip");
    if (!title) {
      hide();
      return;
    }

    document.dispatchEvent(new Event(TOOLTIP_OPEN_EVENT));
    if (timer.current !== null) clearTimeout(timer.current);
    active.current = { node };

    const open = () => {
      const rect = node.getBoundingClientRect();
      setContent(splitNativeTitle(title));
      setAt({ x: rect.left + rect.width / 2, y: rect.bottom + OFFSET });
      timer.current = null;
    };

    if (immediate) open();
    else timer.current = setTimeout(open, DELAY_MS);
  }, [hide]);

  useLayoutEffect(() => {
    // Move titles before the browser can display them. Observe React updates as
    // well as new controls, including portals outside the application root.
    // Disconnect during our own writes so an intentional React title removal
    // can be distinguished from the clearing performed by this conversion.
    const options: MutationObserverInit = {
      subtree: true, childList: true, attributes: true, attributeFilter: ["title"],
    };
    const accessibleNames = new WeakMap<Element, string>();
    const restoreAccessibleName = (node: Element) => {
      const generated = accessibleNames.get(node);
      if (generated !== undefined && node.getAttribute("aria-label") === generated) {
        node.removeAttribute("aria-label");
      }
      accessibleNames.delete(node);
    };
    const convertTitle = (node: Element) => {
      const title = node.getAttribute("title");
      restoreAccessibleName(node);
      if (title === null) node.removeAttribute("data-app-tooltip");
      else {
        node.setAttribute("data-app-tooltip", title);
        // Keep an empty attribute so React removing the title still produces
        // a mutation. Removing it ourselves would make that update invisible.
        node.setAttribute("title", "");
        const hasAccessibleName =
          node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby") ||
          Boolean(node.textContent?.trim()) ||
          (node instanceof HTMLImageElement && Boolean(node.alt)) ||
          ("labels" in node && Boolean((node as HTMLInputElement).labels?.length));
        if (title && !hasAccessibleName) {
          const label = splitNativeTitle(title).title;
          node.setAttribute("aria-label", label);
          accessibleNames.set(node, label);
        }
      }
      if (node === active.current?.node) hide();
    };
    const convertTree = (node: Element) => {
      if (node.hasAttribute("title")) convertTitle(node);
      node.querySelectorAll("[title]").forEach(convertTitle);
    };
    const observer = new MutationObserver((records) => {
      observer.disconnect();
      const changed = new Set<Element>();
      for (const record of records) {
        if (record.type === "attributes") changed.add(record.target as Element);
        else record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          const collect = (child: Element) => {
            // Moving an existing subtree must not replace its saved text with
            // the empty native title left by the previous conversion.
            if (child.getAttribute("title") === "" && child.hasAttribute("data-app-tooltip")) return;
            changed.add(child);
          };
          if (node.hasAttribute("title")) collect(node);
          node.querySelectorAll("[title]").forEach(collect);
        });
      }
      changed.forEach(convertTitle);
      if (active.current && !active.current.node.isConnected) hide();
      observer.observe(document.body, options);
    });
    convertTree(document.body);
    observer.observe(document.body, options);

    const titledElement = (target: EventTarget | null) => {
      // Explicit Tooltip wrappers own their content and must not open a second
      // app tooltip for a title on one of their children.
      if (!(target instanceof Element) || target.closest(".tip-anchor")) return null;
      return target.closest<HTMLElement>("[data-app-tooltip]");
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".tip-anchor")) {
        hide();
        return;
      }
      const node = titledElement(event.target);
      const current = active.current?.node;
      // A titled control may live inside another titled surface, as the pane
      // buttons do inside the draggable pane header. Prefer that more specific
      // target, while retaining the active tooltip when entering its children.
      if (current?.contains(event.target as Node) && (!node || !current.contains(node))) {
        return;
      }
      if (node && node !== current) {
        show(node, false);
      }
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

    document.addEventListener(TOOLTIP_OPEN_EVENT, hide);
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      observer.disconnect();
      document.querySelectorAll("[data-app-tooltip]").forEach((node) => {
        node.setAttribute("title", node.getAttribute("data-app-tooltip") ?? "");
        node.removeAttribute("data-app-tooltip");
        restoreAccessibleName(node);
      });
      document.removeEventListener(TOOLTIP_OPEN_EVENT, hide);
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
