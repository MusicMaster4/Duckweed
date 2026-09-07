import type { AgentSideQuestion as SideQuestion } from "../../lib/agents/types";
import { AgentImageAttachments } from "./AgentImageAttachments";
import { AssistantMarkdown } from "./official/OfficialShared";

interface Props {
  question: SideQuestion;
  onDismiss: () => void;
}

const STATUS_LABELS: Record<SideQuestion["status"], string> = {
  asking: "Answering",
  answered: "Answered",
  error: "Failed",
};

/** Ephemeral answer surface kept deliberately separate from the main transcript. */
export function AgentSideQuestion({ question, onDismiss }: Props) {
  const waiting = question.status === "asking";
  const failed = question.status === "error";

  return (
    <section
      className={`agent-side-question is-${question.status}`}
      role="complementary"
      aria-label="Side question"
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
        <strong>Side question</strong>
        <code>{question.command}</code>
        <span className="agent-side-question-status" role="status" aria-live="polite">
          {waiting && <span className="agent-side-question-pulse" aria-hidden="true" />}
          {STATUS_LABELS[question.status]}
        </span>
        <button
          type="button"
          className="agent-side-question-close"
          onClick={onDismiss}
          title="Dismiss side question"
          aria-label="Dismiss side question"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 3 6 6m0-6-6 6" />
          </svg>
        </button>
      </header>

      <div className="agent-side-question-body">
        {question.question && <p className="agent-side-question-prompt">{question.question}</p>}
        {question.images && question.images.length > 0 && (
          <AgentImageAttachments images={question.images} />
        )}
        {question.answer ? (
          <div
            className={`agent-side-question-answer${failed ? " is-error" : ""}`}
            role={failed ? "alert" : undefined}
            aria-live={failed ? undefined : "polite"}
          >
            <AssistantMarkdown text={question.answer} />
          </div>
        ) : waiting ? (
          <div className="agent-side-question-waiting" role="status" aria-live="polite">
            Answering beside the main conversation
            <span aria-hidden="true">...</span>
          </div>
        ) : (
          <p className="agent-side-question-error" role="alert">
            {failed
              ? "The side question could not be answered."
              : "No side answer was returned."}
          </p>
        )}
      </div>
    </section>
  );
}
