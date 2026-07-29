import type { AgentGoal, AgentGoalStatus } from "./types";

const GOAL_STATUS_FROM_TEXT: Record<string, AgentGoalStatus> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  complete: "complete",
  completed: "complete",
  achieved: "complete",
  "usage limited": "usageLimited",
  "budget limited": "budgetLimited",
};

/**
 * Mirror a provider-owned `/goal` command into shared session state.
 *
 * Codex has structured goal RPCs and does not need this fallback. Claude and
 * ACP agents receive supported slash commands as prompt text, so their chrome
 * needs a provisional state until the provider responds.
 */
export function goalAfterCommand(
  current: AgentGoal | null,
  text: string,
): AgentGoal | null | undefined {
  const match = /^\/goal(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) return undefined;

  const argument = match[1]?.trim() ?? "";
  if (!argument) return undefined;

  const [rawAction, ...rest] = argument.split(/\s+/);
  const action = rawAction.toLowerCase();
  if (action === "status") return undefined;
  if (action === "clear") return null;
  if (action === "pause") {
    return { objective: current?.objective ?? null, status: "paused" };
  }
  if (action === "resume") {
    return { objective: current?.objective ?? null, status: "active" };
  }
  if (action === "edit") {
    const objective = rest.join(" ").trim();
    return objective ? { objective, status: "active" } : undefined;
  }

  return { objective: argument, status: "active" };
}

/**
 * Read provider feedback only while a `/goal` response is pending.
 *
 * Keeping this parser scoped to a goal command prevents ordinary assistant
 * prose about completed or blocked work from changing the header indicator.
 */
export function goalAfterProviderText(
  current: AgentGoal | null,
  text: string,
): AgentGoal | null | undefined {
  if (/\b(?:no goal is set|goal (?:was )?cleared)\b/i.test(text)) return null;

  const setMatch = /(?:^|\n)\s*goal set:\s*(.+?)\s*$/im.exec(text);
  if (setMatch) {
    return { objective: setMatch[1].trim(), status: "active" };
  }

  const statusMatch =
    /\bgoal(?:\s+is|\s+status:)?\s+(active|paused|blocked|complete|completed|achieved|usage limited|budget limited)\b/i.exec(
      text,
    );
  if (!statusMatch) return undefined;

  const status = GOAL_STATUS_FROM_TEXT[statusMatch[1].toLowerCase()];
  const objectiveMatch = /(?:^|\n)\s*objective:\s*(.+)\s*$/im.exec(text);
  return {
    objective: objectiveMatch?.[1].trim() || current?.objective || null,
    status,
  };
}

export function goalResponseFailed(text: string): boolean {
  return /unknown command|invalid argument|goals? (?:are|is) disabled|could not|cannot|failed/i.test(
    text,
  );
}
