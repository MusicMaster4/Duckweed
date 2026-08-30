import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentPermission as Permission,
  AgentQuestionAnswer,
  AgentQuestionItem,
} from "../../lib/agents/types";

interface Props {
  permission: Permission;
  /** Send the collected answers back to the agent. */
  onAnswer: (answers: AgentQuestionAnswer[]) => void;
  /** Walk away without answering. */
  onSkip: () => void;
}

/** Selected option ids and free text, per question id. */
type Draft = Record<string, { picked: string[]; custom: string }>;

function emptyDraft(questions: AgentQuestionItem[]): Draft {
  const draft: Draft = {};
  for (const question of questions) draft[question.id] = { picked: [], custom: "" };
  return draft;
}

/** A question is answered once it has a choice, or text standing in for one. */
function isAnswered(question: AgentQuestionItem, draft: Draft): boolean {
  if (question.required === false) return true;
  const entry = draft[question.id];
  if (!entry) return false;
  if (entry.picked.length > 0) return true;
  const custom = entry.custom.trim();
  if (custom === "" || question.allowCustom === false) return false;
  if (question.inputKind !== "number" && question.inputKind !== "integer") return true;
  const value = Number(custom);
  if (!Number.isFinite(value)) return false;
  if (question.inputKind === "integer" && !Number.isInteger(value)) return false;
  if (question.minimum !== undefined && value < question.minimum) return false;
  if (question.maximum !== undefined && value > question.maximum) return false;
  return true;
}

function toAnswers(questions: AgentQuestionItem[], draft: Draft): AgentQuestionAnswer[] {
  return questions.map((question) => {
    const entry = draft[question.id] ?? { picked: [], custom: "" };
    const byId = new Map(question.options.map((option) => [option.id, option.label]));
    return {
      questionId: question.id,
      // Ordered by the question, not by the order they were clicked: the agent
      // reads these as a set, and a stable order is easier to compare.
      labels: question.options
        .filter((option) => entry.picked.includes(option.id))
        .map((option) => byId.get(option.id) ?? option.label),
      custom: entry.custom.trim() || null,
    };
  });
}

/**
 * The agent asked the user something, and is waiting on the answer.
 *
 * This is a different act from approving a tool call, so it gets a different
 * card: the choices are the content, not a pair of buttons under a command.
 * Everything is reachable by mouse and by keyboard, and there is always a way
 * to answer with something the agent did not think to offer.
 *
 * A single-choice question that is the only one on screen submits as soon as it
 * is picked. That is the common case by a wide margin, and making it a click
 * instead of a click and a confirm is most of what makes this feel quick.
 * Anything less obvious (several questions, several choices, typed text) waits
 * for an explicit send.
 */
