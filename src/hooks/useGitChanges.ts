import { useCallback, useEffect, useRef, useState } from "react";

import { gitDiffStats } from "../lib/ipc";
import type { DiffStats, ProjectInfo } from "../lib/types";

/** How often the working tree is re-measured while the window has focus. */
const POLL_MS = 4000;

export interface GitChanges {
  /** Null until the first read lands, and whenever the tab has no repo. */
  stats: DiffStats | null;
  refresh: () => void;
}

/**
 * How much uncommitted work sits in the tab you are looking at.
 *
 * The shell in the pane below can edit, stage or commit at any moment, and none
 * of that reaches us as an event — so, like the branch chip, this runs on a slow
 * poll. `git diff --numstat` is cheap but not free: it only runs while the
 * window has focus, and never twice at once, so a slow repo falls behind rather
 * than piling up.
 */
export function useGitChanges(project: ProjectInfo | null): GitChanges {
  const [stats, setStats] = useState<DiffStats | null>(null);
  const path = project?.is_git ? project.path : null;

  const inFlight = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refresh = useCallback(() => {
    const target = pathRef.current;
    if (!target || inFlight.current) return;
    inFlight.current = true;
    gitDiffStats(target)
      .then((next) => {
        // The tab may have moved on while git was running.
        if (pathRef.current === target) setStats(next);
      })
      .catch(() => {
        // The folder can be renamed or unmounted underneath us.
        if (pathRef.current === target) setStats(null);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  useEffect(() => {
    setStats(null);
    if (!path) return;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => {
      if (document.hasFocus()) refresh();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [path, refresh]);

  return { stats, refresh };
}
