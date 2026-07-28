import { useEffect, useMemo, useRef, useState } from "react";

import { AGENTS } from "../../lib/agents/catalog";
import * as history from "../../lib/agents/history";
import type { AgentSessionSummary } from "../../lib/agents/history";
import type { AgentId } from "../../lib/agents/types";
import { AgentProviderIcon } from "./AgentProviderIcon";

interface Props {
  agent: AgentId;
  /** Folder whose sessions are listed — one project, not the whole machine. */
  cwd: string;
  /**
   * Branding for the picker chrome. Defaults to the catalog agent; wrappers
   * like Claudex pass their own label so the dialog does not say Claude Code.
   */
  label?: string;
  /** Text typed after `/resume`, used as the opening filter. */
  initialQuery?: string;
  onPick: (session: AgentSessionSummary) => void;
  onClose: () => void;
}

/**
 * Pick a past conversation to continue.
 *
 * The list comes from the agent's own session store, which is what makes this
 * honest: these are the same conversations `claude --resume` or `codex resume`
 * would offer, scoped to the folder this pane is in. One picker serves every
 * agent — the rows differ only in what each CLI bothered to record — so a pane
 * running Grok lists Grok sessions and nothing else.
 */
export function AgentSessions({
  agent,
  cwd,
  label,
  initialQuery = "",
  onPick,
  onClose,
}: Props) {
  const [sessions, setSessions] = useState<AgentSessionSummary[] | null>(() =>
    history.cached(agent, cwd),
  );
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [highlighted, setHighlighted] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const definition = AGENTS[agent];
  const displayLabel = label ?? definition.label;

  useEffect(() => {
    let live = true;
    history
      .list(agent, cwd)
      .then((found) => {
        if (!live) return;
        setSessions(found);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setSessions([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [agent, cwd]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const rows = useMemo(() => {
    if (!sessions) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.id.toLowerCase().includes(needle),
    );
  }, [sessions, query]);

  useEffect(() => {
    setHighlighted(0);
  }, [query, sessions]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>("[data-highlighted='true']");
    node?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = rows[highlighted];
      if (chosen) onPick(chosen);
    }
  };

  const loading = sessions === null;

  return (
    <div className="agent-sessions-backdrop" onPointerDown={onClose}>
      <div
        className="agent-sessions"
        role="dialog"
        aria-label={`Resume a ${displayLabel} session`}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="agent-sessions-head">
          <span className="agent-sessions-mark" aria-hidden="true">
            <AgentProviderIcon
              agent={agent}
              program={displayLabel === "Claudex" ? "claudex" : definition.binaries[0]}
            />
          </span>
          <div className="agent-sessions-title">
            <strong>Resume a session</strong>
            <span title={cwd}>
              {displayLabel} · {folderName(cwd)}
            </span>
          </div>
          <button
            type="button"
            className="agent-head-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <line x1="3.5" y1="3.5" x2="10.5" y2="10.5" />
              <line x1="10.5" y1="3.5" x2="3.5" y2="10.5" />
            </svg>
          </button>
        </header>

        <div className="agent-sessions-search">
          <input
            ref={searchRef}
            type="text"
            value={query}
            spellCheck={false}
            placeholder="Search past sessions…"
            aria-label="Search past sessions"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="agent-sessions-list" ref={listRef} role="listbox" aria-label="Past sessions">
          {loading && <div className="agent-sessions-empty">Reading past sessions…</div>}
          {!loading && rows.length === 0 && (
            <div className="agent-sessions-empty">
              {error
                ? `Could not read ${definition.label}'s session history: ${error}`
                : !history.canResume(agent)
                  ? `${definition.label} does not expose its past sessions, so there is nothing to resume.`
                  : query.trim()
                    ? "No session matches that."
                    : `No ${definition.label} sessions recorded in this folder yet.`}
            </div>
          )}
          {rows.map((session, index) => (
            <button
              key={session.id}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              data-highlighted={index === highlighted}
              className={index === highlighted ? "is-active" : ""}
              title={session.title}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => onPick(session)}
            >
              <span className="agent-session-title">{session.title || session.id}</span>
              <span className="agent-session-meta">
                <span>{history.timeAgo(session.updatedAt)}</span>
                {session.messageCount > 0 && <span>{session.messageCount} messages</span>}
                {session.model && <span>{session.model}</span>}
              </span>
            </button>
          ))}
        </div>

        <footer className="agent-sessions-foot">
          <span>↑↓ to choose · Enter to resume · Esc to close</span>
        </footer>
      </div>
    </div>
  );
}

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
