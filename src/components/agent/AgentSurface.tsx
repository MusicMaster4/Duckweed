import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { AGENTS } from "../../lib/agents/catalog";
import * as agents from "../../lib/agents/session";
import type { AgentSessionState } from "../../lib/agents/types";
import { AgentComposer } from "./AgentComposer";
import { AgentPermission } from "./AgentPermission";
import { AgentTimeline } from "./AgentTimeline";

interface Props {
  termId: string;
  /** The pane holding this surface has the keyboard. */
  active: boolean;
  /** Close the agent and hand the pane back to its shell. */
  onClose: () => void;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

const STATUS_LABEL: Record<AgentSessionState["status"], string> = {
  starting: "starting",
  idle: "ready",
  working: "working",
  waiting: "needs you",
  exited: "ended",
  error: "failed",
};

/**
 * The custom agent UI: a layer over the terminal that ran the agent.
 *
 * The terminal underneath is still there, still owns the pane's geometry, and
 * gets it back the moment the session ends. Nothing here writes to the PTY —
 * the agent this renders is a separate headless process speaking a structured
 * protocol, which is the only reason any of this content exists to draw.
 */
export function AgentSurface({ termId, active, onClose }: Props) {
  const session = useSyncExternalStore(
    useCallback((callback) => agents.subscribe(termId, callback), [termId]),
    useCallback(() => agents.get(termId), [termId]),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Following the stream is the default, but scrolling up to read something is
  // a deliberate act — new output must not yank the view back down.
  const pinnedRef = useRef(true);
  const itemCount = session?.items.length ?? 0;
  const lastItem = session?.items[itemCount - 1];
  const tail =
    lastItem && (lastItem.kind === "assistant" || lastItem.kind === "thinking")
      ? lastItem.text.length
      : 0;

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [itemCount, tail, session?.permission?.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      pinnedRef.current = distance < 40;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  if (!session) return null;

  const definition = AGENTS[session.agent];
  const { usage } = session;
  const tokens = usage.inputTokens + usage.outputTokens;

  return (
    <div
      className={`agent-surface is-${session.status}`}
      style={{ ["--agent-accent" as string]: definition.accent }}
      data-agent={session.agent}
    >
      <header className="agent-head">
        <span className="agent-badge" aria-hidden="true">
          {definition.mark}
        </span>
        <span className="agent-name">{session.label}</span>
        {session.model && <span className="agent-model">{session.model}</span>}
        {session.effort && (
          <span className="agent-effort" title="Reasoning effort">
            {session.effort}
          </span>
        )}
        <span className={`agent-state is-${session.status}`}>
          {session.status === "working" && <span className="agent-pulse" aria-hidden="true" />}
          {STATUS_LABEL[session.status]}
        </span>
        <span className="agent-head-spacer" />
        {tokens > 0 && (
          <span className="agent-usage" title="Tokens used this session">
            {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
            {usage.costUsd !== null && ` · $${usage.costUsd.toFixed(2)}`}
          </span>
        )}
        {usage.contextUsed !== null && (
          <span className="agent-context" title="Context window used">
            <span
              className="agent-context-fill"
              style={{ width: `${Math.round(usage.contextUsed * 100)}%` }}
            />
          </span>
        )}
        <button
          type="button"
          className="agent-head-btn"
          onClick={onClose}
          title="Close the agent and return to the shell"
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <line x1="3.5" y1="3.5" x2="10.5" y2="10.5" />
            <line x1="10.5" y1="3.5" x2="3.5" y2="10.5" />
          </svg>
        </button>
      </header>

      <div className="agent-scroll" ref={scrollRef}>
        {!session.started && session.status !== "error" && (
          <div className={`agent-empty${session.status === "starting" ? " is-starting" : ""}`}>
            <span className="agent-empty-mark" aria-hidden="true">
              {definition.mark}
            </span>
            <strong>{session.label}</strong>
            {session.status === "starting" ? (
              <>
                <span>Starting up…</span>
                <span className="agent-starting-bar" aria-hidden="true">
                  <span />
                </span>
              </>
            ) : (
              <span>Describe what you want changed and it will work in this folder.</span>
            )}
            <code>{session.cwd}</code>
          </div>
        )}

        <AgentTimeline items={session.items} />

        {session.pending.map((text, index) => (
          <div key={index} className="agent-turn is-pending">
            <span className="agent-turn-mark" aria-hidden="true" />
            <p className="agent-turn-text">{text}</p>
            <span className="agent-turn-queued">queued</span>
          </div>
        ))}

        {session.error && (
          <div className="agent-fatal">
            <strong>{session.label} could not start</strong>
            <pre>{session.error}</pre>
            <button type="button" className="agent-fatal-btn" onClick={onClose}>
              Back to the shell
            </button>
          </div>
        )}

        {session.status === "exited" && !session.error && (
          <div className="agent-notice is-info">
            The agent ended. Close this to get the terminal back.
          </div>
        )}

        {session.permission && (
          <AgentPermission
            permission={session.permission}
            onRespond={(optionId) =>
              agents.respond(termId, session.permission?.id ?? "", optionId)
            }
          />
        )}
      </div>

      <AgentComposer
        session={session}
        active={active && !session.permission}
        onSubmit={(text) => {
          pinnedRef.current = true;
          agents.submit(termId, text);
        }}
        onInterrupt={() => agents.interrupt(termId)}
      />
    </div>
  );
}
