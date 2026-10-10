import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

import type { SubagentRoster } from "../../../lib/agents/subagents";
import type { AgentId } from "../../../lib/agents/types";

export interface SubagentUiValue {
  agent: AgentId | null;
  now: number;
  rosters: SubagentRoster[];
  absorbedCallIds: Set<string>;
  rosterAnchorIds: Set<string>;
  peekedCallId: string | null;
  focusedCallId: string | null;
  peekSubagent: (callId: string) => void;
  openSubagent: (callId: string) => void;
  closePeek: () => void;
  leaveFocus: () => void;
}

const EMPTY_SUBAGENT_UI: SubagentUiValue = {
  agent: null,
  now: 0,
  rosters: [],
  absorbedCallIds: new Set(),
  rosterAnchorIds: new Set(),
  peekedCallId: null,
  focusedCallId: null,
  peekSubagent: () => {},
  openSubagent: () => {},
  closePeek: () => {},
  leaveFocus: () => {},
};

const SubagentUiContext = createContext<SubagentUiValue>(EMPTY_SUBAGENT_UI);
type SubagentActivityUiValue = Pick<SubagentUiValue,
  "absorbedCallIds" | "rosterAnchorIds" | "peekedCallId" | "peekSubagent">;
const SubagentActivityUiContext = createContext<SubagentActivityUiValue>(EMPTY_SUBAGENT_UI);

export function SubagentUiProvider({
  agent,
  now = 0,
  rosters,
  peekedCallId,
  focusedCallId,
  onPeek,
  onOpen,
  onClosePeek,
  onLeaveFocus,
  children,
}: {
  agent: AgentId;
  now?: number;
  rosters: SubagentRoster[];
  peekedCallId: string | null;
  focusedCallId: string | null;
  onPeek: (callId: string) => void;
  onOpen: (callId: string) => void;
  onClosePeek: () => void;
  onLeaveFocus: () => void;
  children: ReactNode;
}) {
  const membershipRef = useRef({
    absorbedCallIds: EMPTY_SUBAGENT_UI.absorbedCallIds,
    rosterAnchorIds: EMPTY_SUBAGENT_UI.rosterAnchorIds,
  });
  const { absorbedCallIds, rosterAnchorIds } = useMemo(() => {
    const absorbedCallIds = new Set<string>();
    const rosterAnchorIds = new Set<string>();
    for (const roster of rosters) {
      rosterAnchorIds.add(roster.anchorItemId);
      for (const subagent of roster.subagents) absorbedCallIds.add(subagent.callId);
    }
    const previous = membershipRef.current;
    if (previous.absorbedCallIds.size === absorbedCallIds.size &&
        previous.rosterAnchorIds.size === rosterAnchorIds.size &&
        [...absorbedCallIds].every((id) => previous.absorbedCallIds.has(id)) &&
        [...rosterAnchorIds].every((id) => previous.rosterAnchorIds.has(id))) {
      return previous;
    }
    membershipRef.current = { absorbedCallIds, rosterAnchorIds };
    return membershipRef.current;
  }, [rosters]);
  const value = useMemo(
    () => ({
      agent,
      now,
      rosters,
      absorbedCallIds,
      rosterAnchorIds,
      peekedCallId,
      focusedCallId,
      peekSubagent: onPeek,
      openSubagent: onOpen,
      closePeek: onClosePeek,
      leaveFocus: onLeaveFocus,
    }),
    [
      absorbedCallIds,
      agent,
      focusedCallId,
      now,
      onClosePeek,
      onLeaveFocus,
      onOpen,
      onPeek,
      peekedCallId,
      rosterAnchorIds,
      rosters,
    ],
  );

  // Transcript chrome only needs membership and peek interaction. Clock ticks
  // and child output updates belong to the boards, not every historical tool.
  const activityValue = useMemo<SubagentActivityUiValue>(() => ({
    absorbedCallIds,
    rosterAnchorIds,
    peekedCallId,
    peekSubagent: onPeek,
  }), [absorbedCallIds, rosterAnchorIds, peekedCallId, onPeek]);

  return (
    <SubagentUiContext.Provider value={value}>
      <SubagentActivityUiContext.Provider value={activityValue}>
        {children}
      </SubagentActivityUiContext.Provider>
    </SubagentUiContext.Provider>
  );
}

export function useSubagentUi(): SubagentUiValue {
  return useContext(SubagentUiContext);
}

export function useSubagentActivityUi(): SubagentActivityUiValue {
  return useContext(SubagentActivityUiContext);
}
