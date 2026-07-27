import { useEffect, useLayoutEffect, useRef, useState } from "react";

import * as agents from "../../lib/agents/session";
import type { AgentSessionState } from "../../lib/agents/types";

interface Props {
  session: AgentSessionState;
  /** The pane holding this composer has the keyboard. */
  active: boolean;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
}

/** Tallest the composer grows before it scrolls instead. */
const MAX_ROWS = 10;

export function AgentComposer({ session, active, onSubmit, onInterrupt }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(() => agents.getDraft(session.termId));
  const [highlighted, setHighlighted] = useState(0);

  const working = session.status === "working";
  const ended = session.status === "exited" || session.status === "error";
  const query = value.startsWith("/") && !value.includes(" ") ? value.toLowerCase() : null;
  const matches =
    query === null
      ? []
      : session.commands.filter((command) => command.name.toLowerCase().startsWith(query)).slice(0, 8);

  // Grow with the text rather than scrolling a two-line box: a prompt is
  // usually a paragraph, and the composer is the only place to write it.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 20;
    node.style.height = `${Math.min(node.scrollHeight, lineHeight * MAX_ROWS)}px`;
  }, [value]);

  useEffect(() => {
    if (active && !ended) ref.current?.focus();
  }, [active, ended]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  const commit = (text: string) => {
    if (!text.trim()) return;
    onSubmit(text);
    setValue("");
    agents.setDraft(session.termId, "");
  };

  const change = (text: string) => {
    setValue(text);
    agents.setDraft(session.termId, text);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // App-level shortcuts (new tab, palette, …) must still work from here.
    if (event.ctrlKey && event.shiftKey) return;

    if (matches.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + matches.length) % matches.length);
      return;
    }
    if (matches.length > 0 && event.key === "Tab") {
      event.preventDefault();
      change(`${matches[highlighted].name} `);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (matches.length > 0 && query !== matches[highlighted].name) {
        change(`${matches[highlighted].name} `);
        return;
      }
      commit(value);
      return;
    }

    // Ctrl+C is what a terminal user reaches for to stop a runaway turn, and
    // Escape is what the agent's own TUI uses. Both should mean the same here.
    if (
      working &&
      ((event.key.toLowerCase() === "c" && event.ctrlKey && !window.getSelection()?.toString()) ||
        (event.key === "Escape" && !value))
    ) {
      event.preventDefault();
      onInterrupt();
    }
  };

  if (ended) return null;

  return (
    <div className="agent-composer">
      {matches.length > 0 && (
        <div className="agent-commands" role="listbox">
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              className={index === highlighted ? "is-active" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                change(`${command.name} `);
                ref.current?.focus();
              }}
            >
              <span className="agent-command-name">{command.name}</span>
              {command.description && (
                <span className="agent-command-desc">{command.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="agent-composer-row">
        <textarea
          ref={ref}
          className="agent-composer-input"
          value={value}
          rows={1}
          spellCheck={false}
          placeholder={
            working ? "Queue a follow-up…" : `Message ${session.label}…`
          }
          aria-label={`Message ${session.label}`}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {working ? (
          <button
            type="button"
            className="agent-composer-stop"
            onClick={onInterrupt}
            title="Stop this turn (Ctrl+C)"
          >
            <span className="agent-stop-glyph" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="agent-composer-send"
            onClick={() => commit(value)}
            disabled={!value.trim()}
            title="Send (Enter)"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
