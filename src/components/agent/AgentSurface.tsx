import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { agentHasUnfinishedWork } from "../../lib/agents/activity";
import { conversationText } from "../../lib/agents/conversation";
import { canResume } from "../../lib/agents/history";
import * as agents from "../../lib/agents/session";
import { isNewChatCommand } from "../../lib/agents/slashCatalog";
import {
  COMPLETED_SUBAGENT_FLEET_TTL_MS,
  runningSubagentCount,
  subagentForCallId,
  subagentFleetIsComplete,
  subagentsForTurn,
} from "../../lib/agents/subagents";
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
import { workStatusLabel } from "../../lib/agentWorkDuration";
import { confirmCloseRunning } from "../../lib/confirmClose";
import { writeClipboardText } from "../../lib/clipboard";
import { Tooltip } from "../Tooltip";
import { AgentComposer } from "./AgentComposer";
import { AgentGoalIndicator } from "./AgentGoalIndicator";
import { AgentImageAttachments } from "./AgentImageAttachments";
import { AgentPermission } from "./AgentPermission";
import { AgentProviderIcon } from "./AgentProviderIcon";
import { AgentQuestion } from "./AgentQuestion";
import { AgentSessions } from "./AgentSessions";
import { AgentSideQuestion } from "./AgentSideQuestion";
import { AgentTimeline } from "./AgentTimeline";
import { copySelectedTextFromContextMenu } from "./selectionCopy";
import { PlanTracker, type OfficialVariant } from "./official/OfficialShared";
import { SubagentFleet } from "./subagents/SubagentFleet";
import { SubagentInspector } from "./subagents/SubagentInspector";
import { SubagentUiProvider } from "./subagents/SubagentUiContext";
import "./subagents/subagents.css";

