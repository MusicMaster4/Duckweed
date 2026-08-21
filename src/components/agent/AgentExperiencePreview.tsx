import { useEffect, useMemo, useState } from "react";

import {
  runningSubagentCount,
  subagentForCallId,
  subagentRosters,
  subagentsForTurn,
} from "../../lib/agents/subagents";
import type { AgentId, AgentItem, AgentSessionState, PlanItem } from "../../lib/agents/types";
import { emptyUsage, makeChange } from "../../lib/agents/types";
import { AgentComposer } from "./AgentComposer";
import { AgentGoalIndicator } from "./AgentGoalIndicator";
import { AgentProviderIcon } from "./AgentProviderIcon";
import { AgentTimeline } from "./AgentTimeline";
import { copySelectedTextFromContextMenu } from "./selectionCopy";
import { Tooltip } from "../Tooltip";
import { PlanTracker, type OfficialVariant } from "./official/OfficialShared";
import { SubagentFocus } from "./subagents/SubagentFocus";
import { SubagentUiProvider } from "./subagents/SubagentUiContext";
import "./subagents/subagents.css";
import "./AgentExperiencePreview.css";

const PROVIDERS: Array<{
  id: AgentId;
  label: string;
  mark: string;
  accent: string;
  model: string;
}> = [
  { id: "codex", label: "Codex", mark: "CX", accent: "#9aa5b1", model: "GPT-5.6 Sol" },
  { id: "claude", label: "Claude Code", mark: "CC", accent: "#d97757", model: "Opus 5" },
  { id: "grok", label: "Grok Build", mark: "GR", accent: "#7ea6ff", model: "Grok 4.5" },
  { id: "cursor", label: "Cursor Agent", mark: "CU", accent: "#d4d4d4", model: "Composer" },
  { id: "opencode", label: "OpenCode", mark: "OC", accent: "#7be05a", model: "Default" },
];

function previewItems(): AgentItem[] {
  const now = Date.now();
  return [
    {
      kind: "user",
      id: "preview-user",
      at: now - 46_000,
      text: "Refactor the session parser, keep backwards compatibility, and verify the change.",
    },
    {
      kind: "thinking",
      id: "preview-thinking-1",
      at: now - 43_000,
      text: "Inspecting the session lifecycle and mapping the affected event paths",
      streaming: false,
    },
    {
      kind: "plan",
      id: "preview-plan",
      at: now - 40_000,
      planType: "tasks",
      steps: [
        { text: "Trace the current session lifecycle", status: "done" },
        { text: "Refactor the parser and stream file changes", status: "running" },
        { text: "Run focused tests and review compatibility", status: "pending" },
      ],
    },
    {
      kind: "tool",
      id: "preview-command",
      at: now - 31_000,
      callId: "preview-command",
      name: "shell",
      tool: "execute",
      title:
        '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem -Force -Name"',
      status: "done",
      command:
        '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem -Force -Name"',
      output: "42 pass\n0 fail",
      changes: [],
    },
    {
      kind: "tool",
      id: "preview-subagent",
      at: now - 24_000,
      callId: "preview-subagent",
      name: "spawn_agent",
      tool: "task",
      title: "Review protocol compatibility",
      status: "running",
      command: null,
      output: "Model: provider default · high\nReviewing the ACP and app-server event mappings",
      changes: [],
      subagent: {
        label: "Review protocol compatibility",
        role: "Reviewer",
        model: "provider default",
        prompt: "Review the ACP and app-server event mappings for compatibility.",
        activity: "Reviewing adapter event mappings",
        items: [
          {
            kind: "assistant",
            id: "preview-child-update",
            at: now - 23_500,
            text: "I found the compatibility boundary and am checking the fixtures.",
            streaming: false,
          },
          {
            kind: "tool",
            id: "preview-child-read",
            at: now - 23_000,
            callId: "preview-child-read",
            name: "Read",
            tool: "read",
            title: "Read adapter fixtures",
            status: "done",
            command: null,
            output: "All provider fixtures loaded",
            changes: [],
          },
        ],
      },
    },
    {
      kind: "tool",
      id: "preview-subagent-layout",
      at: now - 23_000,
      callId: "preview-subagent-layout",
      name: "task",
      tool: "task",
      title: "Check narrow pane layout",
      status: "running",
      command: null,
      output: "Testing roster overflow and pin behavior",
      changes: [],
      subagent: {
        label: "Check narrow pane layout",
        role: "UI reviewer",
        prompt: "Verify the roster and pin in a half-width terminal pane.",
        activity: "Testing the half-width pane",
      },
    },
    {
      kind: "tool",
      id: "preview-subagent-tests",
      at: now - 22_000,
      callId: "preview-subagent-tests",
      name: "task",
      tool: "task",
      title: "Review selector tests",
      status: "done",
      command: null,
      output: "Current-turn isolation and L1 fallback coverage passed",
      changes: [],
      subagent: {
        label: "Review selector tests",
        role: "Test reviewer",
        activity: "Selector coverage passed",
      },
    },
    {
      kind: "assistant",
      id: "preview-progress",
      at: now - 20_000,
      text:
        "I found the compatibility boundary. I am checking every streamed update before I finish.",
      streaming: true,
    },
    {
      kind: "thinking",
      id: "preview-thinking-2",
      at: now - 16_000,
      text:
        "Reconciling the parser changes with streamed tool updates.\n\nThe next step is to verify that older payload shapes still normalize without losing tool status, file changes, or assistant progress comments.",
      streaming: true,
    },
    {
      kind: "tool",
      id: "preview-edit",
      at: now - 9_000,
      callId: "preview-edit",
      name: "apply_patch",
      tool: "edit",
      title: "src/lib/agents/parser.ts",
      status: "running",
      command: null,
      output: "",
      changes: [
        makeChange(
          "src/lib/agents/parser.ts",
          "export function parse(frame: string) {\n  return JSON.parse(frame);\n}",
          "export function parse(frame: string) {\n  const value = JSON.parse(frame);\n  return normalizeFrame(value);\n}",
        ),
      ],
    },
    {
      kind: "assistant",
      id: "preview-answer",
      at: now - 2_000,
      text:
        "### Result\nThe parser now keeps **backwards compatibility** while normalizing streamed frames.\n\n- Existing payloads still pass\n- Tool and thought events remain separate",
      streaming: false,
    },
  ];
}

