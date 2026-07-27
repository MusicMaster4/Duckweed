import { memo, useState } from "react";

import type { AgentItem, ToolItem, ToolKind } from "../../lib/agents/types";
import { AgentDiff } from "./AgentDiff";

/** A glyph per tool family, so a call is recognisable before it is read. */
const TOOL_GLYPH: Record<ToolKind, string> = {
  read: "◧",
  edit: "✎",
  search: "⌕",
  execute: "❯",
  fetch: "⇩",
  think: "◌",
  task: "⛬",
  todo: "☑",
  other: "•",
};

/** Reasoning is folded by default: it is context, not the answer. */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  // The last line is the live one while a block streams — showing it keeps the
  // pane moving without unfolding a wall of reasoning the user did not ask for.
  const lines = text.split("\n").filter((line) => line.trim());
  const tail = lines[lines.length - 1] ?? "";

  return (
    <div className={`agent-thinking${open ? " is-open" : ""}${streaming ? " is-streaming" : ""}`}>
      <button type="button" className="agent-thinking-head" onClick={() => setOpen(!open)}>
        <span className="agent-thinking-mark" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="agent-thinking-label">Thinking</span>
        {!open && <span className="agent-thinking-peek">{tail}</span>}
      </button>
      {open && <div className="agent-thinking-body">{text}</div>}
    </div>
  );
}

function ToolBlock({ item }: { item: ToolItem }) {
  const hasOutput = item.output.trim().length > 0;
  const hasChanges = item.changes.length > 0;
  // Edits are the point of the session, so they open themselves. Command
  // output is noise until something goes wrong, so it opens on failure only.
  const [open, setOpen] = useState(hasChanges || item.status === "error");
  const expandable = hasOutput || hasChanges;
  const insertions = item.changes.reduce((sum, change) => sum + change.insertions, 0);
  const deletions = item.changes.reduce((sum, change) => sum + change.deletions, 0);

  return (
    <div className={`agent-tool is-${item.status}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="agent-tool-head"
        onClick={() => expandable && setOpen(!open)}
        disabled={!expandable}
      >
        <span className="agent-tool-glyph" aria-hidden="true">
          {TOOL_GLYPH[item.tool]}
        </span>
        <span className="agent-tool-title">{item.title}</span>
        {insertions > 0 && <span className="agent-tool-add">+{insertions}</span>}
        {deletions > 0 && <span className="agent-tool-del">−{deletions}</span>}
        <span className={`agent-tool-status is-${item.status}`} aria-hidden="true">
          {item.status === "running" || item.status === "pending"
            ? "•••"
            : item.status === "error"
              ? "✕"
              : "✓"}
        </span>
      </button>
      {open && hasChanges && (
        <div className="agent-tool-changes">
          {item.changes.map((change, index) => (
            <AgentDiff key={`${change.path}-${index}`} change={change} />
          ))}
        </div>
      )}
      {open && hasOutput && <pre className="agent-tool-output">{item.output}</pre>}
    </div>
  );
}

function ItemView({ item }: { item: AgentItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="agent-turn">
          <span className="agent-turn-mark" aria-hidden="true" />
          <p className="agent-turn-text">{item.text}</p>
        </div>
      );

    case "assistant":
      return (
        <div className={`agent-prose${item.streaming ? " is-streaming" : ""}`}>{item.text}</div>
      );

    case "thinking":
      return <ThinkingBlock text={item.text} streaming={item.streaming} />;

    case "tool":
      return <ToolBlock item={item} />;

    case "plan":
      return (
        <ul className="agent-plan">
          {item.steps.map((step, index) => (
            <li key={index} className={`agent-plan-step is-${step.status}`}>
              <span className="agent-plan-box" aria-hidden="true">
                {step.status === "done" ? "✓" : step.status === "running" ? "◆" : ""}
              </span>
              <span className="agent-plan-text">{step.text}</span>
            </li>
          ))}
        </ul>
      );

    case "notice":
      return <div className={`agent-notice is-${item.tone}`}>{item.text}</div>;
  }
}

/**
 * The transcript.
 *
 * Memoised per item: a streaming turn re-renders the session on every frame,
 * and everything above the live block is unchanged text that must not be
 * rebuilt to add one character at the bottom.
 */
const MemoItem = memo(ItemView);

export function AgentTimeline({ items }: { items: AgentItem[] }) {
  return (
    <div className="agent-timeline">
      {items.map((item) => (
        <MemoItem key={item.id} item={item} />
      ))}
    </div>
  );
}
