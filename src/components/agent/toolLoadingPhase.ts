import type { ToolStatus } from "../../lib/agents/types";

export type ToolLoadingPhase = "indicator" | null;

/** Keep the compact activity indicator visible for the lifetime of a tool call. */
export function toolLoadingPhase(status: ToolStatus): ToolLoadingPhase {
  const active = status === "running" || status === "pending";
  return active ? "indicator" : null;
}
