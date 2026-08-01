import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { AsciiAmbient } from "./AsciiAmbient";
import {
  getPromptTemplates,
  MAX_CONTENT_LENGTH,
  MAX_TEMPLATES,
  removePromptTemplate,
  savePromptTemplate,
  searchPromptTemplates,
  subscribe,
  type PromptTemplate,
} from "../lib/promptTemplates";
import * as bus from "../lib/bus";

type Editor = { id?: string; title: string; content: string };
type PromptDrag = { title: string; content: string; x: number; y: number };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function PromptCard({
  template,
  copied,
  onCopied,
  onEdit,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  template: PromptTemplate;
  copied: boolean;
  onCopied: () => void;
  onEdit: () => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: React.PointerEvent<HTMLElement>) => void;
  onDragCancel: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className="prompt-template-card"
      data-prompt-template
      title="Drag this card into a terminal"
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragCancel}
    >
      <header>
        <strong>{template.title}</strong>
        <button type="button" onClick={onEdit} aria-label={`Edit ${template.title}`}>
          Edit
        </button>
      </header>
      <p>{template.content}</p>
      <footer>
        <button
          type="button"
          onClick={() => {
            void copyText(template.content).then((ok) => {
              if (ok) onCopied();
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </footer>
    </article>
  );
}

export function PromptsTool() {
  const templates = useSyncExternalStore(subscribe, getPromptTemplates, getPromptTemplates);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<PromptDrag | null>(null);
  const dragRef = useRef<PromptDrag | null>(null);
  const targetPaneRef = useRef<HTMLElement | null>(null);
  const matches = useMemo(() => {
    void templates;
    return searchPromptTemplates(query);
  }, [query, templates]);
  const atTemplateLimit = templates.length >= MAX_TEMPLATES;

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const clearDragTarget = () => {
    targetPaneRef.current?.classList.remove("is-prompt-drag-target");
    targetPaneRef.current = null;
  };

  const paneAt = (x: number, y: number): HTMLElement | null =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>(".pane[data-term-id]") ?? null;

  const moveDrag = (x: number, y: number) => {
    const current = dragRef.current;
    if (!current) return;
    const pane = paneAt(x, y);
    if (pane !== targetPaneRef.current) {
      clearDragTarget();
      pane?.classList.add("is-prompt-drag-target");
      targetPaneRef.current = pane;
    }
    const next = { ...current, x, y };
    dragRef.current = next;
    setDrag(next);
  };

  const finishDrag = (x: number, y: number, deliver: boolean) => {
    const current = dragRef.current;
    const pane = paneAt(x, y) ?? targetPaneRef.current;
    const termId = pane?.dataset.termId;
    clearDragTarget();
    dragRef.current = null;
    setDrag(null);
    document.body.classList.remove("is-dragging-prompt");
    if (!deliver || !current || !termId) return;
    bus.emit("term:reveal", { termId });
    bus.emit("term:insert-prompt", { termId, text: current.content });
  };

  useEffect(
    () => () => {
      clearDragTarget();
      document.body.classList.remove("is-dragging-prompt");
    },
    [],
  );

  const save = () => {
    if (!editor) return;
    const saved = savePromptTemplate(editor, editor.id);
    if (saved) setEditor(null);
  };

  return (
    <section className="prompts-tool" aria-label="Prompt templates">
      <header className="prompts-head">
        <div>
          <span className="tools-section-title">Prompt templates</span>
          <span className="tools-section-note">
            {atTemplateLimit
              ? `${MAX_TEMPLATES} template limit reached`
              : "Shared across every agent"}
          </span>
        </div>
        <button
          type="button"
          className="prompts-create"
          disabled={atTemplateLimit}
          title={atTemplateLimit ? `Template limit reached (${MAX_TEMPLATES})` : undefined}
          onClick={() => setEditor({ title: "", content: "" })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New
        </button>
      </header>

      <label className="prompt-template-search">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4" />
          <path d="m10 10 3.5 3.5" />
        </svg>
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search title or prompt text"
          aria-label="Search prompt templates"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear prompt search">
            Clear
          </button>
        )}
      </label>

      <div className="prompt-template-scroll">
        {matches.length ? (
          matches.map((template) => (
            <PromptCard
              key={template.id}
              template={template}
              copied={copiedId === template.id}
              onCopied={() => setCopiedId(template.id)}
              onEdit={() =>
                setEditor({
                  id: template.id,
                  title: template.title,
                  content: template.content,
                })
              }
              onDragStart={(event) => {
                if (event.button !== 0) return;
                if ((event.target as Element).closest("button")) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const next = {
                  title: template.title,
                  content: template.content,
                  x: event.clientX,
                  y: event.clientY,
                };
                dragRef.current = next;
                setDrag(next);
                document.body.classList.add("is-dragging-prompt");
              }}
              onDragMove={(event) => moveDrag(event.clientX, event.clientY)}
              onDragEnd={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                finishDrag(event.clientX, event.clientY, true);
              }}
              onDragCancel={(event) => finishDrag(event.clientX, event.clientY, false)}
            />
          ))
        ) : (
          <div className={`prompts-empty ${query ? "is-filtered" : ""}`}>
            {!query && (
              <AsciiAmbient
                surfaceId="prompts-empty"
                scene="network"
                className="ascii-ambient-prompts"
              />
            )}
            <strong>{query ? "No matching templates" : "No prompt templates yet"}</strong>
            <p>
              {query
                ? "Try a different word from the title or prompt text."
                : "Save a reusable prompt here, then use it in any shell or agent."}
            </p>
            {!query && (
              <button
                type="button"
                className="prompts-empty-create"
                onClick={() => setEditor({ title: "", content: "" })}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                Create template
              </button>
            )}
          </div>
        )}
      </div>

      {editor && (
        <div className="prompt-editor-backdrop" role="presentation" onMouseDown={() => setEditor(null)}>
          <section
            className="prompt-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editor.id ? "Edit prompt template" : "New prompt template"}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{editor.id ? "Edit template" : "New template"}</span>
                <strong>Reusable prompt</strong>
              </div>
              <button type="button" onClick={() => setEditor(null)} aria-label="Close prompt editor">
                Close
              </button>
            </header>
            <label>
              <span>Name</span>
              <input
                autoFocus
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.currentTarget.value })}
                placeholder="Example: Review this implementation"
                maxLength={80}
              />
            </label>
            <label className="prompt-editor-content">
              <span>Prompt</span>
              <textarea
                value={editor.content}
                onChange={(event) => setEditor({ ...editor, content: event.currentTarget.value })}
                placeholder="Write the prompt exactly as it should appear in the terminal..."
                rows={12}
                maxLength={MAX_CONTENT_LENGTH}
                aria-describedby="prompt-template-character-count"
              />
              <span id="prompt-template-character-count" className="prompt-editor-count">
                {editor.content.length.toLocaleString()} / {MAX_CONTENT_LENGTH.toLocaleString()}
              </span>
            </label>
            <footer>
              {editor.id ? (
                <button
                  type="button"
                  className="prompt-editor-delete"
                  onClick={() => {
                    removePromptTemplate(editor.id!);
                    setEditor(null);
                  }}
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <button type="button" onClick={() => setEditor(null)}>Cancel</button>
              <button
                type="button"
                className="prompt-editor-save"
                disabled={!editor.title.trim() || !editor.content.trim()}
                onClick={save}
              >
                Save template
              </button>
            </footer>
          </section>
        </div>
      )}

      {drag &&
        createPortal(
          <div
            className="prompt-template-drag-ghost"
            style={{ left: drag.x + 13, top: drag.y + 13 }}
            aria-hidden="true"
          >
            <strong>{drag.title}</strong>
            <span>{targetPaneRef.current ? "Release to insert" : "Drop in a terminal"}</span>
          </div>,
          document.body,
        )}
    </section>
  );
}
