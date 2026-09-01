import { useEffect, useState } from "react";

import type { ToolStatus } from "../../lib/agents/types";

export type ToolLoadingPhase = "indicator" | "shimmer" | null;

const INDICATOR_DURATION_MS = 1_400;

/**
 * Tool activity has two deliberately exclusive visual phases. The compact
 * indicator introduces the call, then yields to a text shimmer if the call is
 * still active. Terminal states cancel both immediately.
 */
export function useToolLoadingPhase(callId: string, status: ToolStatus): ToolLoadingPhase {
  const active = status === "running" || status === "pending";
  const [phase, setPhase] = useState<{ callId: string; value: Exclude<ToolLoadingPhase, null> }>(
    () => ({ callId, value: "indicator" }),
  );

  useEffect(() => {
    if (!active) return;

    setPhase({ callId, value: "indicator" });
    const timer = window.setTimeout(() => {
      setPhase((current) =>
        current.callId === callId ? { callId, value: "shimmer" } : current,
      );
    }, INDICATOR_DURATION_MS);

    return () => window.clearTimeout(timer);
  }, [active, callId]);

  if (!active) return null;
  return phase.callId === callId ? phase.value : "indicator";
}
