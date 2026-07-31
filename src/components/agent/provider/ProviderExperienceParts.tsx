import { useEffect, useId, useState, type ReactNode } from "react";

import type { AgentFileChange } from "../../../lib/agents/types";
import { AgentDiff } from "../AgentDiff";

/**
 * The pieces both provider surfaces need and neither should own.
 *
 * Nothing here decides how anything looks — every part takes its classes from
 * the caller — so Cursor's editorial rail and OpenCode's lane modules can share
 * a disclosure without sharing a style.
 */

/**
 * A clock that only ticks while something is actually running.
 *
 * Elapsed time is the one number a streaming surface cannot derive from props,
 * and an interval that keeps firing on an idle pane is a background wakeup for
 * a number nobody is reading.
 */
export function useTicker(active: boolean, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [active, interval]);
  return now;
}

interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  /** Contents of the summary button. */
  head: ReactNode;
  children: ReactNode;
  className?: string;
  panelClassName?: string;
  /** Announced name for the toggle, when the head is glyph-heavy. */
  label?: string;
}

/**
 * A summary row that opens a panel.
 *
 * `<details>` would be less code, but its open/closed state lives in the DOM,
 * and these rows are re-rendered from a store on every streamed delta — the
 * state has to be React's or the panel flickers shut. A real `<button>` keeps
 * Enter/Space and focus behaviour without re-implementing either.
 */
export function Disclosure({
  open,
  onToggle,
  head,
  children,
  className,
  panelClassName,
  label,
}: DisclosureProps) {
  const id = useId();
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), 240);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  return (
    <>
      <button
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={onToggle}
      >
        {head}
      </button>
      {present && (
        <div
          id={id}
          className={`pv-disclosure ${open ? "is-open" : "is-closing"}`}
        >
          <div className="pv-disclosure-inner">
            <div className={panelClassName}>{children}</div>
          </div>
        </div>
      )}
    </>
  );
}

/** Text only a screen reader gets — status glyphs are unreadable otherwise. */
export function ScreenReaderText({ children }: { children: ReactNode }) {
  return <span className="pv-sr">{children}</span>;
}

/** Every file one tool call touched, as it arrives. */
export function ChangeSet({ changes, className }: { changes: AgentFileChange[]; className?: string }) {
  if (!changes.length) return null;
  return (
    <div className={className}>
      {changes.map((change, index) => (
        <AgentDiff key={`${change.path}-${index}`} change={change} />
      ))}
    </div>
  );
}
