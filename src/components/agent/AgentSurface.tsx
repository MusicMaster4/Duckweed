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
import type { AgentImageAttachment, AgentSessionState } from "../../lib/agents/types";
import {
  isAtScrollBottom,
  shouldShowJumpToBottom,
} from "../../lib/agentScroll";
import {
  COMPLETED_WORKFLOW_TTL_MS,
  latestWorkflow as findLatestWorkflow,
  workflowIsComplete,
} from "../../lib/agentWorkflow";
import { confirmCloseRunning } from "../../lib/confirmClose";
import { AgentComposer } from "./AgentComposer";
import { AgentPermission } from "./AgentPermission";
import { AgentProviderIcon } from "./AgentProviderIcon";
import { AgentSessions } from "./AgentSessions";
import { AgentTimeline } from "./AgentTimeline";
import { PlanTracker, type OfficialVariant } from "./official/OfficialShared";

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

function workflowVariant(agent: AgentSessionState["agent"]): OfficialVariant | "cursor" | "opencode" {
  if (agent === "codex") return "chatgpt";
  return agent;
}

export function latestWorkflow(items: AgentSessionState["items"]) {
  return findLatestWorkflow(items);
}

/** A compact signal for streamed text, tool output, diffs, and plan updates. */
export function agentTimelineRevision(items: AgentSessionState["items"]): number {
  let revision = items.length;
  for (const item of items) {
    revision += item.id.length + item.kind.length;
    if (item.kind === "tool") {
      revision +=
        item.title.length +
        item.output.length +
        (item.command?.length ?? 0) +
        item.status.length +
        item.changes.reduce(
          (sum, change) =>
            sum +
            change.path.length +
            (change.before?.length ?? 0) +
            (change.after?.length ?? 0) +
            (change.diff?.length ?? 0),
          0,
        );
    } else if (item.kind === "plan") {
      revision += item.steps.reduce(
        (sum, step) => sum + step.text.length + step.status.length,
        0,
      );
    } else {
      revision += item.text.length;
      if (item.kind === "assistant" || item.kind === "thinking") {
        revision += item.streaming ? 1 : 0;
      }
    }
  }
  return revision;
}

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
  const userPausedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const previousUserMessageIdRef = useRef<string | null | undefined>(undefined);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const timelineRevision = agentTimelineRevision(session?.items ?? []);
  let latestUserMessageId: string | null = null;
  for (let index = (session?.items.length ?? 0) - 1; index >= 0; index -= 1) {
    const item = session?.items[index];
    if (item?.kind === "user") {
      latestUserMessageId = item.id;
      break;
    }
  }
  const workflow = latestWorkflow(session?.items ?? []);
  const workflowComplete = workflowIsComplete(workflow, session?.status);
  const [expiredWorkflowId, setExpiredWorkflowId] = useState<string | null>(null);

  useEffect(() => {
    if (!workflow || !workflowComplete) {
      setExpiredWorkflowId(null);
      return;
    }
    setExpiredWorkflowId(null);
    const timer = window.setTimeout(
      () => setExpiredWorkflowId(workflow.id),
      COMPLETED_WORKFLOW_TTL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [workflow?.id, workflowComplete]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
    setShowJumpToBottom(false);
  }, [
    timelineRevision,
    session?.status,
    session?.pending.length,
    session?.permission?.id,
    session?.error,
  ]);

  // Codex already uses a prompt-docking FLIP inside ChatGPTExperience. Give
  // every other provider the same upward handoff from composer to transcript
  // without coupling their deliberately different timeline layouts.
  useLayoutEffect(() => {
    const previousId = previousUserMessageIdRef.current;
    previousUserMessageIdRef.current = latestUserMessageId;
    if (
      session?.agent === "codex" ||
      !latestUserMessageId ||
      previousId === undefined ||
      previousId === latestUserMessageId ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const message = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-agent-user-message]") ?? [],
    ).find((node) => node.dataset.agentUserMessage === latestUserMessageId);
    const composer = composerRef.current;
    if (!message || !composer || typeof message.animate !== "function") return;

    const messageRect = message.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const deltaY = composerRect.top - 12 - messageRect.bottom;
    if (deltaY < 1) return;

    message.animate(
      [
        { transform: `translateY(${deltaY}px)`, offset: 0 },
        { transform: "translateY(0)", offset: 1 },
      ],
      {
        duration: 220,
        easing: "cubic-bezier(0.2, 0.82, 0.2, 1)",
      },
    );
  }, [latestUserMessageId, session?.agent]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const syncScrollState = () => {
      const movedUp = node.scrollTop < lastScrollTopRef.current - 1;
      if (movedUp) {
        userPausedRef.current = true;
        pinnedRef.current = false;
      }
      if (isAtScrollBottom(node)) {
        userPausedRef.current = false;
        pinnedRef.current = true;
      }
      setShowJumpToBottom(
        shouldShowJumpToBottom(node, userPausedRef.current),
      );
      lastScrollTopRef.current = node.scrollTop;
    };
    const followResize = () => {
      if (pinnedRef.current) node.scrollTop = node.scrollHeight;
      syncScrollState();
    };
    const resizeObserver = new ResizeObserver(followResize);
    const observeChildren = () => {
      for (const child of Array.from(node.children)) {
        resizeObserver.observe(child);
      }
    };
    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      followResize();
    });

    node.addEventListener("scroll", syncScrollState, { passive: true });
    resizeObserver.observe(node);
    observeChildren();
    mutationObserver.observe(node, { childList: true });
    syncScrollState();
    return () => {
      node.removeEventListener("scroll", syncScrollState);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  if (!session) return null;

  const { usage } = session;
  const visibleWorkflow =
    workflow && workflow.id !== expiredWorkflowId ? workflow : null;
  const timelineItems = workflow
    ? session.items.filter((item) => item.kind !== "plan")
    : session.items;
  const tokens = usage.inputTokens + usage.outputTokens;
  const ended = session.status === "exited" || session.status === "error";
  const resumable = canResume(session.agent);
  const resumeBlocked = session.status === "working" || session.status === "waiting";

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
  const submit = (text: string, images: AgentImageAttachment[]) => {
    const match = /^\/resume(?:\s+(.*))?$/i.exec(text.trim());
    if (match && images.length === 0) {
      setResumeQuery(match[1]?.trim() ?? "");
      return;
    }
    pinnedRef.current = true;
    userPausedRef.current = false;
    setShowJumpToBottom(false);
    agents.submit(termId, text, images);
  };

  const jumpToBottom = () => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = true;
    userPausedRef.current = false;
    setShowJumpToBottom(false);
    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
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
          <AgentProviderIcon agent={session.agent} program={session.program} />
        </span>
        <span className="agent-name">{session.label}</span>
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
        {/* Keep history discoverable on every resumable provider. Mid-turn it
            stays visible but disabled because swapping sessions would strand
            the work currently in flight. */}
        {resumable && !ended && (
          <button
            type="button"
            className="agent-head-btn is-quiet"
            onClick={() => setResumeQuery("")}
            disabled={resumeBlocked}
            title={
              resumeBlocked
                ? "Finish or stop the current turn before resuming another session"
                : `Resume a past ${session.label} session (/resume)`
            }
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
        <AgentTimeline
          session={session}
          items={timelineItems}
          termId={termId}
          agent={session.agent}
          status={session.status}
          started={session.started}
          label={session.label}
          mark={session.mark}
          program={session.program}
          cwd={session.cwd}
        />

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

      {session.status === "starting" && session.exitArmed && (
        <div className="agent-exit-hint is-surface" role="status" aria-live="polite">
          <kbd>Ctrl+C</kbd>
          <span>again to close</span>
        </div>
      )}

      {session.status !== "starting" && (
        <div className="agent-composer-shell">
          {showJumpToBottom && (
            <button
              type="button"
              className="agent-jump-bottom"
              onClick={jumpToBottom}
              title="Jump to bottom"
              aria-label="Jump to bottom"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 6 8 10.5 12.5 6" />
              </svg>
              <span>Jump to bottom</span>
            </button>
          )}
          {visibleWorkflow && (
            <div className="agent-workflow-dock">
              <PlanTracker item={visibleWorkflow} variant={workflowVariant(session.agent)} />
            </div>
          )}
          <AgentComposer
            session={session}
            active={active && !session.permission && resumeQuery === null}
            inputRef={composerRef}
            onSubmit={submit}
            onInterrupt={() => agents.interrupt(termId)}
          />
        </div>
      )}

      {resumeQuery !== null && (
        <AgentSessions
          agent={session.agent}
          cwd={session.cwd}
          label={session.label}
          initialQuery={resumeQuery}
          onClose={() => setResumeQuery(null)}
          onPick={(chosen) => {
            setResumeQuery(null);
            pinnedRef.current = true;
            userPausedRef.current = false;
            setShowJumpToBottom(false);
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
