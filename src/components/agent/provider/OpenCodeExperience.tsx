import { memo, useMemo, useState } from "react";

import type { AgentItem, AgentPlanStep, ToolItem, ToolStatus } from "../../../lib/agents/types";
import { ChangeSet, Disclosure, ScreenReaderText, useTicker } from "./ProviderExperienceParts";
import {
  activitySummary,
  basename,
  formatElapsed,
  phaseOf,
  planSummary,
  splitModel,
  tailLine,
  turnStart,
  type PhaseKind,
  type PlanSummary,
  type ProviderExperienceProps,
} from "./providerExperience";
import "./ProviderExperience.css";

/**
 * OpenCode's surface.
 *
 * OpenCode is the open, bring-your-own-model agent: it runs whatever provider
 * you point it at, and its own TUI is unashamedly a terminal. So this surface
 * is built out of *lanes* rather than a conversation — consecutive work of the
 * same kind collapses into one labelled module (`exec`, `read`, `edit`), which
 * is how an OpenCode session actually reads: bursts of one activity, not an
 * alternating chat.
 *
 * It leans hardest into Duckweed's own green: sage lane tags, sage brackets,
 * a four-corner loader instead of a spinner. Nothing here is borrowed from the
 * Cursor surface — that one is a single editorial rail; this one is a stack of
 * bracketed modules.
 */

const PHASE_WORD: Record<PhaseKind, string> = {
  starting: "booting",
  ready: "idle",
  thinking: "thinking",
  writing: "streaming",
  tool: "running",
  waiting: "blocked",
  ended: "closed",
  failed: "error",
};

/** The lane an event belongs to — the gutter tag, and what merges with what. */
type Lane =
  | "you"
  | "say"
  | "think"
  | "plan"
  | "exec"
  | "edit"
  | "read"
  | "find"
  | "net"
  | "agent"
  | "tool"
  | "note";

function laneOf(item: AgentItem): Lane {
  switch (item.kind) {
    case "user":
      return "you";
    case "assistant":
      return "say";
    case "thinking":
      return "think";
    case "plan":
      return "plan";
    case "notice":
      return "note";
    case "tool":
      switch (item.tool) {
        case "execute":
          return "exec";
        case "edit":
          return "edit";
        case "read":
          return "read";
        case "search":
          return "find";
        case "fetch":
          return "net";
        case "task":
          return "agent";
        case "todo":
          return "plan";
        case "think":
          return "think";
        default:
          return "tool";
      }
  }
}

interface Module {
  lane: Lane;
  /** Stable across re-renders: the first item's id. */
  key: string;
  items: AgentItem[];
  /** Whether a following item of the same lane may join this module. */
  merges: boolean;
}

/** A call that is still going — the only thing a ticking clock is for. */
function isLive(item: AgentItem): boolean {
  return item.kind === "tool" && (item.status === "running" || item.status === "pending");
}

/**
 * Group the transcript into lane modules.
 *
 * Six reads in a row are one act, not six; folding them into a single `read`
 * module keeps a long session scannable. Prose, prompts, plans and delegated
 * turns never merge — each of those is a thing you read on its own.
 */
function toModules(items: AgentItem[]): Module[] {
  const modules: Module[] = [];
  for (const item of items) {
    const lane = laneOf(item);
    const merges = item.kind === "tool" && item.tool !== "task";
    const last = modules[modules.length - 1];
    if (last && merges && last.merges && last.lane === lane) {
      last.items.push(item);
      continue;
    }
    modules.push({ lane, key: item.id, items: [item], merges });
  }
  return modules;
}

/**
 * Four corners closing on a block.
 *
 * A ring would read as "loading a page"; brackets closing on a cursor read as
 * a terminal taking hold of something, which is what OpenCode is doing.
 */
function OpenCodeMark({ phase, large }: { phase: PhaseKind; large?: boolean }) {
  return (
    <svg
      className={`oc-mark${large ? " is-large" : ""}`}
      data-phase={phase}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <path className="oc-corner is-tl" d="M2.5 6.5v-4h4" />
      <path className="oc-corner is-tr" d="M13.5 2.5h4v4" />
      <path className="oc-corner is-br" d="M17.5 13.5v4h-4" />
      <path className="oc-corner is-bl" d="M6.5 17.5h-4v-4" />
      <rect className="oc-core" x="8" y="8" width="4" height="4" rx="0.5" />
    </svg>
  );
}

