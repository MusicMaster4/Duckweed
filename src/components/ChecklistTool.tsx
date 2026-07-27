import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import * as checklist from "../lib/checklist";

interface Props {
  /** Tab whose list this is. Null before any tab exists. */
  scope: string | null;
  /** Tab title, so the panel says whose list is on screen. */
  scopeLabel: string;
}

/** The tick is the control; the box around it is just its resting state. */
const Check = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="check-mark">
    <path d="M3.5 8.5l3 3 6-6.5" />
  </svg>
);

/**
 * A checklist for the visible tab.
 *
 * Deliberately manual: nothing here is inferred from what the agents did. The
 * value of a list you wrote yourself is that it says what *you* meant to do, and
 * a list that fills itself stops being read.
 *
 * Checked items stay for a day, struck through and dated, then sweep themselves.
 * See {@link checklist} for why.
 */
export function ChecklistTool({ scope, scopeLabel }: Props) {
  const read = useCallback(() => (scope ? checklist.items(scope) : null), [scope]);
  const store = useSyncExternalStore(checklist.subscribe, read, read);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNow(store !== null && store.length > 0);

  // A different tab is a different list; a half-typed item does not follow it.
  useEffect(() => {
    setDraft("");
    setEditing(null);
  }, [scope]);

  const submit = useCallback(() => {
    if (!scope) return;
    checklist.add(scope, draft);
    setDraft("");
    // Adding is usually the first of several; keep the caret where it was.
    inputRef.current?.focus();
  }, [draft, scope]);

  const commitEdit = useCallback(() => {
    if (scope && editing) checklist.rename(scope, editing, editDraft);
    setEditing(null);
  }, [editDraft, editing, scope]);

  if (!scope || !store) {
    return (
      <div className="tools-empty">
        <p>No tab to keep a list for.</p>
      </div>
    );
  }

  const rows = checklist.ordered(store);
  const done = rows.filter((item) => item.doneAt !== null).length;
  const open = rows.length - done;

  return (
    <>
      <div className="tools-section-head">
        <span className="tools-section-title">Checklist</span>
        <span className="tools-section-note" title={`This list belongs to the tab "${scopeLabel}"`}>
          {scopeLabel}
        </span>
        <span className="tools-spacer" />
        {done > 0 && (
          <button
            type="button"
            className="tools-btn"
            title="Remove the finished items now instead of waiting out the day"
            onClick={() => checklist.clearDone(scope)}
          >
            clear done
          </button>
        )}
      </div>

      <div className="check-add">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          placeholder="Add an item…"
          spellCheck={false}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft("");
            }
            // Terminal shortcuts live on window; typing here is not for them.
            e.stopPropagation();
          }}
        />
        <button type="button" className="tools-btn" disabled={!draft.trim()} onClick={submit}>
          add
        </button>
      </div>

      <div className="check-list">
        {rows.length === 0 ? (
          <p className="check-blank">
            Nothing yet. Anything you check off stays for a day, then clears itself.
          </p>
        ) : (
          rows.map((item) => {
            const isDone = item.doneAt !== null;
            const hours = checklist.hoursUntilSweep(item, now);
            return (
              <div key={item.id} className={`check-row ${isDone ? "is-done" : ""}`}>
                <button
                  type="button"
                  className="check-box"
                  role="checkbox"
                  aria-checked={isDone}
                  aria-label={isDone ? `Uncheck ${item.text}` : `Check ${item.text}`}
                  title={isDone ? "Put it back on the list" : "Check it off"}
                  onClick={() => checklist.toggle(scope, item.id)}
                >
                  {isDone && <Check />}
                </button>

                {editing === item.id ? (
                  <input
                    className="check-edit"
                    type="text"
                    autoFocus
                    value={editDraft}
                    spellCheck={false}
                    maxLength={500}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditing(null);
                      }
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="check-text"
                    title={
                      isDone
                        ? `Clears in about ${hours}h · double-click to edit`
                        : "Double-click to edit"
                    }
                    onDoubleClick={() => {
                      setEditing(item.id);
                      setEditDraft(item.text);
                    }}
                  >
                    {item.text}
                  </button>
                )}

                <button
                  type="button"
                  className="check-remove"
                  title="Remove this item"
                  aria-label={`Remove ${item.text}`}
                  onClick={() => checklist.remove(scope, item.id)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>

      {rows.length > 0 && (
        <footer className="check-foot">
          {open} open{done > 0 ? ` · ${done} done` : ""}
        </footer>
      )}
    </>
  );
}

/**
 * A clock that only ticks while there is a list to date-stamp, and only once a
 * minute — the sweep countdown is shown in whole hours.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
