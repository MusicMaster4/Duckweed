import { highlightAgentComposer } from "../../lib/agentComposerSyntax";

/** Keep sent prompts visually consistent with the composer without changing their text. */
export function AgentMessageText({ text }: { text: string }) {
  return <>{highlightAgentComposer(text).map((token, index) => (
    token.kind === "plain" ? token.text : (
      <span key={index} className={`agent-message-token token-${token.kind}`}>
        {token.text}
      </span>
    )
  ))}</>;
}