function OpenCodeStatus({ status, elapsed }: { status: ToolStatus; elapsed: string | null }) {
  const label =
    status === "running"
      ? "running"
      : status === "pending"
        ? "queued"
        : status === "error"
          ? "failed"
          : "ok";
  return (
    <span className={`oc-status is-${status}`}>
      {elapsed && <span className="oc-status-time">{elapsed}</span>}
      <span className="oc-status-glyph" aria-hidden="true">
        {status === "running" || status === "pending" ? (
          <span className="oc-status-dots">
            <span />
            <span />
            <span />
          </span>
        ) : status === "error" ? (
          "✕"
        ) : (
          "✓"
        )}
      </span>
      <ScreenReaderText>{label}</ScreenReaderText>
    </span>
  );
}

/** `[▮▮▮▯▯]` — a real bracketed meter, one cell per step. */
function OpenCodeMeter({ steps, done }: { steps: AgentPlanStep[]; done: number }) {
  return (
    <span
      className="oc-meter"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={done}
      aria-label={`${done} of ${steps.length} tasks complete`}
    >
      <span className="oc-bracket" aria-hidden="true">
        [
      </span>
      {steps.map((step, index) => (
        <span key={index} className={`oc-cell is-${step.status}`} aria-hidden="true" />
      ))}
      <span className="oc-bracket" aria-hidden="true">
        ]
      </span>
    </span>
  );
}

function OpenCodeTracker({ plan }: { plan: PlanSummary }) {
  const current = plan.active ?? plan.next;
  return (
    <div className="oc-track">
      <OpenCodeMeter steps={plan.steps} done={plan.done} />
      <span className="oc-track-count">
        {plan.done}/{plan.total} tasks
      </span>
      {current && (
        <span className={`oc-track-active${plan.active ? " is-live" : ""}`}>
          {plan.active ? current.text : `up next · ${current.text}`}
        </span>
      )}
    </div>
  );
}

function OpenCodeThinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`oc-think${streaming ? " is-streaming" : ""}`}>
      <Disclosure
        open={open}
        onToggle={() => setOpen(!open)}
        className="oc-think-head"
        panelClassName="oc-think-body"
        head={
          <>
            <OpenCodeMark phase={streaming ? "thinking" : "ready"} />
            <span className="oc-chevron" aria-hidden="true" data-open={open} />
            {open ? <span className="oc-think-label">reasoning</span> : null}
            {!open && <span className="oc-think-peek">{tailLine(text)}</span>}
          </>
        }
        label="Reasoning"
      >
        <div className="oc-think-text">{text}</div>
      </Disclosure>
    </div>
  );
}

