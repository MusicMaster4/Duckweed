import type { AgentGoal } from "../../lib/agents/types";

export function AgentGoalIndicator({ goal, onAction, disabled = false }: {
  goal: AgentGoal | null;
  onAction?: (action: "resume" | "pause") => void;
  disabled?: boolean;
}) {
  if (!goal || goal.status === "complete") return null;

  const detail = goal.objective ? `: ${goal.objective}` : "";
  const status = {
    active: "Active goal", paused: "Paused goal", blocked: "Blocked goal",
    usageLimited: "Goal usage limit reached", budgetLimited: "Goal budget limit reached",
  }[goal.status];
  const label = `${status}${detail}`;

  return (
    <span className="agent-goal-controls">
    <span
      className="agent-goal-indicator"
      role="status"
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="6.5" cy="9.5" r="4.25" />
        <circle cx="6.5" cy="9.5" r="1.25" />
        <path d="M7.45 8.55 13.2 2.8" />
        <path d="M10.4 2.8h2.8v2.8" />
      </svg>
    </span>
    {onAction && (
      <>
        <span className="agent-goal-status">{status}</span>
        {goal.status !== "active" && (
          <button type="button" className="agent-goal-action" disabled={disabled}
            onClick={() => onAction("resume")}>Resume goal</button>
        )}
        {goal.status !== "paused" && (
          <button type="button" className="agent-goal-action" disabled={disabled}
            title="Pause the goal's automatic continuation"
            onClick={() => onAction("pause")}>Stop goal</button>
        )}
      </>
    )}
    </span>
  );
}
