import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import type {
  AgentItem,
  AgentPlanStep,
  AgentSessionState,
  PlanItem,
  ThinkingItem,
  ToolItem,
  ToolKind,
} from "../../../lib/agents/types";
import { openUrl } from "../../../lib/ipc";
import { AgentAsciiLoader } from "../AgentAsciiLoader";
import { AgentDiff } from "../AgentDiff";
import { AgentImageAttachments } from "../AgentImageAttachments";
import { MessageCopyButton } from "../MessageCopyButton";
import { AgentProviderIcon } from "../AgentProviderIcon";
import { SubagentBoardAnchor } from "../subagents/SubagentBoard";
import { useSubagentUi } from "../subagents/SubagentUiContext";
import { useToolLoadingPhase } from "../useToolLoadingPhase";
import { preparingMessageFor, thinkingHeadlineFor } from "./preparingMessages";
import { thinkingPulsePatternFor } from "./thinkingPulsePatterns";

export interface ExperienceProps {
  items: AgentItem[];
  /** Identifies the terminal, so per-terminal presentation state can persist. */
  termId: string;
  agent: AgentSessionState["agent"];
  status: AgentSessionState["status"];
  started: boolean;
  label: string;
  mark: string;
  program: string;
  cwd: string;
}

export type OfficialVariant = "chatgpt" | "claude" | "grok";
export type ActivityVariant = OfficialVariant | "cursor" | "opencode";

const TOOL_LABEL: Record<ToolKind, string> = {
  read: "Reading",
  edit: "Editing",
  search: "Searching",
  execute: "Running",
  fetch: "Fetching",
  think: "Thinking",
  task: "Subagent",
  todo: "Updating tasks",
  other: "Using tool",
};

const ACTIVITY_CLOCK_INTERVAL_MS = 1_000;
const ACTIVITY_CLOCK_REGISTRY_LIMIT = 128;
const activityStartedAt = new Map<string, number>();

function activityStartedAtFor(clusterId: string, now: number): number {
  const existing = activityStartedAt.get(clusterId);
  if (existing !== undefined) return existing;
  if (activityStartedAt.size >= ACTIVITY_CLOCK_REGISTRY_LIMIT) {
    const oldest = activityStartedAt.keys().next().value;
    if (oldest !== undefined) activityStartedAt.delete(oldest);
  }
  activityStartedAt.set(clusterId, now);
  return now;
}

/** Compact, stable duration used by the live activity clock. */
export function formatActivityElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  if (totalMinutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Providers can remain silent while they reason. Keep the UI observably alive
 * without presenting a local timer tick as a new provider update.
 */
function useActivityElapsed(clusterId: string, active: boolean): string | null {
  const startedAt = useMemo(
    () => activityStartedAtFor(clusterId, Date.now()),
    [clusterId],
  );
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), ACTIVITY_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, startedAt]);

  return active ? formatActivityElapsed(now - startedAt) : null;
}

function iconPath(kind: ToolKind): ReactNode {
  switch (kind) {
    case "execute":
      return <path d="m4 6 3 3-3 3m5 0h5" />;
    case "edit":
      return <path d="m4 13 .8-3.1L12.7 2l3.3 3.3-7.9 7.9L5 14zm7.5-9.8 3.3 3.3" />;
    case "read":
      return <path d="M3 3.5h5l1.3 1.7H17v9.3H3zM6 8h8M6 11h6" />;
    case "search":
      return <path d="M8.2 3a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 8.2 3Zm4 9.2L17 17" />;
    case "fetch":
      return <path d="M9 2.5v10m-3.5-3L9 13l3.5-3.5M3 16h12" />;
    case "task":
      return (
        <>
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="13.5" cy="11.5" r="2.2" />
          <path d="M7.8 7.3 11.7 10M3 15c.5-2.3 1.7-3.5 3.4-3.5" />
        </>
      );
    case "todo":
      return <path d="m3 5 1.4 1.4L7 3.8M9 5h6M3 11l1.4 1.4L7 9.8M9 11h6" />;
    case "think":
      return <path d="M9 2.5a5.2 5.2 0 0 0-3.2 9.3V15h6.4v-3.2A5.2 5.2 0 0 0 9 2.5ZM6.5 17h5" />;
    default:
      return (
        <>
          <circle cx="9" cy="9" r="6" />
          <path d="M9 6v3.5M9 12.5h.01" />
        </>
      );
  }
}

