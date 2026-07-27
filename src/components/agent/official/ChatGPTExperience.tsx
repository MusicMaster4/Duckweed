import { useEffect, useMemo, useState } from "react";

import type { AgentItem, ThinkingItem, ToolItem } from "../../../lib/agents/types";
import {
  activityItems,
  MessageItem,
  PlanTracker,
  ProviderEmpty,
  ToolActivity,
  ToolIcon,
  traceSummary,
  type ExperienceProps,
} from "./OfficialShared";

function OpenAIActivityIcon({ tool }: { tool?: ToolItem["tool"] }) {
  if (tool) {
    return (
      <span className="chatgpt-activity-icon">
        <ToolIcon kind={tool} />
      </span>
    );
  }
  return (
    <span className="chatgpt-activity-icon is-reasoning" aria-hidden="true">
      <svg viewBox="0 0 20 20">
        <path d="M10 2.2a3 3 0 0 1 2.8 1.9 3 3 0 0 1 3.1 4.5 3 3 0 0 1-1.2 5.3 3 3 0 0 1-4.7 2.7 3 3 0 0 1-4.7-2.7 3 3 0 0 1-1.2-5.3 3 3 0 0 1 3.1-4.5A3 3 0 0 1 10 2.2Z" />
        <path d="M7.2 4.1 10 5.8l2.8-1.7M10 5.8v3.4m-5.9-.6 3.1 1.8v3.3m8.7-5.1-3.1 1.8v3.3M7.2 16v-2.3l2.8-1.6 2.8 1.6V16" />
      </svg>
    </span>
  );
}

function ThinkingRow({
  item,
  selected,
  onSelect,
}: {
  item: ThinkingItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`chatgpt-thinking-row${item.streaming ? " is-streaming" : ""}${
        selected ? " is-selected" : ""
      }`}
      onClick={onSelect}
      aria-expanded={selected}
    >
      <OpenAIActivityIcon />
      <span className={item.streaming ? "chatgpt-shimmer" : ""}>{traceSummary(item.text)}</span>
    </button>
  );
}

function secondsLabel(value: number): string {
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m ${value % 60}s`;
}

function useActivitySeconds(items: AgentItem[], running: boolean): number {
  const first = items.find((item) => item.kind === "thinking" || item.kind === "tool");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!first) return 0;
  return Math.max(0, Math.round(((running ? now : Date.now()) - first.at) / 1000));
}

function ChatGPTDetails({
  items,
  selectedId,
  running,
  onClose,
}: {
  items: AgentItem[];
  selectedId: string;
  running: boolean;
  onClose: () => void;
}) {
  const activities = useMemo(() => activityItems(items), [items]);
  const seconds = useActivitySeconds(items, running);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <aside className="chatgpt-details" role="region" aria-label="Thinking details">
      <header>
        <div>
          <strong>Activity</strong>
          <span>· {secondsLabel(seconds)}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close activity details">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" />
          </svg>
        </button>
      </header>
      <div className="chatgpt-details-body">
        {activities.map((item) =>
          item.kind === "thinking" ? (
            <section
              key={item.id}
              className={`chatgpt-detail-phase${item.id === selectedId ? " is-selected" : ""}`}
            >
              <div className="chatgpt-detail-title">
                <OpenAIActivityIcon />
                <strong>{traceSummary(item.text)}</strong>
              </div>
              <p>{item.text}</p>
            </section>
          ) : (
            <section
              key={item.id}
              className={`chatgpt-detail-phase is-tool${
                item.id === selectedId ? " is-selected" : ""
              }`}
            >
              <ToolActivity item={item} variant="chatgpt" />
            </section>
          ),
        )}
      </div>
    </aside>
  );
}

export function ChatGPTExperience(props: ExperienceProps) {
  const { items, status, started, label, mark, cwd } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const last = items[items.length - 1];
  const waitingForActivity =
    status === "working" &&
    (!last ||
      last.kind === "user" ||
      last.kind === "plan" ||
      (last.kind === "assistant" && !last.text.trim()));

  if (!started && status !== "error") {
    return (
      <ProviderEmpty
        label={label}
        mark={mark}
        cwd={cwd}
        status={status}
        loader={
          <span className="chatgpt-starting">
            <OpenAIActivityIcon />
            <span className="chatgpt-shimmer">Starting up…</span>
          </span>
        }
      />
    );
  }

  return (
    <div className={`agent-experience chatgpt-experience${selectedId ? " has-details" : ""}`}>
      <div className="official-transcript">
        {items.map((item) => {
          if (item.kind === "thinking") {
            return (
              <ThinkingRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => setSelectedId(item.id === selectedId ? null : item.id)}
              />
            );
          }
          if (item.kind === "tool") {
            return (
              <div
                key={item.id}
                className={item.id === selectedId ? "chatgpt-tool-wrap is-selected" : "chatgpt-tool-wrap"}
                onFocus={() => setSelectedId(item.id)}
              >
                <ToolActivity item={item} variant="chatgpt" compact />
              </div>
            );
          }
          if (item.kind === "plan") {
            return <PlanTracker key={item.id} item={item} variant="chatgpt" />;
          }
          return <MessageItem key={item.id} item={item} variant="chatgpt" />;
        })}
        {waitingForActivity && (
          <div className="chatgpt-thinking-row is-streaming" role="status">
            <OpenAIActivityIcon />
            <span className="chatgpt-shimmer">Thinking</span>
          </div>
        )}
      </div>
      {selectedId && (
        <>
          <button
            type="button"
            className="chatgpt-details-scrim"
            onClick={() => setSelectedId(null)}
            aria-label="Close activity details"
          />
          <ChatGPTDetails
            items={items}
            selectedId={selectedId}
            running={status === "working"}
            onClose={() => setSelectedId(null)}
          />
        </>
      )}
    </div>
  );
}