function stillWorkingPreviewItems(): AgentItem[] {
  const items = previewItems();
  return [
    ...items.slice(0, 5),
    {
      kind: "assistant",
      id: "preview-long-progress",
      at: Date.now() - 2_000,
      text:
        "I found the compatibility boundary and updated the parser. The main implementation is in place, but I am still checking the remaining event paths, backwards-compatible payloads, and the focused test coverage before I finish. This longer progress update intentionally leaves the turn active so the continuity state can be inspected.",
      streaming: false,
    },
  ];
}

export function AgentExperiencePreview() {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("provider") as AgentId | null;
  const playTurn = query.get("play") === "1";
  const completed = query.get("complete") === "1";
  const starting = query.get("starting") === "1";
  const exitArmed = query.get("exit-armed") === "1";
  const stillWorking = query.get("still-working") === "1";
  const [agent, setAgent] = useState<AgentId>(
    PROVIDERS.some((provider) => provider.id === requested) && requested ? requested : "codex",
  );
  const [visibleCount, setVisibleCount] = useState(playTurn ? 1 : Number.POSITIVE_INFINITY);
  const [peekedCallId, setPeekedCallId] = useState<string | null>(null);
  const [focusedCallId, setFocusedCallId] = useState<string | null>(null);
  const provider = PROVIDERS.find((entry) => entry.id === agent) ?? PROVIDERS[0];
  const allItems = useMemo(
    () => (stillWorking ? stillWorkingPreviewItems() : previewItems()),
    [stillWorking],
  );
  const items = useMemo(
    () =>
      allItems.slice(0, visibleCount).map((item) => {
        if (!completed) return item;
        if (item.kind === "thinking") return { ...item, streaming: false };
        if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) {
          return { ...item, status: "done" as const };
        }
        return item;
      }),
    [allItems, completed, visibleCount],
  );

  useEffect(() => {
    if (!playTurn) return;
    const timers = [900, 1450, 2050, 2700, 3300, 3900, 4550, 5150, 5750, 6350].map(
      (delay, index) => window.setTimeout(() => setVisibleCount(index + 2), delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [playTurn]);

  const replay = () => {
    setVisibleCount(0);
    window.requestAnimationFrame(() => setVisibleCount(1));
    [900, 1450, 2050, 2700, 3300, 3900, 4550, 5150, 5750, 6350].forEach((delay, index) => {
      window.setTimeout(() => setVisibleCount(index + 2), delay);
    });
  };

  const status: AgentSessionState["status"] = starting
    ? "starting"
    : completed
      ? "idle"
      : "working";
  const visibleItems = starting ? [] : items;
  const fleet = subagentsForTurn(visibleItems);
  const rosters = subagentRosters(visibleItems);
  const focusedSubagent = focusedCallId
    ? subagentForCallId(visibleItems, focusedCallId)
    : null;
  let workflow: PlanItem | null = null;
  for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
    if (visibleItems[index].kind === "plan") {
      workflow = visibleItems[index] as PlanItem;
      break;
    }
  }
  const timelineItems = workflow
    ? visibleItems.filter((item) => item.kind !== "plan")
    : visibleItems;
  const workflowVariant: OfficialVariant | "cursor" | "opencode" =
    agent === "codex" ? "chatgpt" : agent;
  const session: AgentSessionState = {
    termId: "agent-experience-preview",
    agent,
    program: agent,
    label: provider.label,
    mark: provider.mark,
    accent: provider.accent,
    status,
    workStartedAt: status === "working" ? Date.now() : null,
    lastWorkedForMs: null,
    cwd: "H:\\Python\\Slop\\duckweed",
    model: provider.model,
    effort: "high",
    models: [],
    sessionId: "preview-session",
    goal:
      !starting &&
      !completed &&
      (agent === "codex" || agent === "claude")
        ? { objective: "Ship the session parser safely", status: "active" }
        : null,
    items: visibleItems,
    pending: [],
    permission: null,
    usage: {
      ...emptyUsage(),
      inputTokens: 12_400,
      outputTokens: 2_100,
    },
    error: null,
    commands: [],
    started: !starting,
    exitArmed,
  };

  return (
    <main className="agent-preview-page">
      <nav className="agent-preview-tabs" aria-label="Agent UI previews">
        {PROVIDERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === agent ? "is-active" : ""}
            onClick={() => setAgent(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <span className="agent-preview-tabs-spacer" />
        <button type="button" onClick={replay}>
          Replay turn
        </button>
      </nav>
      <section
        className="agent-preview-surface"
        style={{ ["--agent-accent" as string]: provider.accent }}
        data-agent={provider.id}
        onContextMenu={(event) => {
          void copySelectedTextFromContextMenu(event);
        }}
      >
        <header className="agent-head">
          <span className="agent-badge">
            <AgentProviderIcon agent={provider.id} program={provider.id} />
          </span>
          <span className="agent-name">{provider.label}</span>
          <span className={`agent-state is-${status}`}>
            {status === "working" && <span className="agent-pulse" />}
            {status === "working" ? "working" : status === "starting" ? "starting" : "ready"}
          </span>
          <span className="agent-head-spacer" />
          <span className="agent-usage">12.4k in · 2.1k out</span>
          <Tooltip title="Session usage" detail="12.4k input · 2.1k output">
            <span
              className="agent-usage-compact"
              tabIndex={0}
              aria-label="Session usage: 12.4k input · 2.1k output"
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2.5 11.5V8.5M7 11.5V5.5M11.5 11.5V2.5" />
              </svg>
            </span>
          </Tooltip>
          <AgentGoalIndicator goal={session.goal} />
        </header>
        <div className="agent-scroll">
          <SubagentUiProvider
            agent={provider.id}
            now={Date.now()}
            rosters={rosters}
            peekedCallId={peekedCallId}
            focusedCallId={focusedCallId}
            onPeek={setPeekedCallId}
            onOpen={(callId) => {
              setPeekedCallId(null);
              setFocusedCallId(callId);
            }}
            onClosePeek={() => setPeekedCallId(null)}
            onLeaveFocus={() => setFocusedCallId(null)}
          >
            {focusedSubagent ? (
              <SubagentFocus
                agent={provider.id}
                parentLabel={provider.label}
                parentWorking={status === "working"}
                subagent={focusedSubagent}
                now={Date.now()}
                onBack={() => setFocusedCallId(null)}
              />
            ) : (
              <AgentTimeline
                session={session}
                items={timelineItems}
                /* Per provider, so switching the preview draws a new animation. */
                termId={`${session.termId}:${provider.id}`}
                agent={provider.id}
                status={status}
                started={!starting}
                label={provider.label}
                mark={provider.mark}
                program={provider.id}
                cwd="H:\\Python\\Slop\\duckweed"
              />
            )}
          </SubagentUiProvider>
        </div>
        {!starting && (
          <div className="agent-composer-shell">
            {workflow && (
              <div className="agent-workflow-dock">
                <PlanTracker
                  item={workflow}
                  variant={workflowVariant}
                  runningSubagents={runningSubagentCount(fleet)}
                />
              </div>
            )}
            <AgentComposer
              session={session}
              active
              onSubmit={() => {}}
              onInterrupt={() => {}}
              target={
                focusedSubagent
                  ? {
                      kind: "subagent",
                      label: focusedSubagent.label,
                      canMessage: Boolean(focusedSubagent.threadId),
                    }
                  : undefined
              }
            />
          </div>
        )}
      </section>
    </main>
  );
}
