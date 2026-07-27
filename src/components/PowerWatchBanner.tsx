import { useEffect, useState, useSyncExternalStore } from "react";

import {
  POWER_ACTION_GERUNDS,
  disarm,
  formatCountdown,
  getState,
  secondsLeft,
  subscribe,
} from "../lib/powerWatch";

/**
 * The countdown, floated over the grid while it runs.
 *
 * The tools panel already shows this, but the panel is exactly what is closed
 * when somebody armed the watch and walked away, and a machine about to sleep
 * has to offer a way out from wherever you are looking. Mount once at the root.
 */
export function PowerWatchBanner() {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const visible = state.phase === "countdown";
  const now = useTick(visible);

  if (!visible) return null;

  return (
    <div className="power-banner" role="status">
      <span className="power-banner-dot" aria-hidden="true" />
      <span>
        {POWER_ACTION_GERUNDS[state.action]} in{" "}
        <strong>{formatCountdown(secondsLeft(state, now))}</strong>
      </span>
      <button type="button" className="power-banner-cancel" onClick={disarm}>
        Cancel
      </button>
    </div>
  );
}

function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
