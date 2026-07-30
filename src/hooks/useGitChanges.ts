import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { gitDiffStats } from "../lib/ipc";
import type { DiffStats, ProjectInfo } from "../lib/types";

export interface GitChanges {
  /** Null until the first read lands, and whenever the tab has no repo. */
  stats: DiffStats | null;
  refresh: () => void;
}

/** How many project paths to keep around for instant tab switches. */
const CACHE_LIMIT = 16;

/**
 * Last-known stats per project path. Survives tab switches so the status-bar
 * chip can reappear immediately while a background re-read catches up.
 */
const statsCache = new Map<string, DiffStats>();

function remember(path: string, stats: DiffStats): void {
  // Refresh LRU order: delete then set so the entry becomes newest.
  if (statsCache.has(path)) statsCache.delete(path);
  statsCache.set(path, stats);
  while (statsCache.size > CACHE_LIMIT) {
    const oldest = statsCache.keys().next().value;
    if (oldest === undefined) break;
    statsCache.delete(oldest);
  }
}

/**
 * How much uncommitted work sits in the tab you are looking at.
 *
 * Filesystem notifications from the backend trigger refreshes. Focus remains a
 * cheap correctness fallback for suspended machines and temporarily unavailable
 * watchers. Requests never overlap; a refresh that lands while one is running is
 * queued and runs against whatever path is current when the in-flight call ends.
 *
 * Stats for each project are cached across tab switches so a large working tree
 * does not blank the chip while git re-reads it.
 */
export function useGitChanges(project: ProjectInfo | null): GitChanges {
  const path = project?.is_git ? project.path : null;
  const [stats, setStats] = useState<DiffStats | null>(() =>
    path ? (statsCache.get(path) ?? null) : null,
  );

  const pathRef = useRef(path);
  pathRef.current = path;

  /** Path currently being read, or null when idle. */
  const inFlightPath = useRef<string | null>(null);
  /** Another refresh was requested while a call was in flight. */
  const pending = useRef(false);

  const refresh = useCallback(() => {
    const target = pathRef.current;
    if (!target) return;
    if (inFlightPath.current) {
      pending.current = true;
      return;
    }
    inFlightPath.current = target;
    gitDiffStats(target)
      .then((next) => {
        remember(target, next);
        // The tab may have moved on while git was running.
        if (pathRef.current === target) setStats(next);
      })
      .catch(() => {
        statsCache.delete(target);
        // The folder can be renamed or unmounted underneath us.
        if (pathRef.current === target) setStats(null);
      })
      .finally(() => {
        inFlightPath.current = null;
        if (pending.current) {
          pending.current = false;
          refresh();
        }
      });
  }, []);

  useEffect(() => {
    if (!path) {
      setStats(null);
      return;
    }
    // Instant paint from the last visit, then re-verify in the background.
    setStats(statsCache.get(path) ?? null);
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("project:changed", (event) => {
      // Leave the last chip up; refresh replaces it when the new counts land.
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
