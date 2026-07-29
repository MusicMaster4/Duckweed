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
 * Mirror a provider-owned `/goal` command into the shared session state.
 *
 * Codex has structured goal RPCs and does not need this fallback. Claude and
 * ACP agents receive slash commands as prompt text, so this keeps their header
 * indicator useful even when the protocol does not expose a goal object.
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
 * Read the compact status text returned by a provider-owned goal command.
 * This is intentionally used only for slash-command responses, never normal
 * assistant prose, so a sentence about a completed goal cannot alter chrome.
 */
export function goalAfterProviderText(
  current: AgentGoal | null,
  text: string,
): AgentGoal | null | undefined {
  if (/\b(?:no goal is set|goal (?:was )?cleared)\b/i.test(text)) return null;

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
