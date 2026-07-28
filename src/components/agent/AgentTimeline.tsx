import type { AgentSessionState } from "../../lib/agents/types";
import { ChatGPTExperience } from "./official/ChatGPTExperience";
import { ClaudeExperience } from "./official/ClaudeExperience";
import { GrokExperience } from "./official/GrokExperience";
import type { ExperienceProps } from "./official/OfficialShared";
import "./official/OfficialExperiences.css";
import { CursorExperience } from "./provider/CursorExperience";
import { OpenCodeExperience } from "./provider/OpenCodeExperience";

interface AgentTimelineProps extends ExperienceProps {
  session: AgentSessionState;
}

/**
 * Provider-authentic transcript router.
 *
 * Codex follows ChatGPT's first-party interaction language. Claude and Grok
 * use the loading and trace mechanisms measured from their live sites.
 * Cursor and OpenCode use their separate, purpose-built work surfaces.
 */
export function AgentTimeline(props: AgentTimelineProps) {
  switch (props.agent) {
    case "codex":
      return <ChatGPTExperience {...props} />;
    case "claude":
      return <ClaudeExperience {...props} />;
    case "grok":
      return <GrokExperience {...props} />;
    case "cursor":
      return <CursorExperience session={props.session} items={props.items} />;
    case "opencode":
      return <OpenCodeExperience session={props.session} items={props.items} />;
  }
}
