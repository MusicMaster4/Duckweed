import { memo, useMemo, useState } from "react";

import type { AgentItem, AgentPlanStep, ToolItem, ToolStatus } from "../../../lib/agents/types";
import { AgentImageAttachments } from "../AgentImageAttachments";
import { MessageCopyButton } from "../MessageCopyButton";
import { useSubagentUi } from "../subagents/SubagentUiContext";
import {
  ActivityHistory,
  activeAssistantId,
  activityGroups,
  AssistantMarkdown,
  continuedAssistantIds,
  ProviderEmpty,
} from "../official/OfficialShared";
import { ChangeSet, Disclosure, ScreenReaderText, useTicker } from "./ProviderExperienceParts";
import {
  basename,
  formatElapsed,
  tailLine,
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
            <span
              className={`oc-think-loader${streaming ? " is-active" : " is-settled"}`}
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
            </span>
            <span className="oc-chevron" aria-hidden="true" data-open={open} />
            {open ? <span className="oc-think-label">reasoning</span> : null}
            {!open && <span className="oc-think-peek">{tailLine(text)}</span>}
          </>
        }
        label="Reasoning"
      >
        <div className="oc-think-text">
          <AssistantMarkdown text={text} />
        </div>
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
  const { selectedCallId, selectSubagent } = useSubagentUi();
  const head = (
    <>
      <span className="oc-sub-bracket" aria-hidden="true">
        ⌈
      </span>
      <span className="oc-sub-title">{item.title}</span>
      <OpenCodeStatus status={item.status} elapsed={elapsed} />
    </>
  );
  return (
    <div
      className={`oc-sub is-${item.status}${
        selectedCallId === item.callId ? " is-selected" : ""
      }`}
      data-subagent-call-id={item.callId}
    >
      <button
        type="button"
        className="oc-sub-head"
        onClick={() => selectSubagent(item.callId)}
        aria-label={`Inspect subagent: ${item.title}`}
      >
        {head}
      </button>
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

function OpenCodeItem({
  item,
  now,
  continued = false,
  showStreaming = false,
}: {
  item: AgentItem;
  now: number;
  continued?: boolean;
  showStreaming?: boolean;
}) {
  const elapsed = isLive(item) && now > 0 ? formatElapsed(now - item.at) : null;

  switch (item.kind) {
    case "user":
      // Bubble wraps only the prompt; the copy control sits outside it, same
      // pattern as the official user turns. Keeping both in `.oc-mod-body`
      // previously painted the icon inside the bubble.
      return (
        <div className="oc-user-turn" data-message-enter>
          <div className="oc-user-bubble">
            <AgentImageAttachments images={item.images ?? []} />
            {item.text && <p className="oc-said">{item.text}</p>}
          </div>
          {item.text && <MessageCopyButton text={item.text} />}
        </div>
      );
    case "assistant":
      return (
        <div
          className={`oc-prose${showStreaming ? " is-streaming" : ""}${
            continued ? " is-interim-update" : ""
          }`}
          data-message-enter
        >
          <AssistantMarkdown text={item.text} />
        </div>
      );
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
  continuedIds,
  liveAssistantId,
}: {
  module: Module;
  now: number;
  continuedIds: Set<string>;
  liveAssistantId: string | null;
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
          <OpenCodeItem
            key={item.id}
            item={item}
            now={isLive(item) ? now : 0}
            continued={item.kind === "assistant" && continuedIds.has(item.id)}
            showStreaming={item.kind === "assistant" && item.id === liveAssistantId}
          />
        ))}
      </div>
    </section>
  );
});

export function OpenCodeExperience({ session, items, className }: ProviderExperienceProps) {
  const list = items ?? session.items;
  const modules = useMemo(() => toModules(list), [list]);
  const groups = useMemo(() => activityGroups(list), [list]);
  const continuedIds = useMemo(() => continuedAssistantIds(list), [list]);
  const liveAssistantId = useMemo(
    () => activeAssistantId(list, session.status === "working"),
    [list, session.status],
  );
  const groupByActivity = useMemo(
    () =>
      new Map(
        groups.flatMap((group) =>
          group.activities.map((item) => [item.id, group] as const),
        ),
      ),
    [groups],
  );
  // Tick only while a tool call is live so finished rows do not re-render once a second.
  const hasLiveTools = useMemo(() => list.some(isLive), [list]);
  const now = useTicker(hasLiveTools);
  let latestUserIndex = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index].kind === "user") latestUserIndex = index;
  }
  let liveGroup: (typeof groups)[number] | undefined;
  for (const group of groups) {
    if (group.firstIndex > latestUserIndex) liveGroup = group;
  }
  const visibleContinuedIds = useMemo(() => {
    if (session.status !== "working" || !liveGroup?.answerId) return continuedIds;
    return new Set([...continuedIds, liveGroup.answerId]);
  }, [continuedIds, liveGroup?.answerId, session.status]);
  const needsEmptyLiveTrace = session.status === "working" && !liveGroup;
  const liveUserId =
    latestUserIndex >= 0 ? list[latestUserIndex]?.id : "session-start";

  // Outside the `.oc` column, like the official surfaces do it: the empty state
  // centres itself against the full pane, not against the transcript's width.
  if (!session.started && session.status !== "error") {
    return (
      <ProviderEmpty
        agent={session.agent}
        termId={session.termId}
        label={session.label}
        program={session.program}
        cwd={session.cwd}
        status={session.status}
      />
    );
  }

  return (
    <section className={`oc${className ? ` ${className}` : ""}`}>
      {(modules.length > 0 || needsEmptyLiveTrace) && (
        <div className="oc-lanes">
          {/* Only a module with a live call gets the ticking clock: handing
              `now` to a finished module would re-render it once a second. */}
          {modules.map((module) => {
            const first = module.items[0];
            if (first.kind === "thinking" || first.kind === "tool") {
              const group = groupByActivity.get(first.id);
              if (
                !group ||
                module.key !== group.firstId ||
                group.replacedByCommentId ||
                (session.status === "working" && group === liveGroup && group.answerId)
              ) {
                return null;
              }
              const working = session.status === "working" && group === liveGroup;
              return (
                <section
                  key={`opencode-activity-${group.firstId}`}
                  className="oc-mod is-activity"
                  data-lane="activity"
                  data-live={working || undefined}
                >
                  <div className="oc-mod-gutter">
                    <span className="oc-mod-tag">activity</span>
                  </div>
                  <div className="oc-mod-body">
                    <ActivityHistory
                      activities={group.activities}
                      variant="opencode"
                      working={working}
                      showLatestThinking={group === groups[groups.length - 1]}
                      clusterId={`${session.termId}:${group.firstId}`}
                    />
                  </div>
                </section>
              );
            }
            return (
              <OpenCodeModule
                key={module.key}
                module={module}
                now={module.items.some(isLive) ? now : 0}
                continuedIds={visibleContinuedIds}
                liveAssistantId={liveAssistantId}
              />
            );
          })}
          {needsEmptyLiveTrace && (
            <section className="oc-mod is-activity" data-lane="activity" data-live>
              <div className="oc-mod-gutter">
                <span className="oc-mod-tag">activity</span>
              </div>
              <div className="oc-mod-body">
                <ActivityHistory
                  activities={[]}
                  variant="opencode"
                  working
                  clusterId={`${session.termId}:live:${liveUserId}`}
                />
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
