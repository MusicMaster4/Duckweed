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
  runningSubagentCount,
  subagentForCallId,
  subagentRosters,
  subagentStatusLabel,
  subagentsForTurn,
  type SubagentSummary,
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
import { AgentRuntimePanel } from "./AgentRuntimePanel";
import { AgentSessions } from "./AgentSessions";
import { AgentSideQuestion } from "./AgentSideQuestion";
import { AgentTimeline } from "./AgentTimeline";
import { copySelectedTextFromContextMenu } from "./selectionCopy";
import { PlanTracker, type OfficialVariant } from "./official/OfficialShared";
import { SubagentFocus } from "./subagents/SubagentFocus";
import {
  SubagentMultiPane,
  SubagentNavigator,
} from "./subagents/SubagentNavigator";
import { SubagentUiProvider } from "./subagents/SubagentUiContext";
import "./subagents/subagents.css";

interface Props {
  termId: string;
  /** The pane holding this surface has the keyboard. */
  active: boolean;
  /** Return true when an app-level action handled this submission. */
  onBeforeSubmit?: (
    text: string,
    images: AgentImageAttachment[],
    delivery: "default" | "alternate",
  ) => boolean;
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
export function AgentSurface({
  termId,
  active,
  onBeforeSubmit,
  onClose,
  onSelectionCopied,
}: Props) {
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
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false);
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
  const [peekedCallId, setPeekedCallId] = useState<string | null>(null);
  const [focusedCallId, setFocusedCallId] = useState<string | null>(null);
  const [subagentNavigatorOpen, setSubagentNavigatorOpen] = useState(false);
  const [multiPane, setMultiPane] = useState(false);
  const [multiPaneCallIds, setMultiPaneCallIds] = useState<string[]>([]);
  const [activePaneId, setActivePaneId] = useState("parent");
  const subagentNavigatorId = `agent-subagent-navigator-${termId}`;
  const autoPeekedRef = useRef<string | null>(null);
  const fleet = useMemo(() => subagentsForTurn(items), [items]);
  const rosters = useMemo(() => subagentRosters(items), [items]);
  const focusedSubagent = useMemo(
    () => (focusedCallId ? subagentForCallId(items, focusedCallId) : null),
    [focusedCallId, items],
  );
  const multiPaneSubagents = useMemo(
    () =>
      multiPaneCallIds
        .map((callId) => subagentForCallId(items, callId))
        .filter((subagent): subagent is SubagentSummary => Boolean(subagent)),
    [items, multiPaneCallIds],
  );
  const composerSubagent = useMemo(
    () =>
      multiPane && activePaneId !== "parent"
        ? subagentForCallId(items, activePaneId)
        : focusedSubagent,
    [activePaneId, focusedSubagent, items, multiPane],
  );
  const timelineItems = useMemo(
    () => (workflow ? items.filter((item) => item.kind !== "plan") : items),
    [items, workflow],
  );
  const canMessageFocused = Boolean(
    composerSubagent?.threadId &&
      session &&
      agents.canPromptSubagent(termId) &&
      (composerSubagent.status === "running" || composerSubagent.status === "done"),
  );

  const closePeek = useCallback(() => {
    setPeekedCallId(null);
  }, []);

  const closeNavigatorIfCompact = useCallback(() => {
    if ((surfaceRef.current?.getBoundingClientRect().width ?? window.innerWidth) <= 760) {
      setSubagentNavigatorOpen(false);
    }
  }, []);

  const inspectSubagent = useCallback((callId: string) => {
    const subagent = subagentForCallId(items, callId);
    void agents.inspectSubagent(termId, callId, subagent?.threadId ?? null);
  }, [items, termId]);

