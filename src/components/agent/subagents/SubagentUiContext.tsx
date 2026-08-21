import { createContext, useContext, useMemo, type ReactNode } from "react";

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
  const absorbedCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const roster of rosters) {
      for (const subagent of roster.subagents) ids.add(subagent.callId);
    }
    return ids;
  }, [rosters]);
  const rosterAnchorIds = useMemo(
    () => new Set(rosters.map((roster) => roster.anchorItemId)),
    [rosters],
  );
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

  return (
    <SubagentUiContext.Provider value={value}>{children}</SubagentUiContext.Provider>
  );
}

export function useSubagentUi(): SubagentUiValue {
  return useContext(SubagentUiContext);
}
