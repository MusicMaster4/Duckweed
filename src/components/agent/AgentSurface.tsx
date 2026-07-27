import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { canResume } from "../../lib/agents/history";
import * as agents from "../../lib/agents/session";
import type { AgentSessionState } from "../../lib/agents/types";
import { confirmCloseRunning } from "../../lib/confirmClose";
import { AgentComposer } from "./AgentComposer";
import { AgentPermission } from "./AgentPermission";
import { AgentSessions } from "./AgentSessions";
import { AgentTimeline } from "./AgentTimeline";
import { shortModelLabel } from "../../lib/agents/types";

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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Open with the text typed after `/resume`, so it doubles as a filter. */
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
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

  const { usage } = session;
  const tokens = usage.inputTokens + usage.outputTokens;
  const ended = session.status === "exited" || session.status === "error";
  const resumable = canResume(session.agent);

  /** End the session only after the user confirms — closing kills the agent. */
  const requestClose = () => {
    if (ended) {
      onClose();
      return;
    }
    void confirmCloseRunning({
      title: "Close agent?",
      message: `${session.label} is still open. Closing ends the session.`,
      confirmLabel: "Yes, close",
      allowDontShowAgain: true,
    }).then((ok) => {
      if (ok) onClose();
    });
  };

  /**
   * `/resume` is answered by the app, not the agent: no CLI advertises its
   * own history over the protocols we speak, so the text never leaves here.
   */
  const submit = (text: string) => {
    const match = /^\/resume(?:\s+(.*))?$/i.exec(text.trim());
    if (match) {
      setResumeQuery(match[1]?.trim() ?? "");
      return;
    }
    pinnedRef.current = true;
    agents.submit(termId, text);
  };

  /**
   * Clicking anywhere quiet in the transcript hands the keyboard back to the
   * composer, the way a chat pane does. A drag that selected text is exempt —
   * that click was for the selection, and stealing focus would clear it.
   * Mouseup (not mousedown) so a selection drag still has a chance to exist
   * before we decide whether to steal the keyboard.
   */
  const focusComposer = (event: React.MouseEvent) => {
    if (ended || session.permission || resumeQuery !== null) return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea, pre, code")) return;
    if (window.getSelection()?.toString()) return;
    composerRef.current?.focus();
  };

  return (
    <div
      className={`agent-surface is-${session.status}`}
      style={{ ["--agent-accent" as string]: session.accent }}
      data-agent={session.agent}
      data-program={session.program}
      onMouseUp={focusComposer}
    >
      <header className="agent-head">
        <span className="agent-badge" aria-hidden="true">
          {session.mark}
        </span>
        <span className="agent-name">{session.label}</span>
        {/* Read-only identity in the head — interactive pickers live in the
            composer footer (T3 Code layout: model + effort under the input). */}
        {session.model && (
          <span className="agent-model" title={session.model}>
            {shortModelLabel(session.model)}
          </span>
        )}
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
        {/* Hidden mid-turn: resuming would strand the work in flight, and an
            action that is refused every time is worse than one that waits. */}
        {resumable && !ended && session.status !== "working" && (
          <button
            type="button"
            className="agent-head-btn is-quiet"
            onClick={() => setResumeQuery("")}
            title={`Resume a past ${session.label} session (/resume)`}
            aria-label="Resume a past session"
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 7a5 5 0 1 0 1.6-3.7" fill="none" />
              <path d="M2 1.8V4.4H4.6" fill="none" />
              <path d="M7 4.4V7l1.9 1.1" fill="none" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="agent-head-btn"
          onClick={requestClose}
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
              {session.mark}
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
        active={active && !session.permission && resumeQuery === null}
        inputRef={composerRef}
        onSubmit={submit}
        onInterrupt={() => agents.interrupt(termId)}
      />

      {resumeQuery !== null && (
        <AgentSessions
          agent={session.agent}
          cwd={session.cwd}
          label={session.label}
          mark={session.mark}
          initialQuery={resumeQuery}
          onClose={() => setResumeQuery(null)}
          onPick={(chosen) => {
            setResumeQuery(null);
            pinnedRef.current = true;
            void agents.resume(termId, chosen.id, chosen.title).then((failure) => {
              // Only the relaunching agents can fail this way, and a failed
              // relaunch leaves no session to render the reason in. Handing
              // the pane back to its shell beats leaving it blank.
              if (failure) onClose();
            });
          }}
        />
      )}
    </div>
  );
}
