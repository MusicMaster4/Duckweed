import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { gitDiffStats } from "../lib/ipc";
import type { DiffStats, ProjectInfo } from "../lib/types";

export interface GitChanges {
  /** Null until the first read lands, and whenever the tab has no repo. */
  stats: DiffStats | null;
  refresh: () => void;
}

/**
 * How much uncommitted work sits in the tab you are looking at.
 *
 * The shell in the pane below can edit, stage or commit at any moment, and none
 * Filesystem notifications from the backend trigger refreshes. Focus remains a
 * cheap correctness fallback for suspended machines and temporarily unavailable
 * watchers; requests never overlap.
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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("project:changed", (event) => {
      if (event.payload === path) refresh();
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, [path, refresh]);

  return { stats, refresh };
}
