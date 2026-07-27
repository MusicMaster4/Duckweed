import { useEffect, useState, useSyncExternalStore } from "react";

import {
  BUSY_REASON_LABELS,
  GRACE_CHOICES,
  POWER_ACTION_LABELS,
  formatCountdown,
  getState,
  secondsLeft,
  subscribe,
  arm,
  disarm,
  setAction,
  setGrace,
  type PowerAction,
} from "../lib/powerWatch";

const ACTION_HINTS: Record<PowerAction, string> = {
  suspend: "Sleep — everything stays open and comes back on wake.",
  shutdown: "Shut down — the machine powers off completely.",
};

/**
 * Arm a sleep or shutdown for whenever the work finishes.
 *
 * The panel is mostly a readout: what it is waiting on, and how long is left.
 * Both matter when you are deciding whether to walk away, and an armed watch
 * that will not say what is holding it up is one you stop trusting.
 */
export function PowerWatchTool() {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const ticking = state.phase === "countdown";
  const now = useTick(ticking);
  const armed = state.phase === "armed" || state.phase === "countdown";

  return (
    <>
      <div className="tools-section-head">
        <span className="tools-section-title">Power watch</span>
        <span className="tools-spacer" />
        <span className={`power-state is-${state.phase}`}>{PHASE_LABELS[state.phase]}</span>
      </div>

      <div className="power-body">
        <p className="power-lede">
          When every process and agent here has been quiet for the grace period, put the machine
          away.
        </p>

        <fieldset className="power-group" disabled={armed}>
          <legend>Then</legend>
          <div className="power-choices">
            {(["suspend", "shutdown"] as const).map((action) => (
              <button
                key={action}
                type="button"
                className={`power-choice ${state.action === action ? "is-active" : ""}`}
                aria-pressed={state.action === action}
                title={ACTION_HINTS[action]}
                onClick={() => setAction(action)}
              >
                {POWER_ACTION_LABELS[action]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="power-group">
          <legend>After quiet for</legend>
          <div className="power-choices">
            {GRACE_CHOICES.map((choice) => (
              <button
                key={choice.ms}
                type="button"
                className={`power-choice ${state.graceMs === choice.ms ? "is-active" : ""}`}
                aria-pressed={state.graceMs === choice.ms}
                title={`Wait ${choice.label} of nothing running before acting`}
                onClick={() => setGrace(choice.ms)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </fieldset>

        <button
          type="button"
          className={`power-arm ${armed ? "is-armed" : ""}`}
          onClick={() => (armed ? disarm() : arm())}
        >
          {armed ? "Cancel" : `Arm ${POWER_ACTION_LABELS[state.action].toLowerCase()}`}
        </button>

        {state.phase === "countdown" && (
          <p className="power-countdown">
            Nothing is running. {POWER_ACTION_LABELS[state.action]} in{" "}
            <strong>{formatCountdown(secondsLeft(state, now))}</strong> unless something starts.
          </p>
        )}

        {state.phase === "failed" && <p className="power-error">{state.error}</p>}

        {armed && (
          <div className="power-watching">
            <span className="power-watching-title">
              {state.busy.length === 0
                ? "Nothing running"
                : `Waiting on ${state.busy.length} ${state.busy.length === 1 ? "pane" : "panes"}`}
            </span>
            {state.busy.map((entry) => (
              <div key={entry.termId} className="power-busy">
                <span className={`power-dot is-${entry.reason}`} aria-hidden="true" />
                <span className="power-busy-label">{entry.label}</span>
                <span className="power-busy-reason">{BUSY_REASON_LABELS[entry.reason]}</span>
              </div>
            ))}
          </div>
        )}

        {!armed && (
          <p className="power-note">
            Arming lasts for this session only — restarting Duckweed always leaves the machine
            alone.
          </p>
        )}
      </div>
    </>
  );
}

const PHASE_LABELS: Record<string, string> = {
  off: "off",
  armed: "waiting",
  countdown: "counting down",
  firing: "going",
  failed: "failed",
};

/** One re-render a second, but only while a countdown is actually on screen. */
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
