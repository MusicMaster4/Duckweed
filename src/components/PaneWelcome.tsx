import { useEffect, useMemo, useRef, useState } from "react";

import { randomGreeting } from "../lib/greetings";

interface Props {
  /** Shell the pane spawned, shown as the one concrete fact about the session. */
  shellLabel: string;
  cwd: string;
}

/** Keys worth knowing before the first command — the real bindings, nothing else. */
const HINTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ["Ctrl", "Shift", "P"], label: "command palette" },
  { keys: ["Ctrl", "Shift", "D"], label: "split right" },
  { keys: ["Ctrl", "Shift", "T"], label: "new tab" },
  { keys: ["Ctrl", "Shift", "F"], label: "find in terminal" },
];

/**
 * What a pane shows before it has run anything.
 *
 * The grid underneath already holds the shell's prompt, but a prompt with no
 * output is chrome pretending to be content — Warp keeps that hidden until the
 * first command, and so does this. Anchored to the bottom so it sits just above
 * the composer rather than floating in the middle of a tall pane.
 */
/** Below this the hint list has nowhere to go and the greeting stands alone. */
const COMPACT_HEIGHT = 190;

export function PaneWelcome({ shellLabel, cwd }: Props) {
  // Once per mount: a line that changes while you read it is a distraction.
  const greeting = useMemo(() => randomGreeting(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  // A pane in a three-way split can be shorter than the hints are tall.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.height < COMPACT_HEIGHT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className={`pane-welcome ${compact ? "is-compact" : ""}`} aria-hidden="true">
      <div className="pane-welcome-inner">
        <p className="pane-welcome-greeting">{greeting}</p>
        <p className="pane-welcome-sub">
          <span className="pane-welcome-shell">{shellLabel || "shell"}</span>
          {cwd && <span className="pane-welcome-cwd">{cwd}</span>}
        </p>
        <ul className="pane-welcome-hints">
          {HINTS.map((hint) => (
            <li key={hint.label}>
              <span className="pane-welcome-keys">
                {hint.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
              <span className="pane-welcome-label">{hint.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