export function AgentQuestion({ permission, onAnswer, onSkip }: Props) {
  const questions = useMemo(() => permission.questions ?? [], [permission.questions]);
  const cardRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(questions));
  /** Keyboard cursor: [question, option]. -1 means nothing is highlighted. */
  const [cursor, setCursor] = useState<[number, number]>([0, -1]);
  const [sent, setSent] = useState(false);
  /** Which option's preview is open, keyed `questionId:optionId`. */
  const [openPreview, setOpenPreview] = useState<string | null>(null);

  const answered = questions.filter((question) => isAnswered(question, draft)).length;
  const complete = questions.length > 0 && answered === questions.length;
  const instant =
    questions.length === 1 && !questions[0].multiSelect && questions[0].options.length > 0;

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest" });
    // Take the keyboard: the composer is disabled while a question is open, so
    // there is nothing else the arrow keys could sensibly be for.
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const send = (next: Draft = draft) => {
    if (sent) return;
    setSent(true);
    onAnswer(toAnswers(questions, next));
  };

  const skip = () => {
    if (sent) return;
    setSent(true);
    onSkip();
  };

  // Escape reaches the card even while the note textarea has the keyboard, and
  // it is read through a ref so the listener is registered exactly once.
  const skipRef = useRef(skip);
  skipRef.current = skip;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      skipRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const choose = (questionIndex: number, optionId: string) => {
    if (sent) return;
    const question = questions[questionIndex];
    const entry = draft[question.id] ?? { picked: [], custom: "" };
    const picked = question.multiSelect
      ? entry.picked.includes(optionId)
        ? entry.picked.filter((id) => id !== optionId)
        : [...entry.picked, optionId]
      : entry.picked.includes(optionId)
        ? []
        : [optionId];
    const next: Draft = { ...draft, [question.id]: { ...entry, picked } };
    setDraft(next);
    setCursor([questionIndex, question.options.findIndex((option) => option.id === optionId)]);

    if (instant && picked.length > 0 && !entry.custom.trim()) {
      send(next);
      return;
    }
    // Several questions: land on the next one still waiting for an answer.
    if (!question.multiSelect && picked.length > 0) {
      const following = questions.findIndex(
        (candidate, index) => index > questionIndex && !isAnswered(candidate, next),
      );
      if (following >= 0) setCursor([following, -1]);
    }
  };

  const writeCustom = (questionId: string, text: string) => {
    setDraft((current) => ({
      ...current,
      [questionId]: { ...(current[questionId] ?? { picked: [] }), custom: text },
    }));
  };

  /** Arrow keys walk every option on the card as one list; digits jump. */
  const onCardKeyDown = (event: React.KeyboardEvent) => {
    if (sent) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      // Ctrl/Cmd+Enter sends from inside a note, the way the composer does.
      if (
        event.key === "Enter" &&
        (target.tagName === "INPUT" || event.ctrlKey || event.metaKey) &&
        complete
      ) {
        event.preventDefault();
        send();
      }
      return;
    }
    // Ctrl+1 is "go to tab 1" and Alt+Arrow moves pane focus. A card that has
    // the keyboard must not quietly redefine the window's own shortcuts.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const [questionIndex, optionIndex] = cursor;
    const question = questions[questionIndex];

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      let nextQuestion = questionIndex;
      let nextOption = optionIndex + step;
      while (nextOption < 0 || nextOption >= questions[nextQuestion].options.length) {
        const movedQuestion = nextQuestion + step;
        if (movedQuestion < 0 || movedQuestion >= questions.length) {
          nextOption = Math.min(
            Math.max(nextOption, 0),
            questions[nextQuestion].options.length - 1,
          );
          break;
        }
        nextQuestion = movedQuestion;
        nextOption = step > 0 ? 0 : questions[nextQuestion].options.length - 1;
      }
      setCursor([nextQuestion, nextOption]);
      return;
    }

    // Space always toggles what the cursor is on. Enter picks while there is
    // still something to answer, and sends once there is not, so holding it
    // down never lands on "un-choose the answer I just gave".
    if (event.key === " ") {
      if (optionIndex >= 0 && question) {
        event.preventDefault();
        choose(questionIndex, question.options[optionIndex].id);
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (complete) {
        send();
        return;
      }
      if (optionIndex >= 0 && question && !isAnswered(question, draft)) {
        choose(questionIndex, question.options[optionIndex].id);
      }
      return;
    }

    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && question && digit <= question.options.length) {
      event.preventDefault();
      choose(questionIndex, question.options[digit - 1].id);
    }
  };

  if (questions.length === 0) return null;

  return (
    <div
      className="agent-question"
      ref={cardRef}
      tabIndex={-1}
      role="alertdialog"
      aria-label={questions.length === 1 ? questions[0].question : "Questions from the agent"}
      onKeyDown={onCardKeyDown}
    >
      <div className="agent-question-head">
        <span className="agent-question-mark" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M5.9 5.8a2.15 2.15 0 1 1 3 2.35c-.55.3-.9.85-.9 1.5v.4" fill="none" />
            <circle cx="8" cy="12.4" r="0.85" stroke="none" />
          </svg>
        </span>
        <strong>{questions.length === 1 ? "A question for you" : "Questions for you"}</strong>
        {questions.length > 1 && (
          <span className="agent-question-progress">
            {answered} of {questions.length} answered
          </span>
        )}
      </div>

      {questions.map((question, questionIndex) => {
        const entry = draft[question.id] ?? { picked: [], custom: "" };
        const done = isAnswered(question, draft);
        return (
          <section
            key={question.id}
            className={`agent-question-block${done ? " is-answered" : ""}`}
          >
            <div className="agent-question-ask">
              {question.header && (
                <span className="agent-question-chip">{question.header}</span>
              )}
              <p className="agent-question-text">{question.question}</p>
            </div>

            <div
              className="agent-question-options"
              role={question.multiSelect ? "group" : "radiogroup"}
              aria-label={question.question}
            >
              {question.inputKind === "url" && question.placeholder && (
                <a
                  className="agent-question-url"
                  href={question.placeholder}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open authorization page
                </a>
              )}
              {question.options.map((option, optionIndex) => {
                const picked = entry.picked.includes(option.id);
                const previewKey = `${question.id}:${option.id}`;
                return (
                  <div key={option.id} className="agent-question-option-wrap">
                    <button
                      type="button"
                      className={`agent-question-option${picked ? " is-picked" : ""}${
                        cursor[0] === questionIndex && cursor[1] === optionIndex
                          ? " is-cursor"
                          : ""
                      }`}
                      role={question.multiSelect ? "checkbox" : "radio"}
                      aria-checked={picked}
                      disabled={sent}
                      onMouseEnter={() => setCursor([questionIndex, optionIndex])}
                      /* Tabbing to an option is another way of pointing at it,
                         so the keys that act on the cursor keep agreeing with
                         whatever the user is actually looking at. */
                      onFocus={() => setCursor([questionIndex, optionIndex])}
                      onClick={() => choose(questionIndex, option.id)}
                    >
                      <span className="agent-question-key" aria-hidden="true">
                        {optionIndex + 1}
                      </span>
                      <span className="agent-question-copy">
                        <span className="agent-question-label">{option.label}</span>
                        {option.description && (
                          <span className="agent-question-desc">{option.description}</span>
                        )}
                      </span>
                      <span className="agent-question-tick" aria-hidden="true">
                        <svg viewBox="0 0 12 12">
                          <path d="m2.6 6.2 2.3 2.3 4.5-4.8" fill="none" />
                        </svg>
                      </span>
                    </button>
                    {option.preview && (
                      <>
                        <button
                          type="button"
                          className="agent-question-preview-toggle"
                          aria-expanded={openPreview === previewKey}
                          onClick={() =>
                            setOpenPreview(openPreview === previewKey ? null : previewKey)
                          }
                        >
                          {openPreview === previewKey ? "Hide preview" : "Show preview"}
                        </button>
                        {openPreview === previewKey && (
                          <pre className="agent-question-preview">{option.preview}</pre>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {question.allowCustom !== false && (
              <label className="agent-question-custom">
              <span className="agent-question-custom-label">
                {entry.picked.length > 0
                  ? "Add a note (optional)"
                  : "Or write your own answer"}
              </span>
              {question.inputKind === "secret" ? (
                <input
                  type="password"
                  value={entry.custom}
                  disabled={sent}
                  autoComplete="off"
                  placeholder={question.placeholder ?? "Enter a private value"}
                  onChange={(event) => writeCustom(question.id, event.target.value)}
                />
              ) : question.inputKind === "number" || question.inputKind === "integer" ? (
                <input
                  type="number"
                  step={question.inputKind === "integer" ? 1 : "any"}
                  min={question.minimum}
                  max={question.maximum}
                  value={entry.custom}
                  disabled={sent}
                  placeholder={question.placeholder ?? "Enter a number"}
                  onChange={(event) => writeCustom(question.id, event.target.value)}
                />
              ) : (
                <textarea
                  rows={1}
                  value={entry.custom}
                  disabled={sent}
                  placeholder={
                    entry.picked.length > 0
                      ? "Anything the agent should know about that choice"
                      : question.placeholder ?? "Answer in your own words"
                  }
                  onChange={(event) => writeCustom(question.id, event.target.value)}
                  onInput={(event) => {
                    const node = event.currentTarget;
                    node.style.height = "auto";
                    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
                  }}
                />
              )}
              </label>
            )}
          </section>
        );
      })}

      <div className="agent-question-actions">
        <span className="agent-question-hint" aria-hidden="true">
          {instant ? (
            <>
              <kbd>1</kbd>
              <span>to answer</span>
            </>
          ) : (
            <>
              <kbd>Enter</kbd>
              <span>to send</span>
            </>
          )}
          <span className="agent-question-hint-sep">·</span>
          <kbd>Esc</kbd>
          <span>to skip</span>
        </span>
        <button type="button" className="agent-question-skip" disabled={sent} onClick={skip}>
          Skip
        </button>
        <button
          type="button"
          className="agent-question-send"
          disabled={sent || !complete}
          onClick={() => send()}
        >
          {sent
            ? "Sent"
            : questions.length > 1 && !complete
              ? `Answer all ${questions.length}`
              : "Send answer"}
        </button>
      </div>
    </div>
  );
}
