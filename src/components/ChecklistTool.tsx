import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Tooltip } from "./Tooltip";
import * as checklist from "../lib/checklist";
import { CONFETTI_DURATION_MS } from "../lib/checklistConfetti";
import { AsciiAmbient } from "./AsciiAmbient";

interface Props {
  /** Tab whose list this is. Null before any tab exists. */
  scope: string | null;
  /** Tab title, so the panel says whose list is on screen. */
  scopeLabel: string;
}

const Check = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="check-mark">
    <path d="M3.5 8.4l3 3 6-6.6" />
  </svg>
);

const Plus = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

/**
 * A checklist for the visible tab.
 *
 * Deliberately manual: nothing here is inferred from what the agents did. The
 * value of a list you wrote yourself is that it says what *you* meant to do, and
 * a list that fills itself stops being read.
 *
 * Checked items are not deleted on the spot. They drop into a "done" group for a
 * day, each one saying how long it has left, then sweep themselves. See
 * {@link checklist} for why.
 */
/** How long the full-area confetti overlay stays mounted. */
const CELEBRATE_MS = CONFETTI_DURATION_MS;

export function ChecklistTool({ scope, scopeLabel }: Props) {
  const read = useCallback(() => (scope ? checklist.items(scope) : null), [scope]);
  const store = useSyncExternalStore(checklist.subscribe, read, read);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** Non-null while confetti should paint; bumps each win for a fresh clock. */
  const [celebrateGen, setCelebrateGen] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef<number | null>(null);
  const celebrateGenerationRef = useRef(0);
  const celebrateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useNow(store !== null && store.length > 0);

  // A different tab is a different list; a half-typed item does not follow it.
  useEffect(() => {
    setDraft("");
    setEditing(null);
    setCelebrateGen(null);
    prevOpenRef.current = null;
    if (celebrateTimerRef.current !== null) {
      clearTimeout(celebrateTimerRef.current);
      celebrateTimerRef.current = null;
    }
  }, [scope]);

  useEffect(() => {
    return () => {
      if (celebrateTimerRef.current !== null) clearTimeout(celebrateTimerRef.current);
    };
  }, []);

  const openCount = store ? store.filter((item) => item.doneAt === null).length : 0;
  const totalCount = store?.length ?? 0;

  // Edge only: prev open > 0 and now open === 0 with items present. Seed on
  // mount/scope change without firing so an already-clear list stays quiet.
  useEffect(() => {
    if (!scope || store === null) {
      prevOpenRef.current = null;
      return;
    }
    const prev = prevOpenRef.current;
    if (prev !== null && checklist.becameAllClear(prev, openCount, totalCount)) {
      celebrateGenerationRef.current += 1;
      setCelebrateGen(celebrateGenerationRef.current);
      if (celebrateTimerRef.current !== null) clearTimeout(celebrateTimerRef.current);
      celebrateTimerRef.current = setTimeout(() => {
        setCelebrateGen(null);
        celebrateTimerRef.current = null;
      }, CELEBRATE_MS);
    }
    prevOpenRef.current = openCount;
  }, [scope, store, openCount, totalCount]);

  const submit = useCallback(() => {
    if (!scope) return;
    checklist.add(scope, draft);
    setDraft("");
    // Adding is usually the first of several, so the caret stays put.
    inputRef.current?.focus();
  }, [draft, scope]);

  const commitEdit = useCallback(() => {
    if (scope && editing) checklist.rename(scope, editing, editDraft);
    setEditing(null);
  }, [editDraft, editing, scope]);

  if (!scope || !store) {
    return (
      <div className="tools-empty tools-empty-ambient">
        <AsciiAmbient surfaceId="checklist-no-tab" scene="pendulum" />
        <p>No tab to keep a list for.</p>
      </div>
    );
  }

  const open = store.filter((item) => item.doneAt === null);
  const done = checklist
    .ordered(store)
    .filter((item) => item.doneAt !== null);
  const total = store.length;
  const progress = total === 0 ? 0 : Math.round((done.length / total) * 100);

  const row = (item: checklist.ChecklistItem) => {
    const isDone = item.doneAt !== null;
    return (
      <div key={item.id} className={`check-row ${isDone ? "is-done" : ""}`}>
        <button
          type="button"
          className="check-box"
          role="checkbox"
          aria-checked={isDone}
          aria-label={isDone ? `Uncheck ${item.text}` : `Check ${item.text}`}
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
            onDoubleClick={() => {
              setEditing(item.id);
              setEditDraft(item.text);
            }}
          >
            {item.text}
          </button>
        )}

        {isDone && (
          <span className="check-expiry" aria-label="Clears from the list in">
            {sweepLabel(checklist.hoursUntilSweep(item, now))}
          </span>
        )}

        <button
          type="button"
          className="check-remove"
          aria-label={`Remove ${item.text}`}
          onClick={() => checklist.remove(scope, item.id)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </div>
    );
  };

  return (
    <div className="check">
      {celebrateGen !== null && (
        <div className="check-celebrate-overlay" aria-hidden="true">
          <AsciiAmbient
            surfaceId={`checklist-confetti-${scope}-${celebrateGen}`}
            scene="confetti"
            className="ascii-ambient-checklist-confetti"
            fps={18}
          />
        </div>
      )}

      <header className="check-head">
        <div className="check-head-top">
          <span className="tools-section-title">Checklist</span>
          <Tooltip
            title="This list belongs to one tab"
            detail={`Everything here is filed under "${scopeLabel}". Other tabs keep their own lists, and all of them survive restarts and updates.`}
          >
            <span className="check-scope">{scopeLabel}</span>
          </Tooltip>
        </div>

        {total > 0 && (
          <div className="check-progress">
            <div
              className="check-progress-track"
              role="progressbar"
              aria-valuenow={done.length}
              aria-valuemax={total}
              aria-label="Items checked off"
            >
              <div className="check-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="check-progress-count">
              {done.length}/{total}
            </span>
          </div>
        )}
      </header>

      <div className="check-add">
        <span className="check-add-icon" aria-hidden="true">
          <Plus />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          placeholder="Add an item"
          spellCheck={false}
          maxLength={500}
          aria-label="New checklist item"
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
        {draft.trim() && <kbd className="check-add-key">enter</kbd>}
      </div>

      <div className="check-list">
        {total === 0 ? (
          <div className="check-blank">
            <AsciiAmbient surfaceId={`checklist-blank-${scope}`} scene="pendulum" />
            <p className="check-blank-title">Nothing on the list</p>
            <p className="check-blank-body">
              Write down what this tab is for. Items you check off stay for a day, then clear
              themselves.
            </p>
          </div>
        ) : (
          <>
            {open.map(row)}

            {open.length === 0 && (
              <p className="check-cleared">All clear. Nothing left on this tab.</p>
            )}

            {done.length > 0 && (
              <>
                <div className="check-divider">
                  <span className="check-divider-label">Done ({done.length})</span>
                  <span className="check-divider-rule" />
                  <Tooltip
                    title="Clear them now"
                    detail="Finished items normally sit here for a day so you can see what you got through, or put one back. This removes them straight away."
                  >
                    <button
                      type="button"
                      className="check-divider-btn"
                      onClick={() => checklist.clearDone(scope)}
                    >
                      clear
                    </button>
                  </Tooltip>
                </div>
                {done.map(row)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * How long a checked item has before it sweeps itself.
 *
 * Short, because it sits on every finished row. The empty state and the tab
 * tooltip both spell out what the number means; here it only has to be visible.
 */
function sweepLabel(hours: number): string {
  return hours <= 0 ? "<1h" : `${hours}h`;
}

/**
 * A clock that only ticks while there is a list to date-stamp, and only once a
 * minute, since the sweep countdown is shown in whole hours.
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
