import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteAction {
  id: string;
  title: string;
  group: string;
  hint?: string;
  subtitle?: string;
  run: () => void;
}

/** Subsequence match — "spr" finds "Split right". */
function score(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let result = 0;
  let streak = 0;
  for (const char of q) {
    const found = t.indexOf(char, ti);
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    result += found === ti ? 3 + streak : 1;
    if (found === 0 || /[\s\-_/\\]/.test(t[found - 1] ?? "")) result += 4;
    ti = found + 1;
  }
  return result - t.length * 0.01;
}

interface Props {
  actions: PaletteAction[];
  onClose: () => void;
}

export function CommandPalette({ actions, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const scored = actions
      .map((action) => {
        const haystack = `${action.group} ${action.title} ${action.subtitle ?? ""}`;
        const value = score(query, haystack);
        return value === null ? null : { action, value };
      })
      .filter((x): x is { action: PaletteAction; value: number } => x !== null);
    if (query) scored.sort((a, b) => b.value - a.value);
    return scored.map((s) => s.action).slice(0, 60);
  }, [actions, query]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [index, results]);

  const commit = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <div className="palette-backdrop" onPointerDown={onClose}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          spellCheck={false}
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(results[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matching command</div>}
          {results.map((action, i) => (
            <button
              key={action.id}
              type="button"
              className={`palette-item ${i === index ? "is-selected" : ""}`}
              onPointerEnter={() => setIndex(i)}
              onClick={() => commit(action)}
            >
              <span className="palette-group">{action.group}</span>
              <span className="palette-title">{action.title}</span>
              {action.subtitle && <span className="palette-subtitle">{action.subtitle}</span>}
              {action.hint && <kbd>{action.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
