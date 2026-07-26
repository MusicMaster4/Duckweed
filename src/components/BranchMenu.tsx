import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gitBranches, gitCheckout } from "../lib/ipc";
import type { Branches, ProjectInfo } from "../lib/types";

interface Props {
  /** The tab's project — the repo whose branches this lists. */
  project: ProjectInfo;
  /** Re-read the project, so the pill shows the branch we just moved to. */
  onSwitched: () => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; branches: Branches }
  | { kind: "error"; message: string };

interface Entry {
  name: string;
  remote: boolean;
}

/**
 * The branch pill inside a tab, and the switcher behind it.
 *
 * It lives in the tab because the repo does: each tab is its own folder, so the
 * branch is the tab's, not the window's.
 *
 * Checking out happens in the backend rather than by typing `git checkout` into
 * the pane: the shell may be busy, or halfway through a command the user is
 * still writing, and neither is a reason the switcher should refuse to work.
 */
export function BranchMenu({ project, onSwitched }: Props) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = anchor !== null;

  const close = useCallback(() => {
    setAnchor(null);
    setQuery("");
    setCursor(0);
    setBusy(null);
  }, []);

  // Branches are read when the menu opens, not kept in sync: they change rarely,
  // and a stale list you opened deliberately is easy to reason about.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad({ kind: "loading" });
    gitBranches(project.path)
      .then((branches) => {
        if (!cancelled) setLoad({ kind: "ready", branches });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ kind: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, project.path]);

  const entries = useMemo<Entry[]>(() => {
    if (load.kind !== "ready") return [];
    const all: Entry[] = [
      ...load.branches.local.map((name) => ({ name, remote: false })),
      ...load.branches.remote.map((name) => ({ name, remote: true })),
    ];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [load, query]);

  const current = load.kind === "ready" ? load.branches.current : project.branch;

  const switchTo = useCallback(
    async (branch: string) => {
      if (branch === current) {
        close();
        return;
      }
      setBusy(branch);
      try {
        await gitCheckout(project.path, branch);
        onSwitched();
        close();
      } catch (error: unknown) {
        // Nearly always a dirty working tree — git's own wording says it best.
        setLoad({ kind: "error", message: String(error) });
        setBusy(null);
      }
    },
    [close, current, onSwitched, project.path],
  );

  // A tab near the right edge would hang its menu off-screen; pull it back in.
  useEffect(() => {
    const el = menuRef.current;
    if (!el || !anchor) return;
    const overflow = el.getBoundingClientRect().right - window.innerWidth + 8;
    if (overflow > 0) el.style.left = `${Math.max(8, anchor.x - overflow)}px`;
  }, [anchor]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".is-cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor, entries.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // App-wide shortcuts must not fire while the filter has focus.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + step + entries.length) % entries.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[cursor];
      if (entry) void switchTo(entry.name);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`tab-branch ${open ? "is-open" : ""}`}
        title={`${project.name} is on ${project.branch ?? "a detached HEAD"} — click to switch branch`}
        // The tab strip starts a reorder drag on pointerdown; this is a button.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            close();
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 6 });
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4.5" cy="4" r="1.8" />
          <circle cx="4.5" cy="12" r="1.8" />
          <circle cx="11.5" cy="7" r="1.8" />
          <path d="M4.5 5.8v4.4M4.5 8.6h3.6a3 3 0 0 0 2.2-1" />
        </svg>
        <span className="tab-branch-label">{project.branch ?? "detached"}</span>
      </button>

      {anchor && (
        <>
          <div className="menu-backdrop" onPointerDown={close} />
          <div className="menu menu-branches" ref={menuRef} style={{ left: anchor.x, top: anchor.y }}>
            <input
              className="menu-filter"
              autoFocus
              spellCheck={false}
              placeholder="Switch branch…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onKeyDown}
            />

            {load.kind === "loading" && <div className="menu-empty">reading branches…</div>}
            {load.kind === "error" && <div className="menu-error">{load.message}</div>}

            {load.kind === "ready" && entries.length === 0 && (
              <div className="menu-empty">{query ? "No matching branch" : "No branches"}</div>
            )}

            <div className="menu-list" ref={listRef}>
              {entries.map((entry, i) => (
                <button
                  key={`${entry.remote ? "r" : "l"}:${entry.name}`}
                  type="button"
                  className={[
                    "menu-item menu-branch",
                    entry.name === current ? "is-current" : "",
                    i === cursor ? "is-cursor" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onPointerEnter={() => setCursor(i)}
                  onClick={() => void switchTo(entry.name)}
                >
                  <span className="menu-branch-name">
                    {entry.name === current && <span className="menu-branch-mark">●</span>}
                    {entry.name}
                  </span>
                  {(entry.remote || busy === entry.name) && (
                    <span className="menu-hint">
                      {busy === entry.name ? "switching…" : "remote — creates a local branch"}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
