import { useEffect, useRef, useState } from "react";
import * as terminals from "../lib/terminals";

interface Props {
  termId: string;
  onClose: () => void;
}

export function SearchBar({ termId, onClose }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => () => terminals.clearSearch(termId), [termId]);

  const step = (direction: 1 | -1) => {
    if (!query) return;
    if (direction === 1) terminals.findNext(termId, query);
    else terminals.findPrevious(termId, query);
  };

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in terminal…"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value) terminals.findNext(termId, e.target.value);
          else terminals.clearSearch(termId);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") {
            terminals.clearSearch(termId);
            onClose();
            terminals.focus(termId);
          }
        }}
      />
      <button type="button" title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" title="Next match (Enter)" onClick={() => step(1)}>
        ↓
      </button>
      <button
        type="button"
        title="Close (Esc)"
        onClick={() => {
          terminals.clearSearch(termId);
          onClose();
          terminals.focus(termId);
        }}
      >
        ✕
      </button>
    </div>
  );
}