function OpenCodePlan({ steps }: { steps: AgentPlanStep[] }) {
  const done = steps.filter((step) => step.status === "done").length;
  return (
    <div className="oc-plan">
      <div className="oc-plan-head">
        <OpenCodeMeter steps={steps} done={done} />
        <span className="oc-plan-count">
          {done}/{steps.length}
        </span>
      </div>
      <ul className="oc-plan-steps">
        {steps.map((step, index) => (
          <li
            key={index}
            className={`oc-plan-step is-${step.status}`}
            aria-current={step.status === "running" ? "step" : undefined}
          >
            <span className="oc-plan-box" aria-hidden="true">
              {step.status === "done" ? "[x]" : step.status === "running" ? "[»]" : "[ ]"}
            </span>
            <span className="oc-plan-text">{step.text}</span>
            <ScreenReaderText>{step.status}</ScreenReaderText>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A turn OpenCode handed to another agent — its `task` calls. */
function OpenCodeSubagent({ item, elapsed }: { item: ToolItem; elapsed: string | null }) {
  const hasOutput = item.output.trim().length > 0;
  const [open, setOpen] = useState(item.status === "error");
  const head = (
    <>
      <span className="oc-sub-bracket" aria-hidden="true">
        ⌈
      </span>
      <span className="oc-sub-title">{item.title}</span>
      {hasOutput && <span className="oc-chevron" aria-hidden="true" data-open={open} />}
      <OpenCodeStatus status={item.status} elapsed={elapsed} />
    </>
  );
  return (
    <div className={`oc-sub is-${item.status}`}>
      {hasOutput ? (
        <Disclosure
          open={open}
          onToggle={() => setOpen(!open)}
          className="oc-sub-head"
          panelClassName="oc-sub-panel"
          head={head}
          label={`Subagent: ${item.title}`}
        >
          <pre className="oc-output">{item.output}</pre>
        </Disclosure>
      ) : (
        <div className="oc-sub-head is-static">{head}</div>
      )}
      <ChangeSet changes={item.changes} className="oc-changes" />
    </div>
  );
}

function OpenCodeTool({ item, elapsed }: { item: ToolItem; elapsed: string | null }) {
  const hasOutput = item.output.trim().length > 0;
  const hasChanges = item.changes.length > 0;
  const [open, setOpen] = useState(hasChanges || item.status === "error");
  const expandable = hasOutput || hasChanges;
  const command = item.tool === "execute" ? (item.command ?? item.title) : null;
  const insertions = item.changes.reduce((sum, change) => sum + change.insertions, 0);
  const deletions = item.changes.reduce((sum, change) => sum + change.deletions, 0);
  // One file is the common case for an edit call, and its name beats the tool's
  // own phrasing of it. More than one, and the diffs below say it better.
  const single = item.changes.length === 1 ? item.changes[0] : null;
  // Directory only — the file name is already the loud half of the row.
  const dir = single ? single.path.slice(0, single.path.length - basename(single.path).length) : "";

  const head = (
    <>
      {command ? (
        <>
          <span className="oc-dollar" aria-hidden="true">
            $
          </span>
          <code className="oc-command">{command}</code>
        </>
      ) : (
        <>
          <span className="oc-row-title">{single ? basename(single.path) : item.title}</span>
          {dir && (
            <span className="oc-row-dir" title={single?.path}>
              {dir.replace(/[\\/]$/, "")}
            </span>
          )}
        </>
      )}
      {insertions > 0 && <span className="oc-add">+{insertions}</span>}
      {deletions > 0 && <span className="oc-del">−{deletions}</span>}
      {expandable && <span className="oc-chevron" aria-hidden="true" data-open={open} />}
      <OpenCodeStatus status={item.status} elapsed={elapsed} />
    </>
  );

  return (
    <div className={`oc-row is-${item.status}${command ? " is-command" : ""}`}>
      {expandable ? (
        <Disclosure
          open={open}
          onToggle={() => setOpen(!open)}
          className="oc-row-head"
          panelClassName="oc-row-panel"
          head={head}
          label={command ?? item.title}
        >
          <>
            <ChangeSet changes={item.changes} className="oc-changes" />
            {hasOutput && <pre className="oc-output">{item.output}</pre>}
          </>
        </Disclosure>
      ) : (
        <div className="oc-row-head is-static">{head}</div>
      )}
    </div>
  );
}

function OpenCodeItem({ item, now }: { item: AgentItem; now: number }) {
  const elapsed = isLive(item) && now > 0 ? formatElapsed(now - item.at) : null;

  switch (item.kind) {
    case "user":
      return <p className="oc-said">{item.text}</p>;
    case "assistant":
      return <div className={`oc-prose${item.streaming ? " is-streaming" : ""}`}>{item.text}</div>;
    case "thinking":
      return <OpenCodeThinking text={item.text} streaming={item.streaming} />;
    case "plan":
      return <OpenCodePlan steps={item.steps} />;
    case "notice":
      return <div className={`oc-notice is-${item.tone}`}>{item.text}</div>;
    case "tool":
      return item.tool === "task" ? (
        <OpenCodeSubagent item={item} elapsed={elapsed} />
      ) : (
        <OpenCodeTool item={item} elapsed={elapsed} />
      );
  }
}

/**
 * One lane module.
 *
 * Memoised on the module: streaming only ever changes the last one, and a
 * finished `read` module of twelve rows should never re-render to add a
 * character somewhere else.
 */
const OpenCodeModule = memo(function OpenCodeModule({
  module,
  now,
}: {
  module: Module;
  now: number;
}) {
  const live = module.items.some(isLive);
  const failed = module.items.some((item) => item.kind === "tool" && item.status === "error");
  return (
    <section
      className="oc-mod"
      data-lane={module.lane}
      data-live={live || undefined}
      data-failed={failed || undefined}
    >
      <div className="oc-mod-gutter">
        <span className="oc-mod-tag">{module.lane}</span>
        {module.items.length > 1 && (
          <span className="oc-mod-count" aria-hidden="true">
            ×{module.items.length}
          </span>
        )}
      </div>
      <div className="oc-mod-body">
        {module.items.map((item) => (
          <OpenCodeItem key={item.id} item={item} now={isLive(item) ? now : 0} />
        ))}
      </div>
    </section>
  );
});

/** Tool families as lane tags, so the header speaks the same words as the body. */
const TALLY_LANE: Record<string, Lane> = {
  execute: "exec",
  edit: "edit",
  read: "read",
  search: "find",
  fetch: "net",
  task: "agent",
  todo: "plan",
  think: "think",
  other: "tool",
};

export function OpenCodeExperience({ session, items, className }: ProviderExperienceProps) {
  const list = items ?? session.items;
  const modules = useMemo(() => toModules(list), [list]);
  const plan = useMemo(() => planSummary(list), [list]);
  const activity = useMemo(() => activitySummary(list), [list]);
  const phase = phaseOf(session, list);
  const now = useTicker(phase.busy);
  const started = turnStart(list);
  const turnFor = phase.busy && started !== null ? formatElapsed(now - started) : null;
  const { provider, name } = splitModel(session.model);

  return (
    <section className={`oc${className ? ` ${className}` : ""}`} data-phase={phase.kind}>
      {!session.started && session.status !== "error" && (
        <div className="oc-open">
          <OpenCodeMark phase={phase.kind} large />
          <div className="oc-open-text">
            <strong>{session.label}</strong>
            <span>
              {phase.kind === "starting"
                ? "Bringing up the session…"
                : "Say what to build. Any provider, any model, this folder."}
            </span>
            <code>{session.cwd}</code>
          </div>
        </div>
      )}

      {session.started && (
        <header className="oc-bar" data-busy={phase.busy || undefined}>
          <div className="oc-bar-row">
            <OpenCodeMark phase={phase.kind} />
            <span className="oc-phase" aria-live="polite">
              {PHASE_WORD[phase.kind]}
            </span>
            {phase.detail && (
              <span className="oc-phase-detail" title={phase.detail}>
                {phase.detail}
              </span>
            )}
            <span className="oc-bar-gap" />
            {turnFor && <span className="oc-bar-time">{turnFor}</span>}
            {name && (
              <span className="oc-ident" title={session.model ?? undefined}>
                {provider && <span className="oc-ident-provider">{provider}</span>}
                <span className="oc-ident-model">{name}</span>
                {session.effort && <span className="oc-ident-effort">{session.effort}</span>}
              </span>
            )}
          </div>
          {(activity.tallies.length > 0 || activity.files.length > 0) && (
            <div className="oc-tallies">
              {activity.tallies.map((tally) => (
                <span
                  key={tally.kind}
                  className={`oc-tally${tally.running ? " is-live" : ""}${tally.failed ? " is-bad" : ""}`}
                  data-lane={TALLY_LANE[tally.kind] ?? "tool"}
                >
                  <span className="oc-tally-tag">{TALLY_LANE[tally.kind] ?? "tool"}</span>
                  <span className="oc-tally-count">{tally.count}</span>
                </span>
              ))}
              {activity.files.length > 0 && (
                <span
                  className="oc-tally is-files"
                  title={activity.files.map(basename).join(", ")}
                >
                  <span className="oc-tally-tag">files</span>
                  <span className="oc-tally-count">{activity.files.length}</span>
                  <span className="oc-add">+{activity.insertions}</span>
                  <span className="oc-del">−{activity.deletions}</span>
                </span>
              )}
            </div>
          )}
          {plan && <OpenCodeTracker plan={plan} />}
        </header>
      )}

      {modules.length > 0 && (
        <div className="oc-lanes">
          {/* Only a module with a live call gets the ticking clock: handing
              `now` to a finished module would re-render it once a second. */}
          {modules.map((module) => (
            <OpenCodeModule
              key={module.key}
              module={module}
              now={module.items.some(isLive) ? now : 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}
