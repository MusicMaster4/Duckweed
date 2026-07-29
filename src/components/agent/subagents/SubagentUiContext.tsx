import { createContext, useContext, type ReactNode } from "react";

interface SubagentUiValue {
  selectedCallId: string | null;
  selectSubagent: (callId: string) => void;
}

const EMPTY_SUBAGENT_UI: SubagentUiValue = {
  selectedCallId: null,
  selectSubagent: () => {},
};

const SubagentUiContext = createContext<SubagentUiValue>(EMPTY_SUBAGENT_UI);

export function SubagentUiProvider({
  selectedCallId,
  onSelect,
  children,
}: {
  selectedCallId: string | null;
  onSelect: (callId: string) => void;
  children: ReactNode;
}) {
  return (
    <SubagentUiContext.Provider
      value={{ selectedCallId, selectSubagent: onSelect }}
    >
      {children}
    </SubagentUiContext.Provider>
  );
}

export function useSubagentUi(): SubagentUiValue {
  return useContext(SubagentUiContext);
}
