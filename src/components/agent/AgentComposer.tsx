import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { GUIDED_ARG_COMMANDS } from "../../lib/agents/slashCatalog";
import {
  effortsFor,
  shortModelLabel,
  type AgentSessionState,
} from "../../lib/agents/types";
import * as agents from "../../lib/agents/session";
import * as terminals from "../../lib/terminals";
import { AgentControls } from "./AgentControls";

interface Props {
  session: AgentSessionState;
  /** The pane holding this composer has the keyboard. */
  active: boolean;
  /** Shared with the surface, so a click anywhere quiet can focus the input. */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
}

/** Tallest the composer grows before it scrolls instead. */
const MAX_ROWS = 10;

type MenuRow = {
  /** Value inserted / submitted. */
  value: string;
  /** Primary label in the list. */
  label: string;
  description: string;
  /** True when this is the session's current model/effort. */
  current: boolean;
};

type Menu =
  | { kind: "commands"; rows: MenuRow[] }
  | { kind: "args"; command: "/model" | "/effort"; rows: MenuRow[] };

function buildMenu(value: string, session: AgentSessionState): Menu | null {
  if (!value.startsWith("/")) return null;

  // `/model …` or `/effort …` — guided argument list once the command is
  // complete (has a trailing space or partial arg). Bare `/model` still
  // shows the command list so Tab can complete it.
  const argMatch = /^(\/(?:model|effort))(?:\s+)(.*)$/i.exec(value);
  if (argMatch) {
    const command = argMatch[1].toLowerCase() as "/model" | "/effort";
    const partial = argMatch[2].toLowerCase();
    if (command === "/model") {
      const rows = session.models
        .filter((model) => {
          if (!partial) return true;
          return (
            model.id.toLowerCase().includes(partial) ||
            model.label.toLowerCase().includes(partial)
          );
        })
        .slice(0, 12)
        .map((model) => ({
          value: model.id,
          label: model.label || shortModelLabel(model.id),
          description: model.id !== model.label ? model.id : model.efforts.join(", "),
          current:
            session.model === model.id ||
            session.model === model.label ||
            (!!session.model && model.id.endsWith(`/${session.model}`)),
        }));
      if (rows.length) return { kind: "args", command, rows };
      return null;
    }
    const rows = effortsFor(session)
      .filter((effort) => !partial || effort.toLowerCase().startsWith(partial))
      .map((effort) => ({
        value: effort,
        label: effort,
        description: session.effort === effort ? "current" : "",
        current: session.effort === effort,
      }));
    if (rows.length) return { kind: "args", command, rows };
    return null;
  }

  // Command name completion: only while there is no space yet.
  if (value.includes(" ")) return null;
  const query = value.toLowerCase();
  const rows = session.commands
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .slice(0, 8)
    .map((command) => ({
      value: command.name,
      label: command.name,
      description: command.description,
      current: false,
    }));
  return rows.length ? { kind: "commands", rows } : null;
}

