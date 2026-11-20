import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  AgentSideConversation,
  AgentSideQuestion as SideQuestion,
} from "../../lib/agents/types";
import { AgentImageAttachments } from "./AgentImageAttachments";
import { AssistantMarkdown } from "./official/OfficialShared";

interface Props {
  conversation: AgentSideConversation;
  onDismiss: () => void;
  /** Send a follow-up in this side conversation. Returns false when it was not accepted. */
  onSubmit: (text: string) => boolean;
  /** Called when the user leaves the side input with Escape. */
  onLeave?: () => void;
  /** Focus the side input when the panel opens. */
  autoFocus?: boolean;
}

const STATUS_LABELS: Record<SideQuestion["status"], string> = {
  asking: "Answering",
  answered: "Ready",
  error: "Failed",
};

function SideTurn({ turn }: { turn: SideQuestion }) {
  const waiting = turn.status === "asking";
  const failed = turn.status === "error";
  return (
    <article className={`agent-side-turn is-${turn.status}`}>
      {turn.question && <p className="agent-side-question-prompt">{turn.question}</p>}
      {turn.images && turn.images.length > 0 && <AgentImageAttachments images={turn.images} />}
      {turn.answer ? (
        <div
          className={`agent-side-question-answer${failed ? " is-error" : ""}`}
          role={failed ? "alert" : undefined}
        >
          <AssistantMarkdown text={turn.answer} />
        </div>
      ) : waiting ? (
        <div className="agent-side-question-waiting" role="status" aria-live="polite">
          Answering beside the main conversation
          <span aria-hidden="true">...</span>
        </div>
      ) : (
        <p className="agent-side-question-error" role="alert">
          {failed ? "The side question could not be answered." : "No side answer was returned."}
        </p>
      )}
    </article>
  );
}

/**
 * Multi-turn side chat opened with `/side` or `/btw`. It takes half of the
 * agent pane, keeps its own input, and stays separate from the main
 * transcript until the user closes it.
 */
export function AgentSideChat({ conversation, onDismiss, onSubmit, onLeave, autoFocus = true }: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const latest = conversation.turns[conversation.turns.length - 1];
  const waiting = latest?.status === "asking";
  const failed = latest?.status === "error";
  const status = latest ? STATUS_LABELS[latest.status] : "New";

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, conversation.id]);

  // Follow the newest exchange the way the main transcript does.
  const lastAnswer = latest?.answer ?? "";
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [conversation.turns.length, lastAnswer]);

  const send = () => {
    const text = draft.trim();
    if (!text || waiting) return;
    if (onSubmit(text)) setDraft("");
  };

  return (
    <section
      className={`agent-side-question agent-side-chat is-${latest?.status ?? "empty"}`}
      role="complementary"
      aria-label="Side conversation"
      aria-busy={waiting}
    >
      <header className="agent-side-question-head">
        <span className="agent-side-question-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M3 3.5h4.5A2.5 2.5 0 0 1 10 6v.5" />
            <path d="M3 12.5h4.5A2.5 2.5 0 0 0 10 10v-.5" />
            <path d="m8.5 8 1.5 1.5L11.5 8" />
          </svg>
        </span>
        <strong>Side conversation</strong>
        <code>{conversation.command}</code>
        <span
          className={`agent-side-question-status${failed ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {waiting && <span className="agent-side-question-pulse" aria-hidden="true" />}
          {status}
        </span>
        <button
          type="button"
          className="agent-side-question-close"
          onClick={onDismiss}
          title="Close side conversation"
          aria-label="Close side conversation"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 3 6 6m0-6-6 6" />
          </svg>
        </button>
      </header>

      <div className="agent-side-question-body" ref={bodyRef}>
        {conversation.turns.length === 0 ? (
          <p className="agent-side-chat-empty">
            Ask something without interrupting the main conversation. Follow-ups stay in this
            thread until you close it.
          </p>
        ) : (
          conversation.turns.map((turn) => <SideTurn key={turn.id} turn={turn} />)
        )}
      </div>

      <form
        className="agent-side-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={waiting ? "Waiting for the side answer..." : "Reply in the side conversation"}
          aria-label="Side conversation message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onLeave?.();
            }
          }}
        />
        <button
          type="submit"
          className="agent-side-chat-send"
          disabled={!draft.trim() || waiting}
          title="Send"
          aria-label="Send side message"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 12.5v-9M4 7.5l4-4 4 4" />
          </svg>
        </button>
      </form>
    </section>
  );
}
