import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import * as terminals from "../lib/terminals";

interface Props {
  termId: string;
  cwd: string;
  shellLabel: string;
  active: boolean;
  /** Full-screen / interactive program — hand keys to the raw PTY instead. */
  rawMode: boolean;
  exited: boolean;
  onRawMode: (raw: boolean) => void;
}

const historyByTerm = new Map<string, string[]>();

function basename(path: string): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Warp-style command editor: a real text field for commands, separate from the
 * terminal grid. Enter submits to the PTY; Shift+Enter inserts a newline.
 */
export function CommandInput({
  termId,
  cwd,
  shellLabel,
  active,
  rawMode,
  exited,
  onRawMode,
}: Props) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = exited || rawMode;

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(140, Math.max(22, el.scrollHeight))}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  useEffect(() => {
    return terminals.registerInputFocus(termId, () => {
      if (exited || rawMode) {
        terminals.focusTerminal(termId);
        return;
      }
      textareaRef.current?.focus();
    });
  }, [termId, exited, rawMode]);

  useEffect(() => {
    return terminals.registerInputPaste(termId, (text) => {
      if (exited || rawMode) return;
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
  }, [termId, exited, rawMode]);

  // When this pane becomes active and we are in editor mode, own the keyboard.
  useEffect(() => {
    if (!active || disabled) return;
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [active, disabled, termId]);

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

    // Ctrl+C — clear the editor buffer (Warp). With empty buffer, forward interrupt.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      e.stopPropagation();
      if (value.length > 0) {
        setValue("");
        setHistoryIndex(null);
        draftRef.current = "";
      } else {
        terminals.writeRaw(termId, "\x03");
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

    // Escape — drop into raw terminal mode for interactive programs that do not
    // spawn a child process (in-process REPLs, menus, etc.).
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (value.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setValue("");
        setHistoryIndex(null);
        draftRef.current = "";
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onRawMode(true);
      terminals.focusTerminal(termId);
    }
  };

  const cwdLabel = cwd ? basename(cwd) : "";
  const hint = rawMode
    ? "Raw terminal — click here or press Esc in the grid to return"
    : exited
      ? "Session ended"
      : "Enter to run · Shift+Enter newline · Esc raw mode";

  return (
    <div
      className={[
        "command-input",
        focused && !disabled ? "is-focused" : "",
        disabled ? "is-disabled" : "",
        rawMode ? "is-raw" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onMouseDown={(e) => {
        // Clicking the chrome reclaims editor mode from a raw-grid session.
        if (rawMode && !exited) {
          e.preventDefault();
          onRawMode(false);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
      }}
    >
      <div className="command-input-meta">
        <span className="command-input-shell">{shellLabel || "shell"}</span>
        {cwdLabel && (
          <>
            <span className="command-input-sep" aria-hidden="true">
              ·
            </span>
            <span className="command-input-cwd" title={cwd}>
              {cwdLabel}
            </span>
          </>
        )}
        <span className="command-input-spacer" />
        <span className="command-input-hint">{hint}</span>
      </div>

      <div className={`command-input-box ${focused && !disabled ? "is-focused" : ""}`}>
        <span className="command-input-prompt" aria-hidden="true">
          ❯
        </span>
        <textarea
          ref={textareaRef}
          className="command-input-field"
          value={value}
          disabled={exited}
          readOnly={rawMode}
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          placeholder={rawMode ? "Raw mode — terminal has keyboard focus" : "Enter a command…"}
          onChange={(e) => {
            setValue(e.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            if (rawMode && !exited) onRawMode(false);
          }}
          onBlur={() => setFocused(false)}
        />
      </div>
    </div>
  );
}
