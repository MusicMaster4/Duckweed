import { useEffect, useRef, useState } from "react";

import {
  effortsFor,
  shortModelLabel,
  type AgentModelChoice,
  type AgentSessionState,
} from "../../lib/agents/types";

interface Props {
  session: AgentSessionState;
  /** Apply a slash command (e.g. `/model opus`) through the normal dispatch path. */
  onSelect: (command: string) => void;
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

/**
 * Model + effort pickers, shaped after T3 Code's composer footer:
 * ghost triggers with the current value + chevron, popover menus with a
 * section label and a radio-style list. Choices still go through `/model`
 * and `/effort` so every adapter's existing slash handling stays the single
 * source of truth.
 */
export function AgentControls({ session, onSelect, placement = "composer" }: Props) {
  const [menu, setMenu] = useState<MenuKind>(null);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const models = session.models;
  const efforts = effortsFor(session);
  const canPickModel = models.length > 0;
  const canPickEffort = efforts.length > 0;
  const ended = session.status === "exited" || session.status === "error";

  const items: MenuItem[] =
    menu === "model"
      ? models.map((model) => ({
          id: model.id,
          label: model.label || shortModelLabel(model.id),
          detail: model.id !== model.label ? model.id : null,
          current: isCurrentModel(session.model, model),
        }))
      : menu === "effort"
        ? efforts.map((effort) => ({
            id: effort,
            label: titleCase(effort),
            detail: null,
            current: session.effort === effort,
          }))
        : [];

  useEffect(() => {
    if (!menu) return;
    const currentIndex = items.findIndex((item) => item.current);
    setHighlighted(currentIndex >= 0 ? currentIndex : 0);
  }, [menu]);

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
    onSelect(kind === "model" ? `/model ${id}` : `/effort ${id}`);
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
    ? shortModelLabel(session.model)
    : canPickModel
      ? "Model"
      : null;
  const effortLabel = session.effort
    ? titleCase(session.effort)
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
      {menu && items.length > 0 && (
        <div
          className="agent-control-menu"
          role="listbox"
          aria-label={menuTitle}
        >
          <div className="agent-control-menu-title">{menuTitle}</div>
          {items.map((item, index) => (
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
          ))}
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
  return (
    model.id === current ||
    model.label === current ||
    model.id.endsWith(`/${current}`) ||
    current.endsWith(`/${model.id}`)
  );
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
