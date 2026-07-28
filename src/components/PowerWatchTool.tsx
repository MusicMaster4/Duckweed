import { useEffect, useState, useSyncExternalStore } from "react";

import { Tooltip } from "./Tooltip";
import {
  BUSY_REASON_LABELS,
  GRACE_CHOICES,
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
 * that will not say what is holding it up is one you stop trusting.
 */
export function PowerWatchTool() {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const counting = state.phase === "countdown";
  const now = useTick(counting);
  const armed = state.phase === "armed" || counting;
  const chosen = ACTIONS.find((entry) => entry.id === state.action) ?? ACTIONS[0];

  const left = secondsLeft(state, now);
  const remaining = state.graceMs > 0 ? Math.min(1, (left * 1000) / state.graceMs) : 0;

  return (
    <div className="power">
      <header className="tools-section-head power-head">
        <div>
          <span className="tools-section-title">Power watch</span>
          <span className="tools-section-note">
            {armed
              ? counting
                ? "Countdown is running"
                : "Watching every pane"
              : "Sleep or shut down when the work is done"}
          </span>
        </div>
        <span className={`power-pill is-${state.phase}`}>{PHASE_LABELS[state.phase]}</span>
      </header>

      <div className="power-body">
        {!armed && (
          <p className="power-lede">
            Watches every pane in every tab. Once they have all been quiet for the grace period, the
            machine goes to sleep or shuts down.
          </p>
        )}

        {state.phase === "failed" && (
          <p className="power-error">
            <strong>The OS refused.</strong> {state.error}
          </p>
        )}

        <section className={`power-section ${armed ? "is-locked" : ""}`} aria-label="Do this">
          <header>
            <span className="power-section-title">Do this</span>
          </header>
          <div className="power-actions" role="group">
            {ACTIONS.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`power-action ${state.action === entry.id ? "is-active" : ""}`}
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
        </section>

        <section className="power-section" aria-label="After everything is quiet for">
          <header>
            <span className="power-section-title">After everything is quiet for</span>
          </header>
          <div className="power-segment" role="group" aria-label="Grace period">
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
          <p className="power-hint">
            {state.graceMs <= 60_000
              ? "Short. Good when you are only waiting on one long build."
              : "Long enough that the pause between two agent turns will not set it off."}
          </p>
        </section>

        {!armed && (
          <button type="button" className="power-arm" onClick={arm}>
            Arm {chosen.label.toLowerCase()}
          </button>
        )}

        {armed && (
          <section className="power-section">
            <header className="power-section-head">
              <span className="power-section-title">
                {state.busy.length === 0 ? "Nothing running" : "Still running"}
              </span>
              {state.busy.length > 0 && (
                <span className="power-activity-count">{state.busy.length}</span>
              )}
            </header>

            {state.busy.length === 0 ? (
              <p className="power-hint">Every pane is idle.</p>
            ) : (
              <ul className="power-busy-list">
                {state.busy.map((entry) => (
                  <li key={entry.termId}>
                    <Tooltip
                      title={entry.label}
                      detail={BUSY_REASON_HINTS[entry.reason]}
                    >
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
            )}
          </section>
        )}

        {counting ? (
          <div className="power-hero is-counting">
            <span className="power-hero-time">{formatCountdown(left)}</span>
            <span className="power-hero-caption">
              until {chosen.label.toLowerCase()}. Nothing is running.
            </span>
            <div className="power-hero-track">
              <div className="power-hero-fill" style={{ width: `${remaining * 100}%` }} />
            </div>
            <button type="button" className="power-cancel" onClick={disarm}>
              Cancel
            </button>
          </div>
        ) : armed ? (
          <div className="power-hero">
            <span className="power-hero-title">Waiting for the work to finish</span>
            <span className="power-hero-caption">
              {state.busy.length === 0
                ? "Checking what is running."
                : `${state.busy.length} ${state.busy.length === 1 ? "pane is" : "panes are"} still busy. The countdown starts when they all go quiet.`}
            </span>
            <button type="button" className="power-cancel" onClick={disarm}>
              Cancel
            </button>
          </div>
        ) : null}

        {!armed && (
          <p className="power-note">
            Arming lasts for this session only. Restarting Duckweed always leaves the machine alone.
          </p>
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
