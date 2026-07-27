import { useEffect, useMemo, useState } from "react";

import type { AgentId, AgentItem, AgentSessionState } from "../../lib/agents/types";
import { emptyUsage, makeChange } from "../../lib/agents/types";
import { AgentTimeline } from "./AgentTimeline";
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
      title: "bun test src/lib/agents",
      status: "done",
      command: "bun test src/lib/agents",
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
    },
    {
      kind: "thinking",
      id: "preview-thinking-2",
      at: now - 16_000,
      text: "Reconciling the parser changes with streamed tool updates",
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
  ];
}

export function AgentExperiencePreview() {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("provider") as AgentId | null;
  const playTurn = query.get("play") === "1";
  const completed = query.get("complete") === "1";
  const [agent, setAgent] = useState<AgentId>(
    PROVIDERS.some((provider) => provider.id === requested) && requested ? requested : "codex",
  );
  const [visibleCount, setVisibleCount] = useState(playTurn ? 1 : Number.POSITIVE_INFINITY);
  const provider = PROVIDERS.find((entry) => entry.id === agent) ?? PROVIDERS[0];
  const allItems = useMemo(previewItems, []);
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
    const timers = [900, 1450, 2050, 2700, 3300, 3900].map((delay, index) =>
      window.setTimeout(() => setVisibleCount(index + 2), delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [playTurn]);

  const replay = () => {
    setVisibleCount(0);
    window.requestAnimationFrame(() => setVisibleCount(1));
    [900, 1450, 2050, 2700, 3300, 3900].forEach((delay, index) => {
      window.setTimeout(() => setVisibleCount(index + 2), delay);
    });
  };

  const status: AgentSessionState["status"] = completed ? "idle" : "working";
  const session: AgentSessionState = {
    termId: "agent-experience-preview",
    agent,
    program: agent,
    label: provider.label,
    mark: provider.mark,
    accent: provider.accent,
    status,
    cwd: "H:\\Python\\Slop\\duckweed",
    model: provider.model,
    effort: "high",
    models: [],
    sessionId: "preview-session",
    items,
    pending: [],
    permission: null,
    usage: {
      ...emptyUsage(),
      inputTokens: 12_400,
      outputTokens: 2_100,
    },
    error: null,
    commands: [],
    started: true,
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
      >
        <header className="agent-head">
          <span className="agent-badge">{provider.mark}</span>
          <span className="agent-name">{provider.label}</span>
          <span className="agent-model">{provider.model}</span>
          <span className={`agent-state is-${status}`}>
            {status === "working" && <span className="agent-pulse" />}
            {status === "working" ? "working" : "ready"}
          </span>
          <span className="agent-head-spacer" />
          <span className="agent-usage">12.4k in · 2.1k out</span>
        </header>
        <div className="agent-scroll">
          <AgentTimeline
            session={session}
            items={items}
            agent={provider.id}
            status={status}
            started
            label={provider.label}
            mark={provider.mark}
            cwd="H:\\Python\\Slop\\duckweed"
          />
        </div>
        <footer className="agent-preview-composer" aria-label="Unchanged composer area">
          <textarea readOnly placeholder={`Message ${provider.label}…`} />
          <div>
            <span>{provider.model}</span>
            <span>High</span>
            <button type="button" aria-label="Stop preview">
              ■
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}