export function ToolIcon({ kind }: { kind: ToolKind }) {
  return (
    <svg className="official-tool-icon" viewBox="0 0 18 18" aria-hidden="true">
      {iconPath(kind)}
    </svg>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`official-chevron${open ? " is-open" : ""}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="m5 6 3 3 3-3" />
    </svg>
  );
}

const DISCLOSURE_EXIT_MS = 240;

function AnimatedDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), DISCLOSURE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  if (!present) return null;
  return (
    <div
      className={`official-disclosure ${open ? "is-open" : "is-closing"}`}
    >
      <div className="official-disclosure-inner">{children}</div>
    </div>
  );
}

function ToolErrorMark() {
  return (
    <span className="official-tool-error" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <path d="M8 2.25 13.75 8 8 13.75 2.25 8Z" />
        <path d="M8 5.1v4.1" />
        <circle cx="8" cy="11.2" r=".65" />
      </svg>
    </span>
  );
}

export function traceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function traceSummary(text: string, fallback = "Thinking"): string {
  const lines = traceLines(text);
  const source = lines[lines.length - 1] ?? fallback;
  const cleaned = source.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "");
  return cleaned.length > 132 ? `${cleaned.slice(0, 129).trimEnd()}…` : cleaned;
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openUrl(href).catch((error) => {
          console.warn("failed to open agent link", href, error);
        });
      }}
    >
      {children}
    </a>
  );
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const token =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<]+|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const value = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (value.startsWith("`")) {
      nodes.push(<code key={key}>{value.slice(1, -1)}</code>);
    } else if (value.startsWith("**") || value.startsWith("__")) {
      nodes.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    } else if (value.startsWith("[")) {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(value);
      nodes.push(
        link ? (
          <ExternalLink key={key} href={link[2]}>
            {link[1]}
          </ExternalLink>
        ) : (
          value
        ),
      );
    } else if (/^https?:\/\//.test(value)) {
      const trailing = /[),.;:!?]+$/.exec(value)?.[0] ?? "";
      const href = trailing ? value.slice(0, -trailing.length) : value;
      nodes.push(
        <ExternalLink key={key} href={href}>
          {href}
        </ExternalLink>,
      );
      if (trailing) nodes.push(trailing);
    } else {
      nodes.push(<em key={key}>{value.slice(1, -1)}</em>);
    }
    cursor = match.index + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function paragraphLines(lines: string[], key: string): ReactNode {
  return (
    <p key={key}>
      {lines.map((line, index) => (
        <span key={`${key}-${index}`}>
          {index > 0 && <br />}
          {inlineMarkdown(line, `${key}-${index}`)}
        </span>
      ))}
    </p>
  );
}

type TableAlignment = "left" | "center" | "right" | undefined;

