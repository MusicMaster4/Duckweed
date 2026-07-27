import { useEffect, useMemo, useRef, useState } from "react";

import {
  effortsFor,
  shortModelLabel,
  type AgentModelChoice,
  type AgentSessionState,
} from "../../lib/agents/types";

interface Props {
  session: AgentSessionState;
  /** Apply a picker choice without exposing its internal slash syntax as chat. */
  onSelect: (kind: "model" | "effort", value: string) => void;
  /**
   * Where the menus open relative to the triggers.
   * Composer footer (T3-style) opens upward; header opens downward.
   */
  placement?: "composer" | "header";
}

type MenuKind = "model" | "effort" | null;

type MenuItem = {
  id: string;
  label: string;
  detail: string | null;
  current: boolean;
};

/** Show a filter field once the list is longer than a glanceable menu. */
const SEARCH_THRESHOLD = 8;

/**
 * Model + effort pickers, shaped after T3 Code's composer footer:
 * ghost triggers with the current value + chevron, popover menus with a
 * section label and a radio-style list. Choices still go through `/model`
 * and `/effort` through the adapter while keeping that implementation syntax
 * out of the conversation.
 */
export function AgentControls({ session, onSelect, placement = "composer" }: Props) {
  const [menu, setMenu] = useState<MenuKind>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const models = session.models;
  const efforts = effortsFor(session);
  const canPickModel = models.length > 0;
  const canPickEffort = efforts.length > 0;
  const ended = session.status === "exited" || session.status === "error";
  const showSearch = menu === "model" && models.length > SEARCH_THRESHOLD;

  const allItems: MenuItem[] = useMemo(() => {
    if (menu === "model") {
      return models.map((model) => ({
        id: model.id,
        label: model.label || shortModelLabel(model.id),
        detail: model.id !== model.label ? model.id : null,
        current: isCurrentModel(session.model, model),
      }));
    }
    if (menu === "effort") {
      return efforts.map((effort) => ({
        id: effort,
        label: formatEffortLabel(effort),
        detail: null,
        current: session.effort === effort,
      }));
    }
    return [];
  }, [menu, models, efforts, session.model, session.effort]);

  const items = useMemo(() => {
    if (!query.trim() || menu !== "model") return allItems;
    const q = query.trim().toLowerCase();
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        (item.detail?.toLowerCase().includes(q) ?? false),
    );
  }, [allItems, query, menu]);

  useEffect(() => {
    if (!menu) {
      setQuery("");
      return;
    }
    const currentIndex = items.findIndex((item) => item.current);
    setHighlighted(currentIndex >= 0 ? currentIndex : 0);
    if (showSearch) {
      // Next frame so the input is mounted.
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [menu, showSearch]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!canPickModel && !canPickEffort && !session.model && !session.effort) return null;

  const pick = (kind: "model" | "effort", id: string) => {
    setMenu(null);
    setQuery("");
    onSelect(kind, id);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (!menu || items.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + items.length) % items.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[highlighted];
      if (item) pick(menu, item.id);
    }
  };

  const modelLabel = session.model
    ? displayModelLabel(session.model, models)
    : canPickModel
      ? "Model"
      : null;
  const effortLabel = session.effort
    ? formatEffortLabel(session.effort)
    : canPickEffort
      ? "Effort"
      : null;

  const menuTitle = menu === "model" ? "Model" : menu === "effort" ? "Reasoning effort" : "";

  return (
    <div
      className={`agent-controls is-${placement}`}
      ref={rootRef}
      onKeyDown={onMenuKeyDown}
    >
      {modelLabel && (
        <ControlTrigger
          kind="model"
          label={modelLabel}
          title={session.model ? `Model: ${session.model}` : "Choose a model"}
          open={menu === "model"}
          interactive={canPickModel && !ended}
          onToggle={() => setMenu((current) => (current === "model" ? null : "model"))}
        />
      )}
      {effortLabel && (
        <ControlTrigger
          kind="effort"
          label={effortLabel}
          title={session.effort ? `Effort: ${session.effort}` : "Choose reasoning effort"}
          open={menu === "effort"}
          interactive={canPickEffort && !ended}
          onToggle={() => setMenu((current) => (current === "effort" ? null : "effort"))}
        />
      )}
      {menu && (
        <div className="agent-control-menu" role="listbox" aria-label={menuTitle}>
          <div className="agent-control-menu-title">{menuTitle}</div>
          {showSearch && (
            <div className="agent-control-search">
              <input
                ref={searchRef}
                type="text"
                value={query}
                spellCheck={false}
                placeholder="Search models…"
                aria-label="Search models"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // Keep ↑↓/Enter on the list; don't let them leave the input.
                  if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp" ||
                    event.key === "Enter"
                  ) {
                    onMenuKeyDown(event);
                  }
                }}
              />
            </div>
          )}
          {items.length === 0 ? (
            <div className="agent-control-empty">No matches</div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={[
                  index === highlighted ? "is-active" : "",
                  item.current ? "is-current" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(menu, item.id);
                }}
              >
                <span className="agent-control-option-main">
                  <span className="agent-control-option-label">{item.label}</span>
                  {item.detail && (
                    <span className="agent-control-option-detail">{item.detail}</span>
                  )}
                </span>
                {item.current && (
                  <span className="agent-control-option-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ControlTrigger({
  kind,
  label,
  title,
  open,
  interactive,
  onToggle,
}: {
  kind: "model" | "effort";
  label: string;
  title: string;
  open: boolean;
  interactive: boolean;
  onToggle: () => void;
}) {
  if (!interactive) {
    return (
      <span className={`agent-control-chip is-${kind} is-static`} title={title}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`agent-control-chip is-${kind}${open ? " is-open" : ""}`}
      title={title}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="agent-control-chip-label">{label}</span>
      <svg className="agent-control-chevron" viewBox="0 0 10 6" aria-hidden="true">
        <path
          d="M1 1l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function isCurrentModel(current: string | null, model: AgentModelChoice): boolean {
  if (!current) return false;
  const cur = current.toLowerCase();
  const id = model.id.toLowerCase();
  const label = model.label.toLowerCase();
  if (id === cur || label === cur) return true;
  if (id.endsWith(`/${cur}`) || cur.endsWith(`/${id}`)) return true;
  // Claude: settings `opus[1m]` vs init `claude-opus-5[1m]` vs picker `opus[1m]`.
  // Compare family + optional 1m flag only — never substring-match full ids
  // (that would mark opus-4-8 as current for opus-5).
  const familyOf = (value: string): string | null => {
    for (const family of ["fable", "opus", "sonnet", "haiku"] as const) {
      if (value.includes(family)) return family;
    }
    return null;
  };
  const family = familyOf(cur);
  if (family && family === familyOf(id)) {
    const curOneM = cur.includes("1m") || cur.includes("[1m]");
    const idOneM = id.includes("1m") || id.includes("[1m]");
    // Alias `opus` matches any non-1m opus id; `opus[1m]` only the 1m variants.
    if (id === family || id === `${family}[1m]`) return curOneM === idOneM || id === family;
    if (cur === family || cur === `${family}[1m]`) return curOneM === idOneM || cur === family;
  }
  return false;
}

function displayModelLabel(current: string, models: AgentModelChoice[]): string {
  const match = models.find((model) => isCurrentModel(current, model));
  if (match?.label) return match.label;
  return shortModelLabel(current);
}

function formatEffortLabel(value: string): string {
  if (!value) return value;
  if (value.toLowerCase() === "ultracode") return "Ultracode";
  if (value.toLowerCase() === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
