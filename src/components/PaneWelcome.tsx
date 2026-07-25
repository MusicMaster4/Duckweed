import { useEffect, useMemo, useRef, useState } from "react";

import { randomGreeting } from "../lib/greetings";

interface Props {
  /** Shell the pane spawned, shown as the one concrete fact about the session. */
  shellLabel: string;
  cwd: string;
  /** Only the focused pane should claim the show-hints chord. */
  active: boolean;
}

/** Keys worth knowing before the first command — the real bindings, nothing else. */
const HINTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ["Ctrl", "Shift", "P"], label: "command palette" },
  { keys: ["Ctrl", "Shift", "D"], label: "split right" },
  { keys: ["Ctrl", "Shift", "T"], label: "new tab" },
  { keys: ["Ctrl", "Shift", "F"], label: "find in terminal" },
];

/** Chord that expands/collapses the hint list on the empty pane. */
const TOGGLE_HINTS_KEYS = ["Ctrl", "Shift", "/"] as const;

/**
 * What a pane shows before it has run anything.
 *
 * The grid underneath already holds the shell's prompt, but a prompt with no
 * output is chrome pretending to be content — Warp keeps that hidden until the
 * first command, and so does this. Anchored to the bottom so it sits just above
 * the composer rather than floating in the middle of a tall pane.
 */
/** Below this even a single hint row is cramped; greeting stands alone. */
const COMPACT_HEIGHT = 140;

function HintKeys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="pane-welcome-keys">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}

export function PaneWelcome({ shellLabel, cwd, active }: Props) {
  // Once per mount: a line that changes while you read it is a distraction.
  const greeting = useMemo(() => randomGreeting(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);

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

  // Only the focused empty pane claims the chord; unmount tears the binding down.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      // Shift+/ is `?` on US layouts; match the physical key instead.
      if (!ctrl || !e.shiftKey || e.code !== "Slash") return;
      e.preventDefault();
      e.stopPropagation();
      setHintsOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active]);

  return (
    <div
      ref={rootRef}
      className={`pane-welcome ${compact ? "is-compact" : ""} ${hintsOpen ? "is-hints-open" : ""}`}
      aria-hidden="true"
    >
      <div className="pane-welcome-inner">
        <p className="pane-welcome-greeting">{greeting}</p>
        <p className="pane-welcome-sub">
          <span className="pane-welcome-shell">{shellLabel || "shell"}</span>
          {cwd && <span className="pane-welcome-cwd">{cwd}</span>}
        </p>
        <ul className="pane-welcome-hints">
          {hintsOpen ? (
            HINTS.map((hint) => (
              <li key={hint.label}>
                <HintKeys keys={hint.keys} />
                <span className="pane-welcome-label">{hint.label}</span>
              </li>
            ))
          ) : (
            <li>
              <button
                type="button"
                className="pane-welcome-show-hints"
                onClick={() => setHintsOpen(true)}
                tabIndex={-1}
              >
                <HintKeys keys={TOGGLE_HINTS_KEYS} />
                <span className="pane-welcome-label">show hints</span>
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
