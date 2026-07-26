import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { randomGreeting, randomUnclaimedGreeting } from "../lib/greetings";
import { PaneDuck } from "./PaneDuck";
import type { ProjectInfo } from "../lib/types";

interface Props {
  /** Only the focused pane should claim the show-hints chord. */
  active: boolean;
  /** Folder this tab works in, or null while it has none. */
  project: ProjectInfo | null;
  /** Folders opened before, offered as one-click choices. */
  recents: string[];
  onBrowse: () => void;
  onPickRecent: (path: string) => void;
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

/** How many recent folders the empty tab offers before it stops being a shortcut. */
const RECENT_CHIPS = 4;

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

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function HintKeys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="pane-welcome-keys">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}

export function PaneWelcome({ active, project, recents, onBrowse, onPickRecent }: Props) {
  // Once per mount: a line that changes while you read it is a distraction.
  const greeting = useMemo(() => randomGreeting(), []);
  const unclaimedLine = useMemo(() => randomUnclaimedGreeting(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef(onPickRecent);
  pickRef.current = onPickRecent;
  const [compact, setCompact] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [folderDrop, setFolderDrop] = useState(false);

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

  /**
   * OS folder drops arrive as Tauri events with real filesystem paths. While
   * this focused tab still has no folder, any drop on the window claims it —
   * no hit-test games with DPI / titlebar; the empty state is the whole point.
   */
  useEffect(() => {
    if (!active || project) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setFolderDrop(false);
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          setFolderDrop(true);
          return;
        }
        if (payload.type !== "drop") return;
        setFolderDrop(false);
        const path = payload.paths[0];
        if (path) pickRef.current(path);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      setFolderDrop(false);
      unlisten?.();
    };
  }, [active, project]);

  /**
   * No folder yet: the duck is out of the water, and the pane offers the one
   * thing this tab is missing. Composer and new-tab are locked until a path is
   * chosen — a folder is a gate, not a suggestion. Browse or drop both count.
   */
  if (!project) {
    return (
      <div
        ref={rootRef}
        className={[
          "pane-welcome",
          "is-unclaimed",
          compact ? "is-compact" : "",
          folderDrop ? "is-folder-drop" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <PaneDuck />
        <div className="pane-welcome-inner">
          <p className="pane-welcome-greeting">
            {folderDrop ? "Drop to open this folder." : unclaimedLine}
          </p>
          <button type="button" className="pane-welcome-browse" onClick={onBrowse}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.8h4.5A1.5 1.5 0 0 1 14 6.3v5.2A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
            </svg>
            <span>Choose a folder for this tab</span>
            <kbd>Ctrl+Shift+O</kbd>
          </button>
          <p className="pane-welcome-drop-hint">or drop a folder here</p>
          {recents.length > 0 && (
            <div className="pane-welcome-recents">
              {recents.slice(0, RECENT_CHIPS).map((path) => (
                <button
                  key={path}
                  type="button"
                  className="pane-welcome-recent"
                  title={path}
                  onClick={() => onPickRecent(path)}
                >
                  {basename(path)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`pane-welcome ${compact ? "is-compact" : ""} ${hintsOpen ? "is-hints-open" : ""}`}
      aria-hidden="true"
    >
      <PaneDuck />
      <div className="pane-welcome-inner">
        <p className="pane-welcome-greeting">{greeting}</p>
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
