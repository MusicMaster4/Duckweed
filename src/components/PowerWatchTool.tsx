import { useEffect, useState, useSyncExternalStore } from "react";

import { Tooltip } from "./Tooltip";
import {
  BUSY_REASON_LABELS,
  GRACE_CHOICES,
  POWER_ACTION_GERUNDS,
  arm,
  disarm,
  formatCountdown,
  getState,
  secondsLeft,
  setAction,
  setGrace,
  subscribe,
  type BusyReason,
  type PowerAction,
} from "../lib/powerWatch";

const MoonIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" />
  </svg>
);

const PowerIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5v5" />
    <path d="M4.9 4.9a4.5 4.5 0 1 0 6.2 0" />
  </svg>
);

const ACTIONS: {
  id: PowerAction;
  label: string;
  blurb: string;
  icon: () => JSX.Element;
}[] = [
  {
    id: "suspend",
    label: "Sleep",
    blurb: "Every window and shell is still here when the machine wakes.",
    icon: MoonIcon,
  },
  {
    id: "shutdown",
    label: "Shut down",
    blurb: "Closes everything and powers off. Unsaved work is lost.",
    icon: PowerIcon,
  },
];

/** Why one pane still counts, in words, for the activity list. */
const BUSY_REASON_HINTS: Record<BusyReason, string> = {
  process: "A command is still running in this pane.",
  "agent-starting": "The agent is still coming up.",
  "agent-working": "The agent is working on a turn you asked for.",
  "agent-waiting":
    "The agent is blocked on you, most likely a permission prompt. It will not clear on its own.",
};

/**
 * Arm a sleep or a shutdown for whenever the work finishes.
 *
 * The panel is mostly a readout: what it is waiting on, and how long is left.
 * Both matter when you are deciding whether to walk away, and an armed watch
 * that will not say what is holding it up is one you stop trusting. So the live
 * state leads and the plan sits under it, rather than the other way round.
 */
export function PowerWatchTool() {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const counting = state.phase === "countdown";
  const now = useTick(counting);
  const armed = state.phase === "armed" || counting;
  const chosen = ACTIONS.find((entry) => entry.id === state.action) ?? ACTIONS[0];
  const Chosen = chosen.icon;
  const grace = GRACE_CHOICES.find((choice) => choice.ms === state.graceMs);

  const left = secondsLeft(state, now);
  const remaining = state.graceMs > 0 ? Math.min(1, (left * 1000) / state.graceMs) : 0;

  return (
    <div className="power">
      <header className="tools-section-head power-head">
        <div>
          <span className="tools-section-title">Power watch</span>
          <span className="tools-section-note">
            {armed
              ? `${chosen.label} after ${grace?.label ?? "the grace period"} of quiet`
              : "Sleep or shut down when the work is done"}
          </span>
        </div>
        {state.phase !== "off" && (
          <span className={`power-pill is-${state.phase}`}>{PHASE_LABELS[state.phase]}</span>
        )}
      </header>

      <div className="power-body">
        {state.phase === "failed" && (
          <p className="power-error">
            <strong>The OS refused.</strong> {state.error}
          </p>
        )}

        {counting && (
          <article className="power-card is-counting">
            <header>
              <span className="power-card-title">{POWER_ACTION_GERUNDS[state.action]} in</span>
              <button type="button" className="power-stop" onClick={disarm}>
                Cancel
              </button>
            </header>
            <strong className="power-clock">{formatCountdown(left)}</strong>
            <p className="power-card-note">
              Every pane is idle. Anything that wakes up stops the clock.
            </p>
            <div className="power-track" aria-hidden="true">
              <div className="power-track-fill" style={{ width: `${remaining * 100}%` }} />
            </div>
          </article>
        )}

        {armed && !counting && (
          <article className="power-card">
            <header>
              <span className="power-card-title">
                {state.busy.length === 0 ? "Checking the panes" : "Still running"}
              </span>
              {state.busy.length > 0 && <em className="power-count">{state.busy.length}</em>}
              <button type="button" className="power-stop" onClick={disarm}>
                Cancel
              </button>
            </header>

            {state.busy.length === 0 ? (
              <p className="power-card-note">Reading what is running right now.</p>
            ) : (
              <>
                <ul className="power-busy-list">
                  {state.busy.map((entry) => (
                    <li key={entry.termId}>
                      <Tooltip title={entry.label} detail={BUSY_REASON_HINTS[entry.reason]}>
                        <div className="power-busy">
                          <span className={`power-dot is-${entry.reason}`} aria-hidden="true" />
                          <span className="power-busy-label">{entry.label}</span>
                          <span className="power-busy-reason">
                            {BUSY_REASON_LABELS[entry.reason]}
                          </span>
                        </div>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
                <p className="power-card-note">The clock starts when they all go quiet.</p>
              </>
            )}
          </article>
        )}

        <article className="power-card">
          <header>
            <span className="power-card-title">When the work is done</span>
          </header>

          <div
            className={`power-choice ${armed ? "is-locked" : ""}`}
            role="group"
            aria-label="Do this"
          >
            {ACTIONS.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`${state.action === entry.id ? "is-active" : ""} is-${entry.id}`}
                  aria-pressed={state.action === entry.id}
                  disabled={armed}
                  onClick={() => setAction(entry.id)}
                >
                  <Icon />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>
          <p className="power-hint">{chosen.blurb}</p>

          <span className="power-card-sub">Once everything is quiet for</span>
          <Tooltip
            title="Quiet period"
            detail="How long every pane has to stay idle before the countdown starts. Two minutes rides out the pause between two agent turns."
          >
            <div className="power-segment" role="group" aria-label="Quiet period">
              {GRACE_CHOICES.map((choice) => (
                <button
                  key={choice.ms}
                  type="button"
                  className={state.graceMs === choice.ms ? "is-active" : undefined}
                  aria-pressed={state.graceMs === choice.ms}
                  onClick={() => setGrace(choice.ms)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </Tooltip>
        </article>

        {!armed && (
          <>
            <button
              type="button"
              className={`power-arm is-${chosen.id}`}
              onClick={arm}
            >
              <Chosen />
              Arm {chosen.label.toLowerCase()}
            </button>
            <p className="power-note">
              Watches every pane in every tab. Arming lasts for this session only, so restarting
              Duckweed always leaves the machine alone.
            </p>
          </>
        )}
      </div>
    </div>
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
