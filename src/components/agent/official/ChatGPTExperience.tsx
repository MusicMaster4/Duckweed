import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
        <path d="M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z" />
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
  const [pendingThinkingVisible, setPendingThinkingVisible] = useState(false);
  const latestUserRef = useRef<HTMLElement>(null);
  const dockedRectRef = useRef<DOMRect | null>(null);
  const wasDockedRef = useRef(false);
  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const latestUserId = latestUserIndex >= 0 ? items[latestUserIndex]?.id : null;
  const hasActivityAfterPrompt = items.slice(latestUserIndex + 1).some((item) => {
    if (item.kind === "user") return false;
    if (item.kind === "assistant") return Boolean(item.text.trim());
    return item.kind === "thinking" || item.kind === "tool" || item.kind === "plan";
  });
  const waitingForActivity =
    status === "working" && latestUserIndex >= 0 && !hasActivityAfterPrompt;
  const promptDocked = waitingForActivity && !pendingThinkingVisible;

  useEffect(() => {
    setPendingThinkingVisible(false);
    if (!waitingForActivity || !latestUserId) return;
    const timer = window.setTimeout(() => setPendingThinkingVisible(true), 210);
    return () => window.clearTimeout(timer);
  }, [latestUserId, waitingForActivity]);

  useLayoutEffect(() => {
    const node = latestUserRef.current;
    if (!node) return;

    if (promptDocked) {
      dockedRectRef.current = node.getBoundingClientRect();
      wasDockedRef.current = true;
      return;
    }

    if (!wasDockedRef.current || !dockedRectRef.current) return;
    const previous = dockedRectRef.current;
    const current = node.getBoundingClientRect();
    const deltaY = previous.top - current.top;
    wasDockedRef.current = false;
    dockedRectRef.current = null;

    if (
      Math.abs(deltaY) < 1 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof node.animate !== "function"
    ) {
      return;
    }

    node.animate(
      [
        { transform: `translateY(${deltaY}px)`, offset: 0 },
        { transform: "translateY(0)", offset: 1 },
      ],
      {
        duration: 280,
        easing: "cubic-bezier(0.2, 0.82, 0.2, 1)",
      },
    );
  }, [promptDocked, latestUserId]);

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
    <div
      className={`agent-experience chatgpt-experience${
        selectedId ? " has-details" : ""
      }${promptDocked ? " is-prompt-docked" : ""}`}
    >
      <div className="official-transcript">
        {items.map((item, index) => {
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
          return (
            <MessageItem
              key={item.id}
              item={item}
              variant="chatgpt"
              elementRef={index === latestUserIndex ? latestUserRef : undefined}
              className={
                index === latestUserIndex && !promptDocked && status === "working"
                  ? "chatgpt-latest-prompt"
                  : undefined
              }
            />
          );
        })}
        {waitingForActivity && pendingThinkingVisible && (
          <div className="chatgpt-thinking-row is-streaming is-entering" role="status">
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