interface Props {
  termId: string;
  /** The pane holding this surface has the keyboard. */
  active: boolean;
  /** Close the agent and hand the pane back to its shell. */
  onClose: () => void;
  /** Show copy feedback at the pointer after a right-click selection copy. */
  onSelectionCopied: (x: number, y: number) => void;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function workflowVariant(agent: AgentSessionState["agent"]): OfficialVariant | "cursor" | "opencode" {
  if (agent === "codex") return "chatgpt";
  return agent;
}

export function latestWorkflow(items: AgentSessionState["items"]) {
  return findLatestWorkflow(items);
}

const EMPTY_ITEMS: AgentSessionState["items"] = [];

/**
 * The custom agent UI: a layer over the terminal that ran the agent.
 *
 * The terminal underneath is still there, still owns the pane's geometry, and
 * gets it back the moment the session ends. Nothing here writes to the PTY —
 * the agent this renders is a separate headless process speaking a structured
 * protocol, which is the only reason any of this content exists to draw.
 */
export function AgentSurface({ termId, active, onClose, onSelectionCopied }: Props) {
  const session = useSyncExternalStore(
    useCallback((callback) => agents.subscribe(termId, callback), [termId]),
    useCallback(() => agents.get(termId), [termId]),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationMenuRef = useRef<HTMLDivElement>(null);
  /** Open with the text typed after `/resume`, so it doubles as a filter. */
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [conversationCopied, setConversationCopied] = useState(false);
  // Following the stream is the default, but scrolling up to read something is
  // a deliberate act — new output must not yank the view back down.
  const pinnedRef = useRef(true);
  const userPausedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const items = session?.items ?? EMPTY_ITEMS;
  const workflow = useMemo(() => latestWorkflow(items), [items]);
  const workflowComplete = workflowIsComplete(workflow, session?.status);
  const [expiredWorkflowId, setExpiredWorkflowId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [selectedSubagentCallId, setSelectedSubagentCallId] = useState<string | null>(
    null,
  );
  const fleet = useMemo(() => subagentsForTurn(items), [items]);
  const fleetKey = useMemo(
    () => fleet.map((subagent) => subagent.callId).join("\u001f"),
    [fleet],
  );
  const fleetComplete = subagentFleetIsComplete(fleet, session?.status);
  const [expiredFleetKey, setExpiredFleetKey] = useState<string | null>(null);
  const selectedSubagent = useMemo(
    () =>
      selectedSubagentCallId
        ? subagentForCallId(items, selectedSubagentCallId)
        : null,
    [items, selectedSubagentCallId],
  );
  const dockedFleet =
    fleetComplete && expiredFleetKey === fleetKey ? [] : fleet;
  const visibleFleet =
    selectedSubagent &&
    !dockedFleet.some((subagent) => subagent.callId === selectedSubagent.callId)
      ? [...dockedFleet, selectedSubagent]
      : dockedFleet;
  const timelineItems = useMemo(
    () => (workflow ? items.filter((item) => item.kind !== "plan") : items),
    [items, workflow],
  );

  const closeSubagentInspector = useCallback(() => {
    setSelectedSubagentCallId(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!conversationMenuOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!conversationMenuRef.current?.contains(event.target as Node)) {
        setConversationMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setConversationMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [conversationMenuOpen]);

  useEffect(() => {
    if (!conversationCopied) return;
    const timer = window.setTimeout(() => setConversationCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [conversationCopied]);

  useEffect(() => {
    if (!active || !selectedSubagentCallId) return;
    if (!selectedSubagent) {
      setSelectedSubagentCallId(null);
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSubagentInspector();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [active, closeSubagentInspector, selectedSubagent, selectedSubagentCallId]);

  useEffect(() => {
    if (!fleetComplete) {
      if (expiredFleetKey === fleetKey) setExpiredFleetKey(null);
      return;
    }
    if (!fleetKey || expiredFleetKey === fleetKey || selectedSubagentCallId) return;
    const timer = window.setTimeout(
      () => setExpiredFleetKey(fleetKey),
      COMPLETED_SUBAGENT_FLEET_TTL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [
    expiredFleetKey,
    fleetComplete,
    fleetKey,
    selectedSubagentCallId,
  ]);

  useEffect(() => {
    if (!active || !visibleFleet.length) return;
    const navigateFleet = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === "Backslash") {
        event.preventDefault();
        if (selectedSubagentCallId) {
          closeSubagentInspector();
        } else {
          const first =
            visibleFleet.find(
              (subagent) =>
                subagent.status === "running" || subagent.status === "pending",
            ) ?? visibleFleet[0];
          setSelectedSubagentCallId(first.callId);
        }
        return;
      }
      if (event.code !== "BracketLeft" && event.code !== "BracketRight") return;
      event.preventDefault();
      const current = visibleFleet.findIndex(
        (subagent) => subagent.callId === selectedSubagentCallId,
      );
      const direction = event.code === "BracketRight" ? 1 : -1;
      const next =
        current < 0
          ? direction > 0
            ? 0
            : visibleFleet.length - 1
          : (current + direction + visibleFleet.length) % visibleFleet.length;
      setSelectedSubagentCallId(visibleFleet[next].callId);
    };
    window.addEventListener("keydown", navigateFleet);
    return () => window.removeEventListener("keydown", navigateFleet);
  }, [
    active,
    closeSubagentInspector,
    selectedSubagentCallId,
    visibleFleet,
  ]);

  useEffect(() => {
    if (session?.status !== "working" || session.workStartedAt === null) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session?.status, session?.workStartedAt]);

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

  // A mounted or remounted conversation opens at its newest turn. Later
  // streamed height changes are handled by ResizeObserver without forcing a
  // synchronous full-transcript layout for every text delta.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
  }, [termId]);

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
    workflow && workflow.steps.length > 0 && workflow.id !== expiredWorkflowId
      ? workflow
      : null;
  const tokens = usage.inputTokens + usage.outputTokens;
  const usageDetail = [
    `${formatTokens(usage.inputTokens)} input`,
    `${formatTokens(usage.outputTokens)} output`,
    usage.contextUsed !== null
      ? `${Math.round(usage.contextUsed * 100)}% context`
      : null,
    usage.costUsd !== null ? `$${usage.costUsd.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const ended = session.status === "exited" || session.status === "error";
  const resumable = canResume(session.agent);
  const resumeBlocked = session.status === "working" || session.status === "waiting";
  const copyConversation = async () => {
    const transcript = conversationText(session.items, session.label);
    if (!transcript) return;
    setConversationCopied(await writeClipboardText(transcript));
  };

  /** Warn only while closing would interrupt an unfinished turn. */
  const requestClose = () => {
    if (!agentHasUnfinishedWork(session.status)) {
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
   * App-owned session commands never leave Duckweed. `/resume` opens stored
   * history, while `/new` (and its short alias `/n`) relaunches the same agent
   * with a blank provider-side conversation.
   */
  const submit = (
    text: string,
    images: AgentImageAttachment[],
    delivery: "default" | "alternate" = "default",
  ) => {
    if (images.length === 0) {
      const trimmed = text.trim();
      const resumeMatch = /^\/resume(?:\s+(.*))?$/i.exec(trimmed);
      if (resumeMatch) {
        setResumeQuery(resumeMatch[1]?.trim() ?? "");
        return;
      }
      if (isNewChatCommand(trimmed)) {
        pinnedRef.current = true;
        userPausedRef.current = false;
        setShowJumpToBottom(false);
        void agents.newChat(termId).then((failure) => {
          // A failed relaunch leaves no agent session to render. Return the
          // pane to its shell instead of leaving the custom surface empty.
          if (failure) onClose();
        });
        return;
      }
    }
    pinnedRef.current = true;
    userPausedRef.current = false;
    setShowJumpToBottom(false);
    agents.submit(termId, text, images, delivery);
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

  const dismissSideQuestion = () => {
    agents.dismissSideQuestion(termId);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const showSubagentInTimeline = (callId: string) => {
    const target = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLElement>("[data-subagent-call-id]") ?? [],
    ).find((element) => element.dataset.subagentCallId === callId);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("agent-sub-timeline-selected");
    window.requestAnimationFrame(() => {
      target.classList.add("agent-sub-timeline-selected");
      window.setTimeout(() => target.classList.remove("agent-sub-timeline-selected"), 1_050);
    });
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

  /** Match the terminal convention: right-clicking while text is selected copies it. */
  const copySelectedText = (event: React.MouseEvent<HTMLDivElement>) => {
    const { clientX, clientY } = event;
    const copy = copySelectedTextFromContextMenu(event);
    if (!copy) return;
    void copy.then((copied) => {
      if (copied) onSelectionCopied(clientX, clientY);
    });
  };

  return (
    <div
      ref={surfaceRef}
      className={`agent-surface is-${session.status}`}
      style={{ ["--agent-accent" as string]: session.accent }}
      data-agent={session.agent}
      data-program={session.program}
      onMouseUp={focusComposer}
      onContextMenu={copySelectedText}
    >
      <header className="agent-head">
        <span className="agent-badge" aria-hidden="true">
          <AgentProviderIcon agent={session.agent} program={session.program} />
        </span>
        <span className="agent-name">{session.label}</span>
        <span className={`agent-state is-${session.status}`}>
          {session.status === "working" && !session.loadingHistory && (
            <span className="agent-pulse" aria-hidden="true" />
          )}
          {session.loadingHistory ? "Loading conversation" : workStatusLabel(session, clockNow)}
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
        {(tokens > 0 || usage.contextUsed !== null) && (
          <Tooltip title="Session usage" detail={usageDetail}>
            <span
              className="agent-usage-compact"
              tabIndex={0}
              aria-label={`Session usage: ${usageDetail}`}
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2.5 11.5V8.5M7 11.5V5.5M11.5 11.5V2.5" />
              </svg>
            </span>
          </Tooltip>
        )}
        <AgentGoalIndicator goal={session.goal} />
        <div className="agent-conversation-menu" ref={conversationMenuRef}>
          <button
            type="button"
            className="agent-head-btn is-quiet"
            onClick={() => setConversationMenuOpen((open) => !open)}
            title={conversationMenuOpen ? undefined : "Conversation actions"}
            aria-label="Conversation actions"
            aria-haspopup="menu"
            aria-expanded={conversationMenuOpen}
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M8 1.5 3.5 7.8h3L6 12.5l4.5-6.3h-3z" />
            </svg>
          </button>
          {conversationMenuOpen && (
            <div className="agent-conversation-popover" role="menu">
              {resumable && !ended && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={resumeBlocked}
                  title={
                    resumeBlocked
                      ? "Finish or stop the current turn before resuming another session"
                      : undefined
                  }
                  onClick={() => {
                    setConversationMenuOpen(false);
                    setResumeQuery("");
                  }}
                >
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M2 7a5 5 0 1 0 1.6-3.7" />
                    <path d="M2 1.8V4.4H4.6" />
                  </svg>
                  <span>Resume past conversation</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={session.items.length === 0}
                onClick={() => void copyConversation()}
              >
                {conversationCopied ? (
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M2.5 7.5l2.7 2.7 6-6" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <rect x="5" y="5" width="7" height="7" rx="1.2" />
                    <path d="M9 5V3.2A1.2 1.2 0 0 0 7.8 2H3.2A1.2 1.2 0 0 0 2 3.2v4.6A1.2 1.2 0 0 0 3.2 9H5" />
                  </svg>
                )}
                <span>{conversationCopied ? "Conversation copied" : "Copy entire conversation"}</span>
              </button>
            </div>
          )}
        </div>
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

      <div
        className={`agent-scroll${
          session.permission && session.permission.kind !== "question"
            ? " has-permission"
            : ""
        }`}
        ref={scrollRef}
      >
        <SubagentUiProvider
          selectedCallId={selectedSubagentCallId}
          onSelect={setSelectedSubagentCallId}
        >
          <AgentTimeline
            session={session}
            items={timelineItems}
            termId={termId}
            agent={session.agent}
            status={session.loadingHistory ? "idle" : session.status}
            started={session.started}
            label={session.label}
            mark={session.mark}
            program={session.program}
            cwd={session.cwd}
          />
        </SubagentUiProvider>

        {session.pending.map((prompt) => (
          <div key={prompt.id} className="agent-turn is-pending">
            <span className="agent-turn-mark" aria-hidden="true" />
            <div className="agent-turn-pending-copy">
              <p className="agent-turn-text">
                {prompt.text ||
                  (prompt.images.length === 1
                    ? "1 image attached"
                    : `${prompt.images.length} images attached`)}
              </p>
              {prompt.images.length > 0 && (
                <AgentImageAttachments images={prompt.images} variant="message" />
              )}
            </div>
            <div className="agent-turn-pending-actions">
              <span className="agent-turn-queued">queued</span>
              <button
                type="button"
                className="agent-turn-send-now"
                disabled={!agents.canSteer(termId)}
                onClick={() => agents.sendQueuedNow(termId, prompt.id)}
                title={
                  agents.canSteer(termId)
                    ? "Send this message into the active turn"
                    : `${session.label} does not support same-turn steering`
                }
              >
                Send now
              </button>
              <button
                type="button"
                className="agent-turn-cancel"
                onClick={() => agents.cancelQueued(termId, prompt.id)}
                title="Remove queued message"
                aria-label="Remove queued message"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3.25 3.25 5.5 5.5m0-5.5-5.5 5.5" />
                </svg>
              </button>
            </div>
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

        {session.permission &&
          (session.permission.kind === "question" ? (
            <AgentQuestion
              /* A new question is a new card, not the old one with new text:
                 the key drops any half-made selection with the question it
                 belonged to. */
              key={session.permission.id}
              permission={session.permission}
              onAnswer={(answers) =>
                agents.answer(termId, session.permission?.id ?? "", answers)
              }
              onSkip={() => agents.respond(termId, session.permission?.id ?? "", "deny")}
            />
          ) : (
            <AgentPermission
              permission={session.permission}
              onRespond={(optionId) =>
                agents.respond(termId, session.permission?.id ?? "", optionId)
              }
            />
          ))}
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
          <SubagentFleet
            agent={session.agent}
            subagents={visibleFleet}
            selectedCallId={selectedSubagentCallId}
            onSelect={setSelectedSubagentCallId}
          />
          {visibleWorkflow && (
            <div className="agent-workflow-dock">
              <PlanTracker
                item={visibleWorkflow}
                variant={workflowVariant(session.agent)}
                runningSubagents={runningSubagentCount(fleet)}
              />
            </div>
          )}
          {session.sideQuestion && (
            <div className="agent-side-question-dock">
              <AgentSideQuestion
                question={session.sideQuestion}
                onDismiss={dismissSideQuestion}
              />
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

      {selectedSubagent && (
        <SubagentInspector
          agent={session.agent}
          subagent={selectedSubagent}
          canMessage={
            Boolean(selectedSubagent.threadId) &&
            agents.canPromptSubagent(termId) &&
            (selectedSubagent.status === "running" || selectedSubagent.status === "done")
          }
          onMessage={(text) =>
            selectedSubagent.threadId
              ? agents.promptSubagent(termId, selectedSubagent.threadId, text)
              : Promise.resolve(false)
          }
          onClose={closeSubagentInspector}
          onShowInTimeline={showSubagentInTimeline}
        />
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
