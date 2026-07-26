import { useEffect, useState } from "react";

/** Matches `.completion-dot` / `.pane.is-unread::after` fade timing in styles.css. */
const FADE_MS = 500;

interface Props {
  active: boolean;
  className?: string;
  title?: string;
  role?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

/**
 * Rose completion marker with a half-second fade in/out. Stays mounted through
 * the fade-out so CSS opacity can run after `active` flips off.
 */
export function CompletionDot({
  active,
  className,
  title,
  role,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: Props) {
  const [mounted, setMounted] = useState(active);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      setMounted(true);
      // Two frames: paint at opacity 0, then transition to visible.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!mounted) return null;

  return (
    <span
      className={["completion-dot", visible ? "is-visible" : "", className]
        .filter(Boolean)
        .join(" ")}
      title={title}
      role={role}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
    />
  );
}
