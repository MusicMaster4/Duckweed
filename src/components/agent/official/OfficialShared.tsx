import { useEffect, useMemo, useState, type ReactNode, type Ref } from "react";

import type {
  AgentItem,
  AgentPlanStep,
  AgentSessionState,
  PlanItem,
  ToolItem,
  ToolKind,
} from "../../../lib/agents/types";
import { AgentDiff } from "../AgentDiff";

export interface ExperienceProps {
  items: AgentItem[];
  agent: AgentSessionState["agent"];
  status: AgentSessionState["status"];
  started: boolean;
  label: string;
  mark: string;
  cwd: string;
}

export type OfficialVariant = "chatgpt" | "claude" | "grok";

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

export function MessageItem({
  item,
  variant,
  className,
  elementRef,
}: {
  item: AgentItem;
  variant: OfficialVariant;
  className?: string;
  elementRef?: Ref<HTMLElement>;
}) {
  if (item.kind === "user") {
    return (
      <article
        ref={elementRef}
        className={`official-user official-user--${variant}${className ? ` ${className}` : ""}`}
      >
        <p>{item.text}</p>
      </article>
    );
  }
  if (item.kind === "assistant") {
    return (
      <article
        ref={elementRef}
        className={`official-answer official-answer--${variant}${
          item.streaming ? " is-streaming" : ""
        }${className ? ` ${className}` : ""}`}
      >
        {item.text}
        {item.streaming && <span className="official-stream-caret" aria-hidden="true" />}
      </article>
    );
  }
  if (item.kind === "notice") {
    return (
      <div
        ref={elementRef as Ref<HTMLDivElement>}
        className={`official-notice is-${item.tone}${className ? ` ${className}` : ""}`}
      >
        {item.text}
      </div>
    );
  }
  return null;
}

function completedCount(steps: AgentPlanStep[]): number {
  return steps.reduce((sum, step) => sum + (step.status === "done" ? 1 : 0), 0);
}

export function PlanTracker({
  item,
  variant,
}: {
  item: PlanItem;
  variant: OfficialVariant | "cursor" | "opencode";
}) {
  const running = item.steps.find((step) => step.status === "running");
  const completed = completedCount(item.steps);
  const total = item.steps.length;
  const [open, setOpen] = useState(true);
  const progress = total ? Math.round((completed / total) * 100) : 0;

  return (
    <section className={`official-plan official-plan--${variant}`} aria-label="Task progress">
      <button
        type="button"
        className="official-plan-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="official-plan-kicker">Workflow</span>
        <strong>{running?.text ?? (completed === total ? "Tasks completed" : "Task plan")}</strong>
        <span className="official-plan-count">
          {completed}/{total}
        </span>
        <Chevron open={open} />
      </button>
      <div className="official-plan-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      {open && (
        <ol className="official-plan-steps">
          {item.steps.map((step, index) => (
            <li key={`${index}-${step.text}`} className={`is-${step.status}`}>
              <span className="official-plan-step-mark" aria-hidden="true">
                {step.status === "done" ? "✓" : step.status === "running" ? "" : index + 1}
              </span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function statusText(item: ToolItem): string {
  if (item.status === "error") return "Failed";
  if (item.status === "done") return "Completed";
  return item.tool === "task" ? "Working" : "Running";
}

export function ToolActivity({
  item,
  variant,
  compact = false,
}: {
  item: ToolItem;
  variant: OfficialVariant | "cursor" | "opencode";
  compact?: boolean;
}) {
  const hasOutput = item.output.trim().length > 0;
  const hasChanges = item.changes.length > 0;
  const expandable = hasOutput || hasChanges || Boolean(item.command);
  const [open, setOpen] = useState(hasChanges || item.status === "error" || item.tool === "task");

  useEffect(() => {
    if (hasChanges) setOpen(true);
  }, [hasChanges]);

  const insertions = useMemo(
    () => item.changes.reduce((sum, change) => sum + change.insertions, 0),
    [item.changes],
  );
  const deletions = useMemo(
    () => item.changes.reduce((sum, change) => sum + change.deletions, 0),
    [item.changes],
  );

  return (
    <section
      className={`official-tool official-tool--${variant} is-${item.status}${
        item.tool === "task" ? " is-subagent" : ""
      }${compact ? " is-compact" : ""}${open ? " is-open" : ""}`}
    >
      <button
        type="button"
        className="official-tool-head"
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="official-tool-mark">
          <ToolIcon kind={item.tool} />
          {(item.status === "running" || item.status === "pending") && (
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
          {item.status === "error" && <span className="official-tool-error">!</span>}
        </span>
        {expandable && <Chevron open={open} />}
      </button>
      {open && (
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
      )}
    </section>
  );
}

export function ProviderEmpty({
  label,
  mark,
  cwd,
  status,
  loader,
}: Pick<ExperienceProps, "label" | "mark" | "cwd" | "status"> & { loader: ReactNode }) {
  const starting = status === "starting";
  return (
    <div className={`official-empty${starting ? " is-starting" : ""}`}>
      <span className="official-empty-mark" aria-hidden="true">
        {mark}
      </span>
      <strong>{label}</strong>
      {starting ? loader : <span>Describe what you want changed and it will work in this folder.</span>}
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