  const leaveFocus = useCallback(() => {
    setMultiPane(false);
    setActivePaneId("parent");
    setFocusedCallId(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const peekSubagent = useCallback((callId: string) => {
    setFocusedCallId(null);
    setPeekedCallId(callId);
  }, []);

  const openSubagent = useCallback((callId: string) => {
    inspectSubagent(callId);
    setMultiPane(false);
    setActivePaneId(callId);
    setPeekedCallId(null);
    setFocusedCallId(callId);
    closeNavigatorIfCompact();
  }, [closeNavigatorIfCompact, inspectSubagent]);

  const enterMultiPane = useCallback(() => {
    const preferred = focusedCallId ?? peekedCallId;
    const initial = [preferred, ...fleet.map((subagent) => subagent.callId)]
      .filter((callId): callId is string => Boolean(callId))
      .filter((callId, index, all) => all.indexOf(callId) === index)
      .slice(0, 3);
    setMultiPaneCallIds(initial);
    for (const callId of initial) inspectSubagent(callId);
    setActivePaneId(preferred ?? "parent");
    setFocusedCallId(null);
    setPeekedCallId(null);
    setMultiPane(true);
    closeNavigatorIfCompact();
  }, [closeNavigatorIfCompact, fleet, focusedCallId, inspectSubagent, peekedCallId]);

  const leaveMultiPane = useCallback(() => {
    setMultiPane(false);
    if (activePaneId === "parent") {
      setFocusedCallId(null);
    } else {
      setFocusedCallId(activePaneId);
    }
  }, [activePaneId]);

  const selectNavigatorSubagent = useCallback((callId: string) => {
    if (!multiPane) {
      openSubagent(callId);
      return;
    }
    setMultiPaneCallIds((current) => {
      if (current.includes(callId)) return current;
      if (current.length < 3) return [...current, callId];
      const replaceAt = current.findIndex((id) => id !== activePaneId);
      if (replaceAt < 0) return [...current.slice(1), callId];
      const next = [...current];
      next[replaceAt] = callId;
      return next;
    });
    setActivePaneId(callId);
    inspectSubagent(callId);
    closeNavigatorIfCompact();
  }, [activePaneId, closeNavigatorIfCompact, inspectSubagent, multiPane, openSubagent]);

  const focusWorkspacePane = useCallback((id: string) => {
    if (id !== "parent") inspectSubagent(id);
    setMultiPane(false);
    setActivePaneId(id);
    setFocusedCallId(id === "parent" ? null : id);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [inspectSubagent]);

  const closeWorkspacePane = useCallback((callId: string) => {
    setMultiPaneCallIds((current) => current.filter((id) => id !== callId));
    setActivePaneId((current) => (current === callId ? "parent" : current));
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
    if (!active) return;
    if (focusedCallId && !focusedSubagent) {
      setFocusedCallId(null);
      return;
    }
    if (peekedCallId && !subagentForCallId(items, peekedCallId)) {
      setPeekedCallId(null);
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (multiPane) {
        event.preventDefault();
        leaveMultiPane();
        return;
      }
      if (focusedCallId) {
        event.preventDefault();
        leaveFocus();
        return;
      }
      if (peekedCallId) {
        event.preventDefault();
        closePeek();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [
    active,
    closePeek,
    focusedCallId,
    focusedSubagent,
    items,
    leaveFocus,
    leaveMultiPane,
    multiPane,
    peekedCallId,
  ]);

  useEffect(() => {
    const live = fleet.filter(
      (subagent) => subagent.status === "running" || subagent.status === "pending",
    );
    if (live.length === 1 && autoPeekedRef.current !== live[0].callId && !focusedCallId) {
      autoPeekedRef.current = live[0].callId;
      setPeekedCallId(live[0].callId);
    }
    if (live.length !== 1) autoPeekedRef.current = null;
  }, [fleet, focusedCallId]);

  useEffect(() => {
    const available = new Set(fleet.map((subagent) => subagent.callId));
    setMultiPaneCallIds((current) => current.filter((callId) => available.has(callId)));
    if (fleet.length === 0) {
      setSubagentNavigatorOpen(false);
      setMultiPane(false);
      setActivePaneId("parent");
      return;
    }
    if (activePaneId !== "parent" && !available.has(activePaneId)) {
      setActivePaneId("parent");
    }
  }, [activePaneId, fleet]);

  useEffect(() => {
    if (!active || fleet.length === 0) return;
    const navigateRoster = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === "Backslash") {
        event.preventDefault();
        if (focusedCallId) {
          leaveFocus();
        } else {
          const first =
            fleet.find(
              (subagent) =>
                subagent.status === "running" || subagent.status === "pending",
            ) ?? fleet[0];
          openSubagent(first.callId);
        }
        return;
      }
      if (event.code !== "BracketLeft" && event.code !== "BracketRight") return;
      event.preventDefault();
      const currentId = focusedCallId ?? peekedCallId;
      const current = fleet.findIndex((subagent) => subagent.callId === currentId);
      const direction = event.code === "BracketRight" ? 1 : -1;
      const next =
        current < 0
          ? direction > 0
            ? 0
            : fleet.length - 1
          : (current + direction + fleet.length) % fleet.length;
      if (focusedCallId) openSubagent(fleet[next].callId);
      else peekSubagent(fleet[next].callId);
    };
    window.addEventListener("keydown", navigateRoster);
    return () => window.removeEventListener("keydown", navigateRoster);
  }, [
    active,
    fleet,
    focusedCallId,
    leaveFocus,
    openSubagent,
    peekedCallId,
    peekSubagent,
  ]);

  useEffect(() => {
    const childrenLive = fleet.some(
      (subagent) => subagent.status === "running" || subagent.status === "pending",
    );
    if (
      (session?.status !== "working" || session.workStartedAt === null) &&
      !childrenLive
    ) {
      return;
    }
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [fleet, session?.status, session?.workStartedAt]);

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
    if (onBeforeSubmit?.(text, images, delivery) === true) return true;
    if (composerSubagent) {
      if (!canMessageFocused || !composerSubagent.threadId) return true;
      void agents.promptSubagent(termId, composerSubagent.threadId, text);
      return false;
    }
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
      className={`agent-surface is-${session.status}${
        subagentNavigatorOpen ? " has-subagent-navigator" : ""
      }${multiPane ? " is-subagent-multi-pane" : ""}`}
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
        {focusedSubagent && (
          <button
            type="button"
            className="agent-head-btn is-quiet"
            onClick={leaveFocus}
            aria-label="Back to parent"
            title="Back to parent (Esc)"
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M8.5 3.5 4 7l4.5 3.5" />
            </svg>
          </button>
        )}
        <span className="agent-name">
          {multiPane
            ? `${session.label} / ${multiPaneSubagents.length + 1} panes`
            : focusedSubagent
            ? `${session.label} / ${focusedSubagent.label}`
            : session.label}
        </span>
        <span
          className={`agent-state is-${
            focusedSubagent ? focusedSubagent.status : session.status
          }`}
        >
          {session.status === "working" && !session.loadingHistory && !focusedSubagent && !multiPane && (
            <span className="agent-pulse" aria-hidden="true" />
          )}
          {session.loadingHistory
            ? "Loading conversation"
            : multiPane
              ? `${multiPaneSubagents.length + 1} panes`
              : focusedSubagent
              ? subagentStatusLabel(focusedSubagent.status)
              : workStatusLabel(session, clockNow)}
        </span>
        {fleet.length > 0 && (
          <button
            type="button"
            className={`agent-sub-tab${subagentNavigatorOpen ? " is-active" : ""}`}
            onClick={() => setSubagentNavigatorOpen((open) => !open)}
            aria-controls={subagentNavigatorId}
            aria-expanded={subagentNavigatorOpen}
            aria-label={`Agents, ${fleet.length} subagents`}
            title="Subagents"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="4" cy="5" r="1.5" />
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="8" cy="12" r="1.5" />
              <path d="M5.3 5.8 7.1 10M10.7 5.8 8.9 10" />
            </svg>
            <span>Agents</span>
            <i>{fleet.length}</i>
          </button>
        )}
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
        <button
          type="button"
          className={`agent-head-btn is-quiet${runtimePanelOpen ? " is-active" : ""}`}
          onClick={() => {
            const open = !runtimePanelOpen;
            setRuntimePanelOpen(open);
            if (open) {
              void agents.refreshExtensions(termId);
              void agents.refreshTasks(termId);
            }
          }}
          title="Extensions, tasks and protocol support"
          aria-label="Extensions, tasks and protocol support"
          aria-expanded={runtimePanelOpen}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2.5 3.5h9M2.5 7h9M2.5 10.5h9" />
            <circle cx="4" cy="3.5" r="1" /><circle cx="9" cy="7" r="1" /><circle cx="6" cy="10.5" r="1" />
          </svg>
        </button>
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

      {runtimePanelOpen && (
        <AgentRuntimePanel
          session={session}
          onRefreshExtensions={() => void agents.refreshExtensions(termId)}
          onRefreshTasks={() => void agents.refreshTasks(termId)}
          onStopTask={(taskId) => void agents.stopTask(termId, taskId)}
          onNative={() => agents.handoffToNative(termId)}
        />
      )}

      <div
        className={`agent-scroll${multiPane ? " is-subagent-workspace" : ""}${
          session.permission && session.permission.kind !== "question"
            ? " has-permission"
            : ""
        }`}
        ref={scrollRef}
      >
        <SubagentUiProvider
          agent={session.agent}
          now={clockNow}
          rosters={rosters}
          peekedCallId={peekedCallId}
          focusedCallId={focusedCallId}
          onPeek={peekSubagent}
          onOpen={openSubagent}
          onClosePeek={closePeek}
          onLeaveFocus={leaveFocus}
        >
          {multiPane ? (
            <SubagentMultiPane
              agent={session.agent}
              parentLabel={session.label}
              parentWorking={session.status === "working"}
              parent={
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
              }
              subagents={multiPaneSubagents}
              now={clockNow}
              activeId={activePaneId}
              onActivate={setActivePaneId}
              onFocus={focusWorkspacePane}
              onClosePane={closeWorkspacePane}
            />
          ) : focusedSubagent ? (
            <SubagentFocus
              agent={session.agent}
              parentLabel={session.label}
              parentWorking={session.status === "working"}
              subagent={focusedSubagent}
              now={clockNow}
              onBack={leaveFocus}
            />
          ) : (
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
          )}
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

      {subagentNavigatorOpen && fleet.length > 0 && (
        <div className="agent-sub-navigator-shell" id={subagentNavigatorId}>
          <SubagentNavigator
            agent={session.agent}
            parentLabel={session.label}
            parentWorking={session.status === "working"}
            subagents={fleet}
            now={clockNow}
            selectedId={multiPane ? activePaneId : focusedCallId ?? "parent"}
            multiPane={multiPane}
            paneIds={multiPaneCallIds}
            onSelectParent={() => {
              if (multiPane) setActivePaneId("parent");
              else leaveFocus();
              closeNavigatorIfCompact();
            }}
            onSelectSubagent={selectNavigatorSubagent}
            onToggleMultiPane={multiPane ? leaveMultiPane : enterMultiPane}
            onClose={() => setSubagentNavigatorOpen(false)}
          />
        </div>
      )}

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
            target={
              composerSubagent
                ? {
                    kind: "subagent",
                    label: composerSubagent.label,
                    canMessage: canMessageFocused,
                  }
                : undefined
            }
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
