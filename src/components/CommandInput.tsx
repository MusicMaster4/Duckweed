import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  acceptFull,
  acceptPartialComponent,
  ghostSuffix,
  suggest,
} from "../lib/autosuggest";
import * as commandHistory from "../lib/commandHistory";
import { highlightCommand } from "../lib/commandSyntax";
import { cKeyAction, isControlChord } from "../lib/platform";
import * as suggestFeedback from "../lib/suggestFeedback";
import * as terminals from "../lib/terminals";

interface Props {
  termId: string;
  active: boolean;
  exited: boolean;
  highlight: boolean;
}

/**
 * Warp-style command editor: a real text field for commands, separate from the
 * terminal grid. Enter submits to the PTY; Shift+Enter inserts a newline.
 *
 * Ghost-text autosuggestions rank shared history (prefix, cwd, recency).
 * ↑/↓ walk this pane's own submitted commands; Ctrl+Up selects blocks.
 *
 * It renders only while the pane is in editor mode (or the shell has exited) —
 * a running CLI owns the whole pane, and the composer is unmounted for it.
 */
export function CommandInput({ termId, active, exited, highlight }: Props) {
  // Seed from the session so a pane remount (first split, drag) keeps the
  // unsent command instead of blanking the composer and stranding it on the
  // old terminal only in the user's head.
  const [value, setValueState] = useState(() => terminals.getDraft(termId));
  const [focused, setFocused] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  /** Bump when shared history may have changed (other panes submit). */
  const [historyEpoch, setHistoryEpoch] = useState(0);
  /** Bump when a suggestion is demoted/unlearned (here or in another pane). */
  const [feedbackEpoch, setFeedbackEpoch] = useState(0);
  const [terminalEpoch, setTerminalEpoch] = useState(0);
  const draftRef = useRef("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Ghosts shown during this draft. Accept (Tab / → / Ctrl+F / Ctrl+→) marks
   * interest; anything still unaccepted when the draft ends is a reject —
   * typing past the ghost without accepting means the suggestion was unused.
   */
  const offeredRef = useRef<Set<string>>(new Set());
  const acceptedRef = useRef<Set<string>>(new Set());

  const setValue = useCallback(
    (next: string | ((prev: string) => string)) => {
      setValueState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        terminals.setDraft(termId, resolved);
        return resolved;
      });
    },
    [termId],
  );

  const clearOfferTracking = useCallback(() => {
    offeredRef.current = new Set();
    acceptedRef.current = new Set();
  }, []);

  /** Reject every ghost shown this draft that the user never accepted. */
  const flushUnusedOffers = useCallback(() => {
    for (const command of offeredRef.current) {
      if (!acceptedRef.current.has(command)) {
        suggestFeedback.recordReject(command);
      }
    }
    clearOfferTracking();
  }, [clearOfferTracking]);

  const noteAccept = useCallback((command: string) => {
    offeredRef.current.add(command);
    acceptedRef.current.add(command);
    suggestFeedback.recordAccept(command);
  }, []);

  // Leaf term swaps (drag-swap) reuse this component instance — reseed the
  // buffer from the new session instead of carrying the previous pane's draft.
  useEffect(() => {
    setValueState(terminals.getDraft(termId));
    setHistoryIndex(null);
    draftRef.current = "";
    clearOfferTracking();
  }, [termId, clearOfferTracking]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (el.clientWidth <= 0) return;
    if (valueRef.current.length === 0) {
      el.style.height = "22px";
      return;
    }
    el.style.height = "0px";
    el.style.height = `${Math.min(160, Math.max(22, el.scrollHeight))}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  // A split is born at zero width and grows through the live layout animation.
  // Measuring only on mount makes the one-line placeholder wrap into a 160px
  // textarea and leaves that stale height behind. Re-measure whenever the
  // editor's width changes so the composer follows the real pane geometry.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width * 10) / 10;
      if (width === previousWidth) return;
      previousWidth = width;
      resize();
    });
    observer.observe(editor);
    return () => observer.disconnect();
  }, [resize]);

  // Font size is applied via CSS variables from terminals.setFontSize; remeasure
  // the textarea so a larger/smaller face does not leave a stale height.
  useEffect(() => {
    return terminals.subscribeSettings(() => {
      resize();
    });
  }, [resize]);

  useEffect(() => {
    return terminals.subscribeSession(termId, () => setTerminalEpoch((n) => n + 1));
  }, [termId]);

  useEffect(() => {
    return commandHistory.subscribe(() => setHistoryEpoch((n) => n + 1));
  }, []);

  useEffect(() => {
    return suggestFeedback.subscribe(() => setFeedbackEpoch((n) => n + 1));
  }, []);

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

  void terminalEpoch;
  const cwd = terminals.getMeta(termId)?.cwd ?? null;

  const suggestion = useMemo(() => {
    void historyEpoch;
    void feedbackEpoch;
    if (exited || historyIndex !== null) return null;
    return suggest(value, commandHistory.list(), { cwd });
  }, [value, cwd, exited, historyIndex, historyEpoch, feedbackEpoch]);

  const ghost = ghostSuffix(value, suggestion);
  const highlighted = useMemo(
    () => (highlight ? highlightCommand(value) : [{ text: value, kind: "plain" as const }]),
    [value, highlight],
  );

  // Remember every ghost that appeared; unused ones are rejected when the draft ends.
  useEffect(() => {
    if (!suggestion || !ghost) return;
    offeredRef.current.add(suggestion);
  }, [suggestion, ghost]);

  const cursorAtEnd = (): boolean => {
    const el = textareaRef.current;
    if (!el) return true;
    const end = valueRef.current.length;
    return el.selectionStart === end && el.selectionEnd === end;
  };

  const applyValue = (next: string, cursor?: number) => {
    setValue(next);
    setHistoryIndex(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = cursor ?? next.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const submit = () => {
    if (exited) return;
    const command = value;
    // Any ghost shown this draft and not accepted (Tab/→) is unused.
    // recordUsed may clear the streak if they still ran that same command.
    flushUnusedOffers();
    suggestFeedback.recordUsed(command);
    setValue("");
    setHistoryIndex(null);
    draftRef.current = "";
    // History is recorded inside submitCommand (shared + per-pane).
    terminals.submitCommand(termId, command);
    // Keep focus in the editor so the next command is ready (Warp behavior).
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep app-level shortcuts (Ctrl+Shift+…) working from the capture phase
    // in App.tsx; stop only the keys we fully handle so they do not reach xterm.

    // --- Block navigation (Warp-style) ------------------------------------
    // Ctrl+Up: select most recent block. While a block is selected, plain
    // Up/Down move selection; Escape clears it back to the editor.
    if (e.key === "ArrowUp" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      terminals.selectLastBlock(termId);
      return;
    }

    if (terminals.hasBlockNavSelection(termId)) {
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        terminals.rerunSelectedBlock(termId);
        return;
      }
      if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        terminals.selectPrevBlock(termId);
        return;
      }
      if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        terminals.selectNextBlock(termId);
        return;
      }
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        terminals.clearBlockSelection(termId);
        textareaRef.current?.focus();
        return;
      }
    }

    // --- Autosuggest accept (Warp keys) -----------------------------------
    // Full: Tab, Right (cursor at end), or Ctrl+F.
    // Partial: Ctrl+Right (Windows: Ctrl+Shift+Right also accepted).
    if (suggestion && ghost && cursorAtEnd()) {
      const fullAcceptTab =
        e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      const fullAcceptRight =
        e.key === "ArrowRight" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      const fullAcceptCtrlF =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
      if (fullAcceptTab || fullAcceptRight || fullAcceptCtrlF) {
        e.preventDefault();
        e.stopPropagation();
        noteAccept(suggestion);
        applyValue(acceptFull(value, suggestion));
        return;
      }

      const partial =
        e.key === "ArrowRight" &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        // Warp Windows uses Ctrl+Shift+Right; Ctrl+Right alone is fine too.
        true;
      if (partial) {
        e.preventDefault();
        e.stopPropagation();
        // Partial accept is still interest — clear any reject streak.
        noteAccept(suggestion);
        const next = acceptPartialComponent(value, suggestion);
        applyValue(next);
        return;
      }
    }

    // Without a ghost suggestion, keep Tab from leaving the composer (no focus trap).
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      terminals.clearBlockSelection(termId);
      submit();
      return;
    }

    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const el = textareaRef.current;
      // Only walk history from the first line / empty buffer (Warp-like).
      if (el && (el.selectionStart !== 0 || el.selectionEnd !== 0) && value.includes("\n")) {
        return;
      }
      // Per-pane history — not the shared autosuggest list.
      const hist = terminals.localHistory(termId);
      if (hist.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (historyIndex === null) draftRef.current = value;
      const next = historyIndex === null ? hist.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setValue(hist[next] ?? "");
      return;
    }

    if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (historyIndex === null) return;
      const hist = terminals.localHistory(termId);
      e.preventDefault();
      e.stopPropagation();
      if (historyIndex >= hist.length - 1) {
        setHistoryIndex(null);
        setValue(draftRef.current);
        return;
      }
      const next = historyIndex + 1;
      setHistoryIndex(next);
      setValue(hist[next] ?? "");
      return;
    }

    // C + modifier: Cmd+C copies on macOS; Ctrl+C clears/interrupts. On
    // Windows/Linux the same Ctrl+C does both (copy when there is a selection).
    if (e.key.toLowerCase() === "c") {
      const el = textareaRef.current;
      const fieldSelection =
        el !== null && el.selectionStart !== el.selectionEnd
          ? el.value.slice(el.selectionStart, el.selectionEnd)
          : "";
      const gridSelection = terminals.selection(termId);
      const copyText = fieldSelection || gridSelection;
      const action = cKeyAction(e, Boolean(copyText && /\S/.test(copyText)));
      if (action === "copy") {
        // Field selection: leave the event alone so the browser copies it.
        if (fieldSelection) return;
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(copyText);
        return;
      }
      if (action === "control") {
        // Always clear/interrupt on the control path. Field selection is only
        // preserved in the "copy" branch above (Win/Linux Ctrl+C with text, or
        // macOS Cmd+C). On Apple, Ctrl+C is never copy, so a selected draft
        // must still clear rather than falling through to the browser.
        e.preventDefault();
        e.stopPropagation();
        if (value.length > 0) {
          flushUnusedOffers();
          setValue("");
          setHistoryIndex(null);
          draftRef.current = "";
        } else {
          void terminals.interrupt(termId);
        }
        return;
      }
    }

    // Ctrl+L — clear scrollback (also common in shells).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      e.stopPropagation();
      terminals.clear(termId);
      return;
    }

    // Ctrl+D on empty — EOF / logout signal. Physical Control only so Cmd+D
    // on macOS is not treated as end-of-file.
    if (isControlChord(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
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
      // Discarding the draft without accepting a ghost rejects every unused offer.
      flushUnusedOffers();
      setValue("");
      setHistoryIndex(null);
      draftRef.current = "";
    }
  };

  const showGhost = Boolean(ghost) && !exited && historyIndex === null;
  const showMirror = showGhost || (highlight && Boolean(value));
  // The textarea keeps native editing, selection, accessibility, and its caret;
  // its mirror owns only the visible glyphs (syntax colours + muted ghost).
  const fieldClass = [
    "command-input-field",
    showMirror ? "has-painted-text" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={[
        "command-input",
        focused && !exited ? "is-focused" : "",
        exited ? "is-disabled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={() => {
        // Clicking into the composer means "I am done with that block" — drop
        // the selection chrome instead of leaving a chunk highlighted behind
        // the cursor until the next keystroke.
        terminals.dismissBlockSelection(termId);
      }}
    >
      <div ref={editorRef} className="command-input-editor">
        {showMirror && (
          <div className="command-input-mirror" aria-hidden="true">
            {highlighted.map((token, index) => (
              <span key={index} className={`command-token token-${token.kind}`}>
                {token.text}
              </span>
            ))}
            {showGhost && <span className="command-input-ghost">{ghost}</span>}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={fieldClass}
          value={value}
          disabled={exited}
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          placeholder={exited ? "Session ended" : "Run a command"}
          onChange={(e) => {
            terminals.clearBlockSelection(termId);
            setValue(e.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onScroll={(e) => {
            // Keep ghost mirror scrolled in sync with the textarea.
            const mirror = e.currentTarget.previousElementSibling;
            if (mirror instanceof HTMLElement && mirror.classList.contains("command-input-mirror")) {
              mirror.scrollTop = e.currentTarget.scrollTop;
              mirror.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        />
      </div>

      <div className="command-input-hint">
        {exited ? (
          "This shell has exited"
        ) : showGhost ? (
          <>
            <kbd>Tab</kbd> accept
            <span className="hint-sep" />
            <kbd>→</kbd> accept
            <span className="hint-sep" />
            <kbd>Ctrl</kbd>
            <kbd>→</kbd> word
            <span className="hint-sep" />
            <kbd>Ctrl</kbd>
            <kbd>↑</kbd> blocks
          </>
        ) : (
          <>
            <kbd>Enter</kbd> run
            <span className="hint-sep" />
            <kbd>Shift</kbd>
            <kbd>Enter</kbd> newline
            <span className="hint-sep" />
            <kbd>↑</kbd> history
            <span className="hint-sep" />
            <kbd>Ctrl</kbd>
            <kbd>↑</kbd> blocks
          </>
        )}
      </div>
    </div>
  );
}