function tableCells(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "`") {
      inCode = !inCode;
      cell += character;
    } else if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableDelimiter(line: string): TableAlignment[] | null {
  const cells = tableCells(line);
  if (cells.length === 0 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return false;
  const header = tableCells(lines[index]);
  const alignment = tableDelimiter(lines[index + 1]);
  return Boolean(alignment && header.length === alignment.length);
}

/**
 * Safe, deliberately small Markdown renderer for streamed agent prose. It
 * covers the structures coding agents actually emit without injecting HTML.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([\w.+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} data-language={fence[1] || undefined}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(
        <Tag key={`heading-${index}`}>
          {inlineMarkdown(heading[2], `heading-${index}`)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const header = tableCells(line);
      const alignment = tableDelimiter(lines[index + 1])!;
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const row = tableCells(lines[index]);
        if (row.length !== header.length) break;
        rows.push(row);
        index += 1;
      }
      blocks.push(
        <div
          className="official-markdown-table-wrap"
          key={`table-${index}`}
          role="region"
          aria-label="Scrollable table"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex} style={{ textAlign: alignment[cellIndex] }}>
                    {inlineMarkdown(cell, `table-${index}-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: alignment[cellIndex] }}>
                      {inlineMarkdown(cell, `table-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const entries: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        entries.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`}>
          {entries.map((entry, entryIndex) => (
            <li key={entryIndex}>{inlineMarkdown(entry, `ul-${index}-${entryIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const orderedListItem = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (orderedListItem) {
      const entries: string[] = [];
      const start = Number(orderedListItem[1]);
      while (index < lines.length) {
        const entry = /^\s*(\d+)[.)]\s+(.+)$/.exec(lines[index]);
        if (!entry) break;
        entries.push(entry[2]);
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} start={start === 1 ? undefined : start}>
          {entries.map((entry, entryIndex) => (
            <li key={entryIndex}>{inlineMarkdown(entry, `ol-${index}-${entryIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {paragraphLines(quote, `quote-copy-${index}`)}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !isTableStart(lines, index) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(paragraphLines(paragraph, `paragraph-${index}`));
  }

  return <div className="official-markdown">{blocks}</div>;
});

export const MessageItem = memo(function MessageItem({
  item,
  variant,
  className,
  showStreaming,
}: {
  item: AgentItem;
  variant: OfficialVariant;
  className?: string;
  showStreaming?: boolean;
}) {
  if (item.kind === "user") {
    return (
      <div
        className={`official-user-turn${className ? ` ${className}` : ""}`}
        data-message-enter
      >
        <article className={`official-user official-user--${variant}`}>
          <AgentImageAttachments images={item.images ?? []} />
          {item.text && <p>{item.text}</p>}
        </article>
        {item.text && <MessageCopyButton text={item.text} />}
      </div>
    );
  }
  if (item.kind === "assistant") {
    const streaming = showStreaming ?? item.streaming;
    return (
      <article
        className={`official-answer official-answer--${variant}${
          streaming ? " is-streaming" : ""
        }${className ? ` ${className}` : ""}`}
        data-message-enter
      >
        <AssistantMarkdown text={item.text} />
        {streaming && <span className="official-stream-caret" aria-hidden="true" />}
      </article>
    );
  }
  if (item.kind === "notice") {
    return (
      <div
        className={`official-notice is-${item.tone}${className ? ` ${className}` : ""}`}
        data-message-enter
      >
        {item.text}
      </div>
    );
  }
  return null;
});

function completedCount(steps: AgentPlanStep[]): number {
  return steps.reduce((sum, step) => sum + (step.status === "done" ? 1 : 0), 0);
}

export const PlanTracker = memo(function PlanTracker({
  item,
  variant,
  runningSubagents = 0,
}: {
  item: PlanItem;
  variant: OfficialVariant | "cursor" | "opencode";
  runningSubagents?: number;
}) {
  const running = item.steps.find((step) => step.status === "running");
  const completed = completedCount(item.steps);
  const total = item.steps.length;
  const [open, setOpen] = useState(true);
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const isWorkflow = item.planType === "workflow";
  const label = isWorkflow ? "Workflow" : "Tasks";
  const fallbackSummary = isWorkflow
    ? completed === total
      ? "Workflow completed"
      : "Workflow progress"
    : completed === total
      ? "Tasks completed"
      : "Task plan";

  return (
    <section
      className={`official-plan official-plan--${variant}`}
      aria-label={`${label} progress`}
    >
      <button
        type="button"
        className="official-plan-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="official-plan-kicker">{label}</span>
        <span className="official-plan-summary">
          <strong>{running?.text ?? fallbackSummary}</strong>
          {runningSubagents > 0 && (
            <small>
              {runningSubagents} active{" "}
              {runningSubagents === 1 ? "subagent" : "subagents"}
            </small>
          )}
        </span>
        <span className="official-plan-count">
          {completed}/{total}
        </span>
        <Chevron open={open} />
      </button>
      <div className="official-plan-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      <AnimatedDisclosure open={open}>
        <ol className="official-plan-steps">
          {item.steps.map((step, index) => (
            <li
              key={`${index}-${step.text}`}
              className={`is-${step.status}`}
              aria-current={step.status === "running" ? "step" : undefined}
            >
              <span className="official-plan-step-mark" aria-hidden="true">
                {step.status === "done" ? (
                  "✓"
                ) : step.status === "running" ? (
                  <svg className="official-plan-running-arrow" viewBox="0 0 14 10">
                    <path d="M1.5 5h10M8 1.75 11.5 5 8 8.25" />
                  </svg>
                ) : (
                  <span className="official-plan-step-number">{index + 1}</span>
                )}
              </span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </AnimatedDisclosure>
    </section>
  );
});

function statusText(item: ToolItem): string {
  if (item.status === "error") return "Failed";
  if (item.status === "done") return "Completed";
  return item.tool === "task" ? "Working" : "Running";
}

export const ToolActivity = memo(function ToolActivity({
  item,
  variant,
  compact = false,
  expandSubagentLocally = false,
}: {
  item: ToolItem;
  variant: OfficialVariant | "cursor" | "opencode";
  compact?: boolean;
  expandSubagentLocally?: boolean;
}) {
  const { absorbedCallIds, peekedCallId, peekSubagent } = useSubagentUi();
  const isSubagent = item.tool === "task";
  const absorbed = isSubagent && !expandSubagentLocally && absorbedCallIds.has(item.callId);
  const hasOutput = item.output.trim().length > 0;
  const hasChanges = item.changes.length > 0;
  const expandable = hasOutput || hasChanges || Boolean(item.command);
  const expandsHere = !isSubagent || expandSubagentLocally;
  const [open, setOpen] = useState(
    !compact && (hasChanges || item.status === "error" || item.tool === "task"),
  );

  useEffect(() => {
    if (hasChanges && !compact) setOpen(true);
  }, [compact, hasChanges]);

  const insertions = useMemo(
    () => item.changes.reduce((sum, change) => sum + change.insertions, 0),
    [item.changes],
  );
  const deletions = useMemo(
    () => item.changes.reduce((sum, change) => sum + change.deletions, 0),
    [item.changes],
  );
  const loadingPhase = useToolLoadingPhase(item.callId, item.status);

  if (absorbed) return null;

  return (
    <section
      className={`official-tool official-tool--${variant} is-${item.status}${
        isSubagent ? " is-subagent" : ""
      }${peekedCallId === item.callId ? " is-selected" : ""}${
        compact ? " is-compact" : ""
      }${open && expandsHere ? " is-open" : ""}${
        loadingPhase !== null ? " is-shimmering" : ""
      }`}
      {...(isSubagent ? { "data-subagent-call-id": item.callId } : {})}
    >
      <button
        type="button"
        className="official-tool-head"
        onClick={() => {
          if (isSubagent && !expandSubagentLocally) {
            peekSubagent(item.callId);
          } else if (expandable) {
            setOpen((value) => !value);
          }
        }}
        aria-expanded={expandsHere && expandable ? open : undefined}
        aria-label={
          isSubagent
            ? expandSubagentLocally
              ? `Toggle subagent details: ${item.title}`
              : `Inspect subagent: ${item.title}`
            : undefined
        }
        disabled={expandsHere && !expandable}
      >
        <span className="official-tool-mark">
          <ToolIcon kind={item.tool} />
          {loadingPhase === "indicator" && (
            <span className="official-tool-spinner" aria-hidden="true" />
          )}
        </span>
        <span className="official-tool-copy">
          {item.tool === "task" && <span className="official-tool-kicker">Subagent</span>}
          <strong>{item.title || `${TOOL_LABEL[item.tool]} with ${item.name}`}</strong>
          {!compact && <span>{statusText(item)}</span>}
        </span>
        <span className="official-tool-stats">
          {insertions > 0 && <span className="is-add">+{insertions}</span>}
          {deletions > 0 && <span className="is-del">−{deletions}</span>}
          {item.status === "done" && <span className="official-tool-done">✓</span>}
          {item.status === "error" && <ToolErrorMark />}
        </span>
        {expandable && expandsHere && <Chevron open={open} />}
      </button>
      <AnimatedDisclosure open={open && expandsHere}>
        <div className="official-tool-body">
          {item.command && (
            <pre className="official-command">
              <span aria-hidden="true">$</span>
              <code>{item.command}</code>
            </pre>
          )}
          {item.changes.map((change, index) => (
            <AgentDiff key={`${change.path}-${index}`} change={change} />
          ))}
          {hasOutput && <pre className="official-output">{item.output}</pre>}
        </div>
      </AnimatedDisclosure>
    </section>
  );
});

function ActivityPulse({
  active,
  clusterId,
}: {
  active: boolean;
  /** Stable id for this thinking wait; keeps the matrix across remounts. */
  clusterId: string;
}) {
  // Registry-backed: remounts (tab switch, pane split) must not roll a new pattern.
  const pattern = thinkingPulsePatternFor(clusterId);
  return (
    <span
      className={`agent-activity-pulse${active ? " is-active" : " is-settled"}`}
      data-motion={pattern.motion}
      data-pattern={pattern.id}
      aria-hidden="true"
    >
      {Array.from({ length: 9 }, (_, index) => {
        const step = pattern.steps[index]!;
        if (step < 0) return <span key={index} className="is-idle" />;
        return (
          <span
            key={index}
            style={
              {
                "--pulse-duration": `${pattern.durationMs}ms`,
                "--pulse-delay": `${step * pattern.stepMs}ms`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

/**
 * Inline continuity marker for the gap after an interim assistant update.
 * It is driven by the live turn status and is replaced as soon as fresh
 * reasoning or tool activity reaches the transcript.
 */
export function StillWorking({
  variant,
  clusterId,
}: {
  variant: ActivityVariant;
  clusterId: string;
}) {
  const message = preparingMessageFor(clusterId);
  const elapsed = useActivityElapsed(clusterId, variant === "chatgpt");
  const activeDuration = elapsed === null ? null : `Working · ${elapsed}`;

  return (
    <div
      className="agent-activity-cluster agent-still-working"
      data-variant={variant}
      role="status"
      aria-label={activeDuration ? `${message}. ${activeDuration}` : message}
    >
      <div className="agent-activity-history is-thinking is-active">
        <div className="agent-activity-history-head">
          <ActivityPulse active clusterId={clusterId} />
          <span className="agent-activity-history-label">{message}</span>
          {activeDuration && (
            <span className="agent-activity-history-status" role="timer">
              {activeDuration}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function activityStatus(item: ToolItem): string {
  if (item.status === "error") return "Failed";
  if (item.status === "done") return "Completed";
  if (item.status === "pending") return "Queued";
  return "Running";
}

function ThinkingHistory({
  thoughts,
  working,
  showLatestFull,
  showElapsed,
  clusterId,
}: {
  thoughts: ThinkingItem[];
  working: boolean;
  showLatestFull: boolean;
  showElapsed: boolean;
  /** Stable id for this thinking wait; keeps pulse + preparing line across remounts. */
  clusterId: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const latest = showLatestFull ? thoughts[thoughts.length - 1] : undefined;
  const active = working;
  const earlierThoughts = showLatestFull ? thoughts.slice(0, -1) : thoughts;
  const expandable = earlierThoughts.length > 0;
  const showPreparingSummary = !latest && thoughts.length === 0;
  // Registry-backed like the pulse: a fresh preparing cluster gets a new line;
  // remounts during the same wait keep the same stand-in text.
  const preparingMessage = showPreparingSummary ? preparingMessageFor(clusterId) : null;
  const headline = thinkingHeadlineFor(clusterId, {
    working: active,
    hasLatest: Boolean(latest),
  });
  const elapsed = useActivityElapsed(clusterId, active && showElapsed);
  const activeDuration = elapsed === null ? null : `Working · ${elapsed}`;
  const accessibleHeadline = latest
    ? `${headline}: ${traceSummary(latest.text)}`
    : headline;

  return (
    <section
      className={`agent-activity-history is-thinking${open ? " is-open" : ""}${
        active ? " is-active" : ""
      }`}
    >
      <button
        type="button"
        className="agent-activity-history-head"
        onClick={() => expandable && setOpen((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        aria-label={
          activeDuration ? `${accessibleHeadline}. ${activeDuration}` : accessibleHeadline
        }
      >
        <ActivityPulse active={active} clusterId={clusterId} />
        <span className="agent-activity-history-label">{headline}</span>
        {showPreparingSummary && preparingMessage && (
          <span className="agent-activity-history-summary agent-thinking-shimmer">
            {preparingMessage}
          </span>
        )}
        {activeDuration && (
          <span className="agent-activity-history-status" role="timer">
            {activeDuration}
          </span>
        )}
        {expandable && <Chevron open={open} />}
      </button>
      {latest && (
        <div
          className={`agent-thinking-latest${latest.streaming ? " is-streaming" : ""}`}
          aria-label="Latest thinking trace"
        >
          <AssistantMarkdown text={latest.text} />
        </div>
      )}
      <AnimatedDisclosure open={open}>
        <ol
          id={panelId}
          className="agent-thinking-history-list"
          aria-label="Thinking trace history"
        >
          {earlierThoughts.map((item, index) => (
            <li
              key={item.id}
              className={`agent-thinking-history-item${item.streaming ? " is-streaming" : ""}`}
            >
              <span className="agent-thinking-history-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <AssistantMarkdown text={item.text} />
            </li>
          ))}
        </ol>
      </AnimatedDisclosure>
    </section>
  );
}

function ToolHistory({
  tools,
  variant,
  showLatestDiff,
}: {
  tools: ToolItem[];
  variant: ActivityVariant;
  showLatestDiff: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const latest = tools[tools.length - 1];
  const loadingPhase = useToolLoadingPhase(latest?.callId ?? "", latest?.status ?? "done");
  if (!latest) return null;
  const running = latest.status === "running" || latest.status === "pending";
  // The CLI prints each edit's diff as it happens; the same live feel here is
  // the newest changed file pinned under the head while history stays folded.
  let latestChanged: ToolItem | undefined;
  if (showLatestDiff) {
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      if (tools[index].changes.length > 0) {
        latestChanged = tools[index];
        break;
      }
    }
  }
  const insertions = tools.reduce(
    (sum, tool) => sum + tool.changes.reduce((total, change) => total + change.insertions, 0),
    0,
  );
  const deletions = tools.reduce(
    (sum, tool) => sum + tool.changes.reduce((total, change) => total + change.deletions, 0),
    0,
  );

  return (
    <section
      className={`agent-activity-history is-tools${open ? " is-open" : ""}${
        running ? " is-active" : ""
      }${latest.status === "error" ? " is-error" : ""}${
        loadingPhase !== null ? " is-shimmering" : ""
      }`}
    >
      <button
        type="button"
        className="agent-activity-history-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${tools.length === 1 ? "Tool call" : `${tools.length} tool calls`}: ${latest.title || latest.name}, ${activityStatus(latest)}`}
      >
        <span className="official-tool-mark">
          <ToolIcon kind={latest.tool} />
          {loadingPhase === "indicator" && (
            <span className="official-tool-spinner" aria-hidden="true" />
          )}
        </span>
        <span className="agent-activity-history-label">
          {tools.length === 1 ? "Tool call" : `${tools.length} tool calls`}
        </span>
        <strong className="agent-activity-history-summary">{latest.title || latest.name}</strong>
        <span className="agent-activity-history-status">{activityStatus(latest)}</span>
        {(insertions > 0 || deletions > 0) && (
          <span className="official-tool-stats">
            {insertions > 0 && <span className="is-add">+{insertions}</span>}
            {deletions > 0 && <span className="is-del">−{deletions}</span>}
          </span>
        )}
        {latest.status === "done" && <span className="official-tool-done">✓</span>}
        {latest.status === "error" && <ToolErrorMark />}
        <Chevron open={open} />
      </button>
      {latestChanged && (
        <div className="agent-tool-latest-diff" aria-label="Latest file changes">
          {latestChanged.changes.map((change, index) => (
            <AgentDiff key={`${change.path}-${index}`} change={change} />
          ))}
        </div>
      )}
      <AnimatedDisclosure open={open}>
        <div
          id={panelId}
          className="agent-tool-history-list"
          role="list"
          aria-label="Tool call history"
        >
          {tools.map((tool) => (
            <div key={tool.id} role="listitem">
              <ToolActivity item={tool} variant={variant} compact />
            </div>
          ))}
        </div>
      </AnimatedDisclosure>
    </section>
  );
}

/**
 * One compact activity area per user turn. The newest thought and tool call
 * remain visible while their complete histories stay one click away.
 */
export const ActivityHistory = memo(function ActivityHistory({
  activities,
  variant,
  working = false,
  showLatestThinking = true,
  clusterId,
}: {
  activities: Array<ThinkingItem | ToolItem>;
  variant: ActivityVariant;
  working?: boolean;
  showLatestThinking?: boolean;
  /**
   * Stable id for this activity phase (terminal + group/phase). Survives tab
   * remounts, but a new user prompt, interim agent message, or session starts a
   * fresh phase and draws a new matrix pattern.
   */
  clusterId: string;
}) {
  const { absorbedCallIds, rosterAnchorIds } = useSubagentUi();
  const thoughts = activities.filter(
    (item): item is ThinkingItem => item.kind === "thinking",
  );
  const tools = activities.filter(
    (item): item is ToolItem =>
      item.kind === "tool" && !absorbedCallIds.has(item.callId),
  );
  const rosterAnchorId = activities.find(
    (item) => item.kind === "tool" && rosterAnchorIds.has(item.id),
  )?.id;

  if (!thoughts.length && !tools.length && !rosterAnchorId && !working) return null;

  return (
    <div className="agent-activity-cluster" data-variant={variant}>
      {(thoughts.length > 0 || working) && (
        <ThinkingHistory
          thoughts={thoughts}
          working={working}
          showLatestFull={showLatestThinking}
          showElapsed={variant === "chatgpt"}
          clusterId={clusterId}
        />
      )}
      {rosterAnchorId && <SubagentBoardAnchor itemId={rosterAnchorId} />}
      {tools.length > 0 && (
        <ToolHistory tools={tools} variant={variant} showLatestDiff={showLatestThinking} />
      )}
    </div>
  );
}, (previous, next) => {
  if (
    previous.variant !== next.variant ||
    previous.working !== next.working ||
    previous.showLatestThinking !== next.showLatestThinking ||
    previous.clusterId !== next.clusterId ||
    previous.activities.length !== next.activities.length
  ) {
    return false;
  }
  return previous.activities.every(
    (activity, index) => activity === next.activities[index],
  );
});

export function ProviderEmpty({
  agent,
  termId,
  label,
  program,
  cwd,
  status,
}: Pick<ExperienceProps, "agent" | "termId" | "label" | "program" | "cwd" | "status">) {
  const starting = status === "starting";
  return (
    <div className={`official-empty${starting ? " is-starting" : ""}`}>
      <span className="official-empty-mark" aria-hidden="true">
        <AgentProviderIcon agent={agent} program={program} />
      </span>
      <strong>{label}</strong>
      {/* Claude Code has no handshake to wait on, so a starting-only animation
          would never be seen there. The art stays; only the progress
          affordances are tied to the handshake. */}
      <AgentAsciiLoader
        agent={agent}
        termId={termId}
        label="Starting session"
        progress={starting}
      />
      {!starting && (
        <span>Describe what you want changed and it will work in this folder.</span>
      )}
      <code>{cwd}</code>
    </div>
  );
}

export function latestPlan(items: AgentItem[]): PlanItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === "plan") return items[index] as PlanItem;
  }
  return null;
}

export function activityItems(items: AgentItem[]): Array<ToolItem | Extract<AgentItem, { kind: "thinking" }>> {
  return items.filter(
    (item): item is ToolItem | Extract<AgentItem, { kind: "thinking" }> =>
      item.kind === "tool" || item.kind === "thinking",
  );
}

/**
 * Present short assistant updates as thinking traces while preserving the last
 * assistant item of every completed turn as its final response.
 *
 * Providers do not consistently distinguish commentary from the final answer
 * on the wire. While the newest turn is running, its short assistant items can
 * therefore be treated as activity. Once the turn settles, its last response
 * remains a response regardless of length.
 */
export function shortAssistantUpdatesAsThinking(
  items: AgentItem[],
  working: boolean,
  maxCharacters: number,
): AgentItem[] {
  const finalResponseIds = new Set<string>();
  let turnStart = 0;

  const preserveLastResponse = (start: number, end: number) => {
    for (let index = end - 1; index >= start; index -= 1) {
      const item = items[index];
      if (item.kind === "assistant" && hasVisibleText(item.text)) {
        finalResponseIds.add(item.id);
        return;
      }
    }
  };

  for (let index = 1; index < items.length; index += 1) {
    if (items[index].kind !== "user") continue;
    preserveLastResponse(turnStart, index);
    turnStart = index;
  }
  if (!working) preserveLastResponse(turnStart, items.length);

  return items.map((item) => {
    if (
      item.kind !== "assistant" ||
      finalResponseIds.has(item.id) ||
      !hasVisibleText(item.text) ||
      exceedsCodePointLimit(item.text, maxCharacters)
    ) {
      return item;
    }
    return assistantAsThinking(item);
  });
}

type AssistantItem = Extract<AgentItem, { kind: "assistant" }>;

const thinkingItemCache = new WeakMap<AssistantItem, ThinkingItem>();

/** Keep settled converted items referentially stable across streaming renders. */
function assistantAsThinking(item: AssistantItem): ThinkingItem {
  const cached = thinkingItemCache.get(item);
  if (cached) return cached;
  const thinking: ThinkingItem = { ...item, kind: "thinking" };
  thinkingItemCache.set(item, thinking);
  return thinking;
}

/** Check only as far as the threshold instead of allocating every code point. */
function exceedsCodePointLimit(text: string, limit: number): boolean {
  let count = 0;
  for (const _character of text) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

/** Avoid copying long strings just to decide whether they contain content. */
function hasVisibleText(text: string): boolean {
  return /\S/.test(text);
}

export interface ActivityGroup {
  firstId: string;
  firstIndex: number;
  activities: Array<ToolItem | Extract<AgentItem, { kind: "thinking" }>>;
  /** Final assistant answer, only when no later activity follows it. */
  answerId: string | null;
  /** Interim comment that replaces this completed activity phase. */
  replacedByCommentId: string | null;
}

/**
 * Thinking/tool chrome hides behind a later comment or the live answer.
 * Delegated workers still need their roster, so callers should render the
 * board from {@link ActivityGroup.activities} when this is true.
 */
export function activityClusterHiddenByComment(
  group: ActivityGroup,
  working: boolean,
  liveGroup: ActivityGroup | undefined,
): boolean {
  return Boolean(
    group.replacedByCommentId ||
      (working && group === liveGroup && group.answerId),
  );
}

/**
 * Keep reasoning/tool activity scoped to the user turn and the assistant
 * comment that preceded it. A comment followed by more work starts a fresh
 * activity group below that comment instead of pulling future work upward.
 */
export function activityGroups(items: AgentItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let turnStart = 0;

  const collectTurn = (start: number, end: number) => {
    let activity: Array<{
      item: ToolItem | Extract<AgentItem, { kind: "thinking" }>;
      index: number;
    }> = [];

    const flush = (
      answerId: string | null,
      replacedByCommentId: string | null = null,
    ) => {
      if (!activity.length) return;
      groups.push({
        firstId: activity[0].item.id,
        firstIndex: activity[0].index,
        activities: activity.map(({ item }) => item),
        answerId,
        replacedByCommentId,
      });
      activity = [];
    };

    let lastActivityIndex = -1;
    for (let index = end - 1; index >= start; index -= 1) {
      const item = items[index];
      if (item.kind === "thinking" || item.kind === "tool") {
        lastActivityIndex = index;
        break;
      }
    }

    for (let index = start; index < end; index += 1) {
      const item = items[index];
      if (item.kind === "thinking" || item.kind === "tool") {
        activity.push({ item, index });
        continue;
      }
      if (item.kind !== "assistant" || !activity.length) continue;
      if (index < lastActivityIndex) {
        flush(null, item.id);
      } else {
        flush(item.id);
      }
    }
    flush(null);
  };

  for (let index = 1; index < items.length; index += 1) {
    if (items[index].kind !== "user") continue;
    collectTurn(turnStart, index);
    turnStart = index;
  }
  collectTurn(turnStart, items.length);
  return groups;
}

/** Assistant comments that are followed by more work in the same user turn. */
export function continuedAssistantIds(items: AgentItem[]): Set<string> {
  const ids = new Set<string>();
  let turnEnd = items.length;

  const inspectTurn = (start: number, end: number) => {
    let hasLaterActivity = false;
    for (let index = end - 1; index >= start; index -= 1) {
      const item = items[index];
      if (item.kind === "thinking" || item.kind === "tool") {
        hasLaterActivity = true;
      } else if (item.kind === "assistant" && hasLaterActivity) {
        ids.add(item.id);
      }
    }
  };

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind !== "user") continue;
    inspectTurn(index, turnEnd);
    turnEnd = index;
  }
  if (turnEnd > 0) inspectTurn(0, turnEnd);
  return ids;
}

/** Only the newest, still-current assistant block receives a streaming caret. */
export function activeAssistantId(
  items: AgentItem[],
  working: boolean,
): string | null {
  if (!working) return null;
  const latest = items[items.length - 1];
  return latest?.kind === "assistant" && latest.streaming ? latest.id : null;
}
