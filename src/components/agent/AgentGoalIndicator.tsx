import type { AgentGoal } from "../../lib/agents/types";

export function AgentGoalIndicator({ goal }: { goal: AgentGoal | null }) {
  if (goal?.status !== "active") return null;

  const detail = goal.objective ? `: ${goal.objective}` : "";
  const label = `Active goal${detail}`;

  return (
    <span className="agent-goal-indicator" role="status" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="6.5" cy="9.5" r="4.25" />
        <circle cx="6.5" cy="9.5" r="1.25" />
        <path d="M7.45 8.55 13.2 2.8" />
        <path d="M10.4 2.8h2.8v2.8" />
      </svg>
    </span>
  );
}
