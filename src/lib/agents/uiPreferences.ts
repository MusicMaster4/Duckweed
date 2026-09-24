import { AGENT_IDS } from "./catalog";
import type { AgentId } from "./types";

export type AgentUiPreferences = Record<AgentId, boolean>;

/** Older saves stored one boolean for every agent. Missing entries default on. */
export function agentUiPreferences(saved?: unknown): AgentUiPreferences {
  const legacy = typeof saved === "boolean" ? saved : true;
  const entries = saved && typeof saved === "object" && !Array.isArray(saved)
    ? saved as Record<string, unknown>
    : null;
  return Object.fromEntries(
    AGENT_IDS.map((id) => [id, typeof entries?.[id] === "boolean" ? entries[id] : legacy]),
  ) as AgentUiPreferences;
}
