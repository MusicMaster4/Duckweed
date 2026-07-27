import { memo, useMemo, useState } from "react";

import type { AgentItem, ToolItem, ToolStatus } from "../../../lib/agents/types";
import { AgentAsciiLoader } from "../AgentAsciiLoader";
import { AssistantMarkdown } from "../official/OfficialShared";
import { ChangeSet, Disclosure, ScreenReaderText, useTicker } from "./ProviderExperienceParts";
import {
  activitySummary,
  basename,
  formatElapsed,
  phaseOf,
  planSummary,
  tailLine,
  turnStart,
  type PhaseKind,
  type PlanSummary,
  type ProviderExperienceProps,
} from "./providerExperience";
import "./ProviderExperience.css";

/**
 * Cursor Agent's surface.
 *
 * Cursor ships no web transcript to imitate, so this is drawn from what the
 * agent actually is: a precise, graph-shaped worker that runs commands and
 * edits files. The transcript is a single rail with a node per event — an
 * editorial spine you can scan without reading — and everything hangs off it in
 * one column, command first. Colour is spent only on state: warm while
 * something runs, sage when it lands, rose when it does not.
 *
 * It stays Duckweed: the same near-black green surfaces, hairline borders,
 * monospaced density, and sage/rose diff colours as the rest of the app.
 */

const PHASE_WORD: Record<PhaseKind, string> = {
  starting: "Connecting",
  ready: "Ready",
  thinking: "Reasoning",
  writing: "Composing",
  tool: "Executing",
  waiting: "Waiting on you",
  ended: "Session ended",
  failed: "Failed",
};

/** Node shape per event family — the rail is readable before the text is. */
type MarkKind = "user" | "say" | "think" | "plan" | "tool" | "edit" | "agent" | "note";

function markFor(item: AgentItem): MarkKind {
  switch (item.kind) {
    case "user":
      return "user";
    case "assistant":
      return "say";
    case "thinking":
      return "think";
    case "plan":
      return "plan";
    case "notice":
      return "note";
    case "tool":
      return item.tool === "task" ? "agent" : item.tool === "edit" ? "edit" : "tool";
  }
}

/**
 * The scan motif: a thin ring, one arc sweeping it, a core that breathes.
 *
 * The arc is the only moving part at rest scale — a spinner would say "busy"
 * and nothing else, while the arc plus the scan line reads as *looking at
 * something*, which is what the agent is doing between tool calls.
 */
function CursorOrbit({ phase, large }: { phase: PhaseKind; large?: boolean }) {
  return (
    <svg
      className={`cx-orbit${large ? " is-large" : ""}`}
      data-phase={phase}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="cx-orbit-ring" cx="12" cy="12" r="8.5" />
      <path className="cx-orbit-arc" d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
      <line className="cx-orbit-scan" x1="6.5" y1="12" x2="17.5" y2="12" />
      <circle className="cx-orbit-core" cx="12" cy="12" r="2.1" />
    </svg>
  );
}

function CursorStatus({ status, elapsed }: { status: ToolStatus; elapsed: string | null }) {
  const label =
    status === "running"
      ? "running"
      : status === "pending"
        ? "queued"
        : status === "error"
          ? "failed"
          : "done";
  return (
    <span className={`cx-status is-${status}`}>
      {elapsed && <span className="cx-status-time">{elapsed}</span>}
      {status === "running" || status === "pending" ? (
        <span className="cx-status-scan" aria-hidden="true">
          <span />
        </span>
      ) : (
        <span className="cx-status-glyph" aria-hidden="true">
          {status === "error" ? "✕" : "✓"}
        </span>
      )}
      <ScreenReaderText>{label}</ScreenReaderText>
    </span>
  );
}

/** Completed / total, as a rail of ticks — one per step, in order. */
function CursorTracker({ plan }: { plan: PlanSummary }) {
  const current = plan.active ?? plan.next;
  return (
    <div className="cx-track">
      <span className="cx-track-label">Tasks</span>
      <span
        className="cx-track-rail"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={plan.total}
        aria-valuenow={plan.done}
        aria-label={`${plan.done} of ${plan.total} tasks complete`}
      >
        {plan.steps.map((step, index) => (
          <span key={index} className={`cx-track-tick is-${step.status}`} aria-hidden="true" />
        ))}
      </span>
      <span className="cx-track-count">
        {plan.done}/{plan.total}
      </span>
      {current && (
        <span className={`cx-track-active${plan.active ? " is-live" : ""}`}>
          {plan.active ? current.text : `next · ${current.text}`}
        </span>
      )}
    </div>
  );
}

function CursorThinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cx-think${streaming ? " is-streaming" : ""}`}>
      <Disclosure
        open={open}
        onToggle={() => setOpen(!open)}
        className="cx-think-head"
        panelClassName="cx-think-body"
        head={
          <>
            <span className="cx-think-label">Reasoning</span>
            {!open && <span className="cx-think-peek">{tailLine(text)}</span>}
            <span className="cx-chevron" aria-hidden="true" data-open={open} />
          </>
        }
      >
        <div className="cx-think-text">{text}</div>
      </Disclosure>
    </div>
  );
}

/**
 * A delegated turn.
 *
 * `task` calls are the only thing either agent says about work it handed to
 * another agent, so the row is built to carry that alone: its own inset rail,
 * its own live marker, and the sub-agent's output folded behind it.
 */
function CursorSubagent({ item, elapsed }: { item: ToolItem; elapsed: string | null }) {
  const hasOutput = item.output.trim().length > 0;
  const [open, setOpen] = useState(item.status === "error");
  const head = (
    <>
      <span className="cx-sub-tag">Subagent</span>
      <span className="cx-sub-title">{item.title}</span>
      {hasOutput && <span className="cx-chevron" aria-hidden="true" data-open={open} />}
      <CursorStatus status={item.status} elapsed={elapsed} />
    </>
  );
  return (
    <div className={`cx-sub is-${item.status}`}>
      {hasOutput ? (
        <Disclosure
          open={open}
          onToggle={() => setOpen(!open)}
          className="cx-sub-head"
          panelClassName="cx-sub-panel"
          head={head}
          label={`Subagent: ${item.title}`}
        >
          <pre className="cx-output">{item.output}</pre>
        </Disclosure>
      ) : (
        <div className="cx-sub-head is-static">{head}</div>
      )}
      <ChangeSet changes={item.changes} className="cx-changes" />
    </div>
  );
}

function CursorTool({ item, elapsed }: { item: ToolItem; elapsed: string | null }) {
  const hasOutput = item.output.trim().length > 0;
  const hasChanges = item.changes.length > 0;
  // Edits are the work, so they open themselves; output is noise until a call
  // fails. Same rule the shared timeline uses — a Cursor session should not
  // fold different things than a Claude one.
  const [open, setOpen] = useState(hasChanges || item.status === "error");
  const expandable = hasOutput || hasChanges;
  const command = item.tool === "execute" ? (item.command ?? item.title) : null;
  const insertions = item.changes.reduce((sum, change) => sum + change.insertions, 0);
  const deletions = item.changes.reduce((sum, change) => sum + change.deletions, 0);

  const head = (
    <>
      {command ? (
        <>
          <span className="cx-prompt" aria-hidden="true">
            ❯
          </span>
          <code className="cx-command">{command}</code>
        </>
      ) : (
        <>
          <span className="cx-kind">{item.tool === "other" ? item.name : item.tool}</span>
          <span className="cx-title">{item.title}</span>
        </>
      )}
      {insertions > 0 && <span className="cx-add">+{insertions}</span>}
      {deletions > 0 && <span className="cx-del">−{deletions}</span>}
      {expandable && <span className="cx-chevron" aria-hidden="true" data-open={open} />}
      <CursorStatus status={item.status} elapsed={elapsed} />
    </>
  );

  return (
    <div className={`cx-row is-${item.status}${command ? " is-command" : ""}`}>
      {expandable ? (
        <Disclosure
          open={open}
          onToggle={() => setOpen(!open)}
          className="cx-row-head"
          panelClassName="cx-row-panel"
          head={head}
          label={command ?? item.title}
        >
          <>
            <ChangeSet changes={item.changes} className="cx-changes" />
            {hasOutput && <pre className="cx-output">{item.output}</pre>}
          </>
        </Disclosure>
      ) : (
        <div className="cx-row-head is-static">{head}</div>
      )}
    </div>
  );
}

/**
 * The workflow the agent is following.
 *
 * Numbered, because a plan is ordered and a checkbox list does not say so; the
 * running step keeps the only bright text in the block.
 */
function CursorPlan({ steps }: { steps: PlanSummary["steps"] }) {
  const done = steps.filter((step) => step.status === "done").length;
  return (
    <div className="cx-plan">
      <div className="cx-plan-head">
        <span className="cx-plan-label">Workflow</span>
        <span className="cx-plan-count">
          {done}/{steps.length}
        </span>
      </div>
      <ol className="cx-plan-steps">
        {steps.map((step, index) => (
          <li
            key={index}
            className={`cx-plan-step is-${step.status}`}
            aria-current={step.status === "running" ? "step" : undefined}
          >
            <span className="cx-plan-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="cx-plan-text">{step.text}</span>
            <ScreenReaderText>{step.status}</ScreenReaderText>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One event on the rail.
 *
 * Memoised per item: a streaming turn re-renders the whole session on every
 * frame, and only the live block at the bottom has changed. `now` is handed to
 * running rows only, so a ticking clock does not invalidate finished ones.
 */
const CursorNode = memo(function CursorNode({ item, now }: { item: AgentItem; now: number }) {
  const live = item.kind === "tool" && (item.status === "running" || item.status === "pending");
  const elapsed = live && now > 0 ? formatElapsed(now - item.at) : null;

  return (
    <li className={`cx-node is-${item.kind}`} data-mark={markFor(item)} data-live={live || undefined}>
      <span className="cx-mark" aria-hidden="true" />
      <div className="cx-body">
        {item.kind === "user" && <p className="cx-said">{item.text}</p>}
        {item.kind === "assistant" && (
          <div className={`cx-prose${item.streaming ? " is-streaming" : ""}`}>
            <AssistantMarkdown text={item.text} />
          </div>
        )}
        {item.kind === "thinking" && <CursorThinking text={item.text} streaming={item.streaming} />}
        {item.kind === "plan" && <CursorPlan steps={item.steps} />}
        {item.kind === "notice" && <div className={`cx-notice is-${item.tone}`}>{item.text}</div>}
        {item.kind === "tool" &&
          (item.tool === "task" ? (
            <CursorSubagent item={item} elapsed={elapsed} />
          ) : (
            <CursorTool item={item} elapsed={elapsed} />
          ))}
      </div>
    </li>
  );
});

export function CursorExperience({ session, items, className }: ProviderExperienceProps) {
  const list = items ?? session.items;
  const plan = useMemo(() => planSummary(list), [list]);
  const activity = useMemo(() => activitySummary(list), [list]);
  const phase = phaseOf(session, list);
  const now = useTicker(phase.busy);
  const started = turnStart(list);
  const turnFor = phase.busy && started !== null ? formatElapsed(now - started) : null;
  const files = activity.files.length;

  return (
    <section className={`cx${className ? ` ${className}` : ""}`} data-phase={phase.kind}>
      {!session.started && session.status !== "error" && (
        <div className="cx-open">
          <CursorOrbit phase={phase.kind} large />
          <div className="cx-open-text">
            <strong>{session.label}</strong>
            {phase.kind === "starting" ? (
              <AgentAsciiLoader agent="cursor" label="Starting session" />
            ) : (
              <span>Describe what you want changed. It runs commands and edits files here.</span>
            )}
            <code>{session.cwd}</code>
          </div>
        </div>
      )}

      {session.started && (
        <div className="cx-hud" data-busy={phase.busy || undefined}>
          <div className="cx-hud-row">
            <CursorOrbit phase={phase.kind} />
            <span className="cx-phase" aria-live="polite">
              {PHASE_WORD[phase.kind]}
            </span>
            {phase.detail && (
              <span className="cx-phase-detail" title={phase.detail}>
                {phase.detail}
              </span>
            )}
            <span className="cx-hud-gap" />
            {turnFor && <span className="cx-hud-time">{turnFor}</span>}
            {activity.tools > 0 && (
              <span className="cx-metric" title="Tool calls this session">
                {activity.tools} {activity.tools === 1 ? "call" : "calls"}
              </span>
            )}
            {activity.subagents.length > 0 && (
              <span className="cx-metric is-agent" title="Delegated turns">
                {activity.subagents.length} sub
              </span>
            )}
            {files > 0 && (
              <span className="cx-metric" title={activity.files.map(basename).join(", ")}>
                {files} {files === 1 ? "file" : "files"}
                <span className="cx-add">+{activity.insertions}</span>
                <span className="cx-del">−{activity.deletions}</span>
              </span>
            )}
            {activity.failed > 0 && (
              <span className="cx-metric is-bad">
                {activity.failed} failed
              </span>
            )}
          </div>
          {plan && <CursorTracker plan={plan} />}
        </div>
      )}

      {list.length > 0 && (
        <ol className="cx-rail">
          {list.map((item) => (
            <CursorNode
              key={item.id}
              item={item}
              now={
                item.kind === "tool" && (item.status === "running" || item.status === "pending")
                  ? now
                  : 0
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}