export function AgentComposer({ session, active, inputRef, onSubmit, onInterrupt }: Props) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;
  const [value, setValue] = useState(() => agents.getDraft(session.termId));
  const [highlighted, setHighlighted] = useState(0);

  const working = session.status === "working";
  const ended = session.status === "exited" || session.status === "error";
  const menu = buildMenu(value, session);
  const rows = menu?.rows ?? [];

  const change = (text: string) => {
    setValue(text);
    agents.setDraft(session.termId, text);
  };

  const commit = (text: string) => {
    if (!text.trim()) return;
    onSubmit(text);
    setValue("");
    agents.setDraft(session.termId, "");
  };

  // Grow with the text rather than scrolling a two-line box: a prompt is
  // usually a paragraph, and the composer is the only place to write it.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 20;
    node.style.height = `${Math.min(node.scrollHeight, lineHeight * MAX_ROWS)}px`;
  }, [value]);

  // Same registry the shell composer uses: pane activation, paste shortcuts,
  // and App's "keep OS focus on the active terminal" effect all call
  // terminals.focus(termId). Without a focuser here they land on the hidden
  // xterm grid, and typing vanishes while the message box looks selected.
  useEffect(() => {
    return terminals.registerInputFocus(session.termId, () => {
      if (ended) return;
      ref.current?.focus();
    });
  }, [session.termId, ended]);

  useEffect(() => {
    return terminals.registerInputPaste(session.termId, (text) => {
      if (ended) return;
      const node = ref.current;
      const current = agents.getDraft(session.termId);
      if (!node) {
        change(current + text);
        return;
      }
      const start = node.selectionStart ?? current.length;
      const end = node.selectionEnd ?? current.length;
      const next = current.slice(0, start) + text + current.slice(end);
      change(next);
      requestAnimationFrame(() => {
        const pos = start + text.length;
        node.focus();
        node.setSelectionRange(pos, pos);
      });
    });
  }, [session.termId, ended]);

  useEffect(() => {
    if (active && !ended) ref.current?.focus();
  }, [active, ended]);

  useEffect(() => {
    setHighlighted(0);
  }, [menu?.kind, value]);

  const applyRow = (row: MenuRow) => {
    if (!menu) return;
    if (menu.kind === "commands") {
      // Trailing space opens the guided argument menu for /model and /effort.
      change(`${row.value} `);
      return;
    }
    commit(`${menu.command} ${row.value}`);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // App-level shortcuts (new tab, palette, …) must still work from here.
    if (event.ctrlKey && event.shiftKey) return;

    if (rows.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + rows.length) % rows.length);
      return;
    }
    if (rows.length > 0 && event.key === "Tab") {
      event.preventDefault();
      applyRow(rows[highlighted]);
      return;
    }
    if (rows.length > 0 && event.key === "Escape") {
      event.preventDefault();
      if (menu?.kind === "args") {
        // Back out to the bare command rather than wiping the draft.
        change(`${menu.command} `);
      } else {
        change("");
      }
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (menu && rows.length > 0) {
        if (menu.kind === "args") {
          applyRow(rows[highlighted]);
          return;
        }
        const selected = rows[highlighted];
        // Complete the command name (with a trailing space) instead of
        // submitting bare `/model` / `/effort`, so the options list opens.
        if (
          GUIDED_ARG_COMMANDS.has(selected.value.toLowerCase()) ||
          value.toLowerCase() !== selected.value.toLowerCase()
        ) {
          change(`${selected.value} `);
          return;
        }
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

  /**
   * Clicks on the composer's chrome (padding, footer gap) still mean "type
   * here". Real controls (buttons, the textarea itself) keep their own
   * behaviour; everything else hands the keyboard to the message box.
   */
  const focusInputFromChrome = (event: React.MouseEvent) => {
    if (ended) return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea")) return;
    ref.current?.focus();
  };

  return (
    <div className="agent-composer" onMouseDown={focusInputFromChrome}>
      {menu && rows.length > 0 && (
        <div
          className="agent-commands"
          role="listbox"
          aria-label={
            menu.kind === "commands"
              ? "Commands"
              : menu.command === "/model"
                ? "Models"
                : "Effort"
          }
        >
          {menu.kind === "args" && (
            <div className="agent-commands-hint">
              {menu.command === "/model" ? "Model" : "Reasoning effort"}
              <span>↑↓ · Enter</span>
            </div>
          )}
          {rows.map((row, index) => (
            <button
              key={`${row.value}-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              className={[
                index === highlighted ? "is-active" : "",
                row.current ? "is-current" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseDown={(event) => {
                event.preventDefault();
                applyRow(row);
                ref.current?.focus();
              }}
            >
              <span className="agent-command-name">{row.label}</span>
              {row.description && (
                <span className="agent-command-desc">{row.description}</span>
              )}
              {row.current && (
                <span className="agent-command-current" aria-hidden="true">
                  ✓
                </span>
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
        {/* No send button: Enter submits, and a button that only ever repeats
            a key everybody already presses is a permanent third of the row. */}
        {working && (
          <button
            type="button"
            className="agent-composer-stop"
            onClick={onInterrupt}
            title="Stop this turn (Ctrl+C)"
            aria-label="Stop this turn"
          >
            <span className="agent-stop-glyph" aria-hidden="true" />
          </button>
        )}
      </div>
      {/* T3-style footer: model + effort always available under the input.
          Picker changes use the adapter directly, without clearing the draft
          or exposing an internal slash command as a chat turn. */}
      <div className="agent-composer-footer">
        <AgentControls
          session={session}
          placement="composer"
          onSelect={(kind, value) => agents.configure(session.termId, kind, value)}
        />
      </div>
    </div>
  );
}
