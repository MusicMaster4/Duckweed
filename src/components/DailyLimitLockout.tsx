import { AnimatedDuck } from "./PaneDuck";
import { formatDailyLimit } from "../lib/dailyUsage";
import type { BusyEntry, BusyReason } from "../lib/powerWatch";

interface Props {
  limitMinutes: number;
  busy: BusyEntry[];
  onBackground: () => void;
  onClose: () => void;
}

function statusLabel(reason: BusyReason): string {
  switch (reason) {
    case "agent-starting":
      return "Starting";
    case "agent-waiting":
      return "Waiting";
    case "agent-working":
      return "Working";
    case "process":
      return "Running";
  }
}

export function DailyLimitLockout({
  limitMinutes,
  busy,
  onBackground,
  onClose,
}: Props) {
  const agentCount = busy.filter((entry) => entry.reason !== "process").length;
  const allFinished = busy.length === 0;
  const heading =
    agentCount === busy.length
      ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"} still finishing`
      : `${busy.length} background ${busy.length === 1 ? "task" : "tasks"} still running`;

  return (
    <section className="daily-lockout" aria-labelledby="daily-lockout-title">
      <div className="daily-lockout-duck" aria-hidden="true">
        <AnimatedDuck />
      </div>

      <div className="daily-lockout-copy">
        <span className="daily-lockout-kicker">
          Daily limit reached · {formatDailyLimit(limitMinutes)}
        </span>
        <h1 id="daily-lockout-title">You’ve used Duckweed enough for today.</h1>
        <p>See you tomorrow. Your time resets at midnight.</p>
      </div>

      <div
        className={`daily-lockout-work${allFinished ? " is-finished" : ""}`}
        aria-live="polite"
      >
        <div className="daily-lockout-work-head">
          <span className="daily-lockout-status-dot" aria-hidden="true" />
          <strong>{allFinished ? "All agents finished" : heading}</strong>
        </div>

        {!allFinished && (
          <>
            <p>Your work is safe. Duckweed stays locked while these finish.</p>
            <ul>
              {busy.map((entry) => (
                <li key={entry.termId}>
                  <span>{entry.label}</span>
                  <small>{statusLabel(entry.reason)}</small>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="daily-lockout-actions">
        {allFinished ? (
          <button type="button" className="daily-lockout-primary" onClick={onClose}>
            Close Duckweed
          </button>
        ) : (
          <>
            <button
              type="button"
              className="daily-lockout-primary"
              onClick={onBackground}
            >
              Continue in background
            </button>
            <small>Duckweed will close automatically when everything finishes.</small>
          </>
        )}
      </div>
    </section>
  );
}
