import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject, type PointerEvent } from "react";

export const TAB_STRIP_MOTION_MS = 140;
export const TAB_STRIP_MOTION_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export const reducedTabMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface ItemLayout {
  element: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
  clone: HTMLElement;
  group: string | undefined;
}

const useStripLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const itemSelector = ":scope > [data-strip-motion-id]";

/** Keep close targets steady under the pointer, then animate the next layout. */
export function useTabStripMotion(stripRef: RefObject<HTMLDivElement>) {
  const previous = useRef(new Map<string, ItemLayout>());
  const heldWidths = useRef(new Map<string, number>());
  const hovered = useRef(false);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const ghosts = useRef(new Set<HTMLElement>());
  const exits = useRef(new Map<string, HTMLElement>());
  const signature = useRef("");
  const lastRevision = useRef(0);
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);

  const cancelAnimations = () => {
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
    for (const ghost of ghosts.current) ghost.remove();
    ghosts.current.clear();
    exits.current.clear();
  };

  useStripLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const elements = [...strip.querySelectorAll<HTMLElement>(itemSelector)];
    const nextSignature = elements.map((el) => `${el.dataset.stripMotionId}:${el.dataset.tabGroup ?? ""}`).join("|");
    const changed = signature.current !== nextSignature;
    signature.current = nextSignature;
    const refreshed = lastRevision.current !== revision;
    lastRevision.current = revision;

    // Dragging owns transforms until its drop has been committed to React.
    if (document.body.classList.contains("is-dragging-tab")) {
      cancelAnimations();
      previous.current.clear();
      return;
    }

    // Agent activity and selection can update frequently. Leave an ongoing
    // animation alone when the underlying geometry has not changed.
    if (!changed && !refreshed && elements.every((el) => {
      const item = previous.current.get(el.dataset.stripMotionId!);
      return item && Math.abs(el.offsetLeft - item.left) < 1
        && Math.abs(el.offsetWidth - item.width) < 1;
    })) {
      for (const el of elements) previous.current.get(el.dataset.stripMotionId!)!.clone = el.cloneNode(true) as HTMLElement;
      return;
    }

    const ids = new Set(elements.map((el) => el.dataset.stripMotionId!));
    const inserted = elements.some((el) => !previous.current.has(el.dataset.stripMotionId!));
    const removed = [...previous.current.keys()].some((id) => !ids.has(id));
    // Only closing holds the current widths. Opening a tab or expanding a
    // group releases an earlier hold and fits the row immediately.
    const holdCurrentWidths = removed && !inserted && hovered.current && !heldWidths.current.size;
    if (!hovered.current || inserted) heldWidths.current.clear();

    // Capture an interrupted animation at its current visual position, so rapid
    // closes and group toggles continue smoothly instead of starting over.
    const visual = new Map<string, { left: number; width: number; opacity: number }>();
    for (const [id, item] of previous.current) {
      const style = getComputedStyle(item.element);
      let matrix = !style.transform || style.transform === "none" ? null : new DOMMatrixReadOnly(style.transform);
      let opacity = style.opacity ? Number(style.opacity) : 1;
      // Removed nodes have no computed style. Read their in-flight keyframes
      // before cancelling, so closing an entering tab still fades from here.
      const effect = animations.current.get(item.element)?.effect as KeyframeEffect | null | undefined;
      if (!item.element.isConnected && effect) {
        const frames = effect.getKeyframes();
        const progress = effect.getComputedTiming().progress ?? 1;
        const first = new DOMMatrixReadOnly(String(frames[0].transform));
        const last = new DOMMatrixReadOnly(String(frames[frames.length - 1].transform));
        matrix = new DOMMatrixReadOnly([
          first.m11 + (last.m11 - first.m11) * progress, 0, 0, 1,
          first.m41 + (last.m41 - first.m41) * progress, 0,
        ]);
        const from = Number(frames[0].opacity ?? 1);
        opacity = from + (Number(frames[frames.length - 1].opacity ?? 1) - from) * progress;
      }
      visual.set(id, {
        left: item.left + (matrix?.m41 ?? 0),
        width: item.width * (matrix?.m11 ?? 1),
        opacity,
      });
    }
    // Existing exit ghosts finish independently during a burst of closes.
    for (const [element, animation] of animations.current) {
      if (ghosts.current.has(element)) continue;
      animation.cancel();
      animations.current.delete(element);
    }

    if (holdCurrentWidths) {
      for (const [id, item] of previous.current) heldWidths.current.set(id, visual.get(id)?.width ?? item.width);
    }
    const oldTabWidth = [...heldWidths.current].find(([id]) => id.startsWith("tab:"))?.[1];
    for (const el of elements) {
      const id = el.dataset.stripMotionId!;
      if (heldWidths.current.size) {
        const width = heldWidths.current.get(id)
          ?? (id.startsWith("tab:") ? oldTabWidth : undefined)
          ?? el.getBoundingClientRect().width;
        heldWidths.current.set(id, width);
        el.style.setProperty("--strip-held-width", `${width}px`);
        el.dataset.stripWidthHeld = "";
      } else {
        el.style.removeProperty("--strip-held-width");
        delete el.dataset.stripWidthHeld;
      }
    }

    const stripRect = strip.getBoundingClientRect();
    const next = new Map<string, ItemLayout>();
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      next.set(el.dataset.stripMotionId!, {
        element: el,
        left: rect.left - stripRect.left + strip.scrollLeft,
        top: rect.top - stripRect.top + strip.scrollTop,
        width: rect.width,
        height: rect.height,
        clone: el.cloneNode(true) as HTMLElement,
        group: el.dataset.tabGroup,
      });
    }

    // Reopening a group reverses its exit from the current position, without
    // drawing a fading copy on top of the returning tab.
    for (const [id] of next) {
      const ghost = exits.current.get(id);
      if (!ghost) continue;
      const rect = ghost.getBoundingClientRect();
      visual.set(id, {
        left: rect.left - stripRect.left + strip.scrollLeft,
        width: rect.width,
        opacity: Number(getComputedStyle(ghost).opacity),
      });
      animations.current.get(ghost)?.cancel();
      animations.current.delete(ghost);
      ghosts.current.delete(ghost);
      exits.current.delete(id);
      ghost.remove();
    }

    const play = (el: HTMLElement, frames: Keyframe[], exitingId?: string) => {
      const animation = el.animate(frames, {
        duration: TAB_STRIP_MOTION_MS,
        easing: TAB_STRIP_MOTION_EASE,
      });
      animations.current.set(el, animation);
      animation.onfinish = () => {
        if (animations.current.get(el) === animation) animations.current.delete(el);
        if (exitingId !== undefined) {
          el.remove();
          ghosts.current.delete(el);
          if (exits.current.get(exitingId) === el) exits.current.delete(exitingId);
        }
      };
    };

    if (previous.current.size && !reducedTabMotion()) {
      for (const [id, item] of next) {
        const before = visual.get(id);
        if (before) {
          const offset = before.left - item.left;
          const scale = item.width ? before.width / item.width : 1;
          if (Math.abs(offset) > 0.5 || Math.abs(before.width - item.width) > 0.5 || before.opacity < 1) {
            play(item.element, [
              { transform: `translateX(${offset}px) scaleX(${scale})`, opacity: before.opacity },
              { transform: "translateX(0) scaleX(1)", opacity: 1 },
            ]);
          }
        } else {
          const label = item.group ? next.get(`group:${item.group}`) : undefined;
          const previousLabel = item.group ? previous.current.get(`group:${item.group}`) : undefined;
          const expanding = label && (!previousLabel || previousLabel.clone.getAttribute("aria-expanded") === "false");
          const offset = expanding ? label.left + label.width - item.left : -16;
          play(item.element, [
            { transform: `translateX(${offset}px) scaleX(0.85)`, opacity: 0 },
            { transform: "translateX(0) scaleX(1)", opacity: 1 },
          ]);
        }
      }
      for (const [id, item] of previous.current) {
        if (next.has(id)) continue;
        const before = visual.get(id)!;
        const ghost = item.clone;
        // Exit copies are visual only, never tabs or pane-drop targets.
        for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
          for (const attribute of [...node.attributes]) {
            if (attribute.name.startsWith("data-") || attribute.name === "id") node.removeAttribute(attribute.name);
          }
        }
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        ghost.classList.add("tab-strip-exit");
        Object.assign(ghost.style, {
          left: `${item.left}px`, top: `${item.top}px`, width: `${item.width}px`,
          minWidth: "0", maxWidth: "none", height: `${item.height}px`,
        });
        strip.appendChild(ghost);
        ghosts.current.add(ghost);
        exits.current.set(id, ghost);
        const label = item.group ? next.get(`group:${item.group}`) : undefined;
        const collapsing = label?.element.getAttribute("aria-expanded") === "false";
        const destination = collapsing ? label.left + label.width - item.left : -12;
        play(ghost, [
          { transform: `translateX(${before.left - item.left}px) scaleX(${before.width / item.width})`, opacity: before.opacity },
          { transform: `translateX(${destination}px) scaleX(${collapsing ? 0.05 : 0.85})`, opacity: 0 },
        ], id);
      }
    }
    previous.current = next;
  });

  useStripLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let width = strip.clientWidth;
    const resize = new ResizeObserver(() => {
      if (strip.clientWidth === width) return;
      width = strip.clientWidth;
      // A window resize must remain responsive even while the row is hovered.
      heldWidths.current.clear();
      refresh();
    });
    resize.observe(strip);
    const release = () => { hovered.current = false; refresh(); };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => {
      if (media.matches) cancelAnimations();
      refresh();
    };
    media.addEventListener("change", motionChanged);
    window.addEventListener("blur", release);
    return () => {
      resize.disconnect();
      media.removeEventListener("change", motionChanged);
      window.removeEventListener("blur", release);
      cancelAnimations();
    };
  }, [stripRef]);

  return {
    revision,
    isHovered: () => hovered.current,
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "touch") hovered.current = true;
    },
    onPointerLeave: () => { hovered.current = false; refresh(); },
    // A reorder starts from the settled geometry and takes over transforms.
    prepareForDrag: cancelAnimations,
  };
}
