import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import * as terminals from "../lib/terminals";

interface Props {
  termId: string;
  active: boolean;
  exited: boolean;
}

const historyByTerm = new Map<string, string[]>();

/**
 * Warp-style command editor: a real text field for commands, separate from the
 * terminal grid. Enter submits to the PTY; Shift+Enter inserts a newline.
 *
 * It renders only while the pane is in editor mode (or the shell has exited) —
 * a running CLI owns the whole pane, and the composer is unmounted for it.
 */
export function CommandInput({ termId, active, exited }: Props) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(160, Math.max(22, el.scrollHeight))}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  // Font size is applied via CSS variables from terminals.setFontSize; remeasure
  // the textarea so a larger/smaller face does not leave a stale height.
  useEffect(() => {
    return terminals.subscribe(() => resize());
  }, [resize]);

  useEffect(() => {
    return terminals.registerInputFocus(termId, () => {
      if (exited) {
        terminals.focusTerminal(termId);
        return;
      }
      textareaRef.current?.focus();
    });
  }, [termId, exited]);

  useEffect(() => {
    return terminals.registerInputPaste(termId, (text) => {
      if (exited) return;
      const el = textareaRef.current;
      const current = valueRef.current;
      if (!el) {
        setValue(current + text);
        return;
      }
      const start = el.selectionStart ?? current.length;
      const end = el.selectionEnd ?? current.length;
      const next = current.slice(0, start) + text + current.slice(end);
      setValue(next);
      setHistoryIndex(null);
      requestAnimationFrame(() => {
        const pos = start + text.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    });
  }, [termId, exited]);

  // When this pane becomes active and we are in editor mode, own the keyboard.
  useEffect(() => {
    if (!active || exited) return;
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [active, exited, termId]);

  const pushHistory = (command: string) => {
    const trimmed = command.trimEnd();
    if (!trimmed) return;
    const prev = historyByTerm.get(termId) ?? [];
    if (prev[prev.length - 1] === trimmed) return;
    historyByTerm.set(termId, [...prev, trimmed].slice(-200));
  };

  const submit = () => {
    if (exited) return;
    const command = value;
    pushHistory(command);
    setValue("");
    setHistoryIndex(null);
    draftRef.current = "";
    terminals.submitCommand(termId, command);
    // Keep focus in the editor so the next command is ready (Warp behavior).
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep app-level shortcuts (Ctrl+Shift+…) working from the capture phase
    // in App.tsx; stop only the keys we fully handle so they do not reach xterm.
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
      return;
    }

    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const el = textareaRef.current;
      // Only walk history from the first line / empty buffer (Warp-like).
      if (el && (el.selectionStart !== 0 || el.selectionEnd !== 0) && value.includes("\n")) {
        return;
      }
      const history = historyByTerm.get(termId) ?? [];
      if (history.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (historyIndex === null) draftRef.current = value;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setValue(history[next] ?? "");
      return;
    }

    if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (historyIndex === null) return;
      const history = historyByTerm.get(termId) ?? [];
      e.preventDefault();
      e.stopPropagation();
      if (historyIndex >= history.length - 1) {
        setHistoryIndex(null);
        setValue(draftRef.current);
        return;
      }
      const next = historyIndex + 1;
      setHistoryIndex(next);
      setValue(history[next] ?? "");
      return;
    }

    // Ctrl+C — if the grid has a selection, copy it (select-then-copy). Else
    // clear the editor buffer (Warp). Empty buffer only interrupts when a
    // command is running; idle Ctrl+C would otherwise spam `^C` prompts.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      e.stopPropagation();
      const selected = terminals.selection(termId);
      if (selected) {
        void navigator.clipboard.writeText(selected);
        return;
      }
      if (value.length > 0) {
        setValue("");
        setHistoryIndex(null);
        draftRef.current = "";
      } else {
        void terminals.interrupt(termId);
      }
      return;
    }

    // Ctrl+L — clear scrollback (also common in shells).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      e.stopPropagation();
      terminals.clear(termId);
      return;
    }

    // Ctrl+D on empty — EOF / logout signal.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
      if (value.length === 0) {
        e.preventDefault();
        e.stopPropagation();
        terminals.writeRaw(termId, "\x04");
      }
      return;
    }

    // Escape discards the draft and nothing more. It used to switch the pane to
    // raw input, which meant an idle Escape silently moved the keyboard
    // somewhere else; raw input is a setting now.
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && value.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setValue("");
      setHistoryIndex(null);
      draftRef.current = "";
    }
  };

  return (
    <div
      className={[
        "command-input",
        focused && !exited ? "is-focused" : "",
        exited ? "is-disabled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <textarea
        ref={textareaRef}
        className="command-input-field"
        value={value}
        disabled={exited}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        placeholder={exited ? "Session ended" : "Run a command"}
        onChange={(e) => {
          setValue(e.target.value);
          setHistoryIndex(null);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />

      <div className="command-input-hint">
        {exited ? (
          "This shell has exited"
        ) : (
          <>
            <kbd>Enter</kbd> run
            <span className="hint-sep" />
            <kbd>Shift</kbd>
            <kbd>Enter</kbd> newline
            <span className="hint-sep" />
            <kbd>↑</kbd> history
          </>
        )}
      </div>
    </div>
  );
}
