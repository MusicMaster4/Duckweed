import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { confirmCloseRunning, getConfirmClose } from "../lib/confirmClose";
import {
  MAX_LAYOUT_PANES,
  countTemplatePanes,
  getDefaultLayoutId,
  getLayouts,
  gridTemplate,
  removeLayout,
  saveLayout,
  setDefaultLayout,
  subscribe,
  templateCommands,
  withTemplateCommands,
  type LayoutDraft,
  type LayoutTemplate,
  type LayoutTemplateNode,
} from "../lib/layouts";

interface Props {
  projectName: string | null;
  getCurrentDraft: () => LayoutDraft | null;
  onOpen: (layout: LayoutTemplate) => void;
}

type EditorState = {
  id?: string;
  title: string;
  name: string;
  root: LayoutTemplateNode;
  canChangeCount: boolean;
  defaultAtStartup: boolean;
};

const PANE_PRESETS = [1, 2, 4, 8, 16] as const;

function commandLabel(command: string): string {
  const clean = command.trim();
  if (!clean) return "Shell";
  if (/^codex(?:\s|$)/i.test(clean)) return "Codex";
  if (/^(?:claude|claude-code)(?:\s|$)/i.test(clean)) return "Claude";
  return clean;
}

function LayoutPreview({
  node,
  activeIndex = null,
  numbered = false,
}: {
  node: LayoutTemplateNode;
  activeIndex?: number | null;
  numbered?: boolean;
}) {
  let cursor = 0;
  const draw = (entry: LayoutTemplateNode, key: string): ReactNode => {
    if (entry.kind === "leaf") {
      const index = cursor;
      cursor += 1;
      return (
        <span
          key={key}
          className={`layout-preview-pane ${activeIndex === index ? "is-targeted" : ""}`}
          data-pane-number={numbered ? index + 1 : undefined}
          title={`Pane ${index + 1}: ${commandLabel(entry.command)}`}
        />
      );
    }
    return (
      <span key={key} className={`layout-preview-split is-${entry.dir}`}>
        {entry.children.map((child, index) => draw(child, `${key}-${index}`))}
      </span>
    );
  };
  return <>{draw(node, "root")}</>;
}

interface Chip {
  key: string;
  label: string;
  tone: "codex" | "claude" | "shell" | "other";
}

/** What a layout is made of, as one chip per kind of pane. */
function templateChips(layout: LayoutTemplate): Chip[] {
  const commands = templateCommands(layout.root);
  const count = (test: RegExp) =>
    commands.filter((command) => test.test(command.trim())).length;
  const codex = count(/^codex(?:\s|$)/i);
  const claude = count(/^(?:claude|claude-code)(?:\s|$)/i);
  const blank = commands.filter((command) => !command.trim()).length;
  const other = commands.length - codex - claude - blank;
  const chips: Chip[] = [];
  if (codex) chips.push({ key: "codex", label: `${codex} Codex`, tone: "codex" });
  if (claude) chips.push({ key: "claude", label: `${claude} Claude`, tone: "claude" });
  if (blank) chips.push({ key: "shell", label: `${blank} shell`, tone: "shell" });
  if (other) chips.push({ key: "other", label: `${other} custom`, tone: "other" });
  return chips;
}

function TemplateCard({
  layout,
  canLaunch,
  editable,
  isDefault,
  onOpen,
  onEdit,
}: {
  layout: LayoutTemplate;
  canLaunch: boolean;
  editable?: boolean;
  isDefault?: boolean;
  onOpen: () => void;
  onEdit?: () => void;
}) {
  const panes = countTemplatePanes(layout.root);
  return (
    <article className="layout-card">
      <div className="layout-card-preview" aria-hidden="true">
        <LayoutPreview node={layout.root} />
      </div>
      <div className="layout-card-copy">
        <strong>
          {layout.name}
          {isDefault && <em title="Used when Duckweed starts">Default</em>}
        </strong>
        <span className="layout-card-chips">
          <b title={`${panes} ${panes === 1 ? "pane" : "panes"}`}>{panes}</b>
          {templateChips(layout).map((chip) => (
            <i key={chip.key} className={`is-${chip.tone}`}>
              {chip.label}
            </i>
          ))}
        </span>
      </div>
      {editable && (
        <button
          type="button"
          className="layout-icon-btn"
          aria-label={`Edit ${layout.name}`}
          title="Edit"
          onClick={onEdit}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 11.8V13h1.2l7.5-7.5-1.2-1.2z" />
            <path d="M9.8 5l1.2-1.2a.8.8 0 0 1 1.2 0l.1.1a.8.8 0 0 1 0 1.2L11.1 6.2" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="layout-open"
        disabled={!canLaunch}
        title={canLaunch ? `Replace this tab with ${layout.name}` : "Open a folder first"}
        onClick={onOpen}
      >
        Open
      </button>
    </article>
  );
}

export function LayoutsTool({ projectName, getCurrentDraft, onOpen }: Props) {
  const saved = useSyncExternalStore(subscribe, getLayouts, getLayouts);
  const defaultLayoutId = useSyncExternalStore(
    subscribe,
    getDefaultLayoutId,
    getDefaultLayoutId,
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
  const canLaunch = projectName !== null;

  const createNew = () =>
    setEditor({
      title: "Create layout",
      name: "My layout",
      root: gridTemplate(["", "", "", ""]),
      canChangeCount: true,
      defaultAtStartup: false,
    });

  const saveCurrent = () => {
    const draft = getCurrentDraft();
    if (!draft) return;
    setEditor({
      title: "Save current layout",
      name: draft.name,
      root: draft.root,
      canChangeCount: false,
      defaultAtStartup: false,
    });
  };

  const requestDelete = async (layout: LayoutTemplate) => {
    const ok = await confirmCloseRunning({
      title: `Delete "${layout.name}"?`,
      message: "This removes the saved layout. Open terminal tabs are not affected.",
      confirmLabel: "Delete layout",
    });
    if (!ok) return;
    removeLayout(layout.id);
    setEditor(null);
  };

  return (
    <div className="layouts">
      <header className="layouts-head">
        <div>
          <span className="tools-section-title">Layouts</span>
          <span className="tools-section-note">Saved pane arrangements</span>
        </div>
        <button type="button" className="layouts-create" onClick={createNew}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Create
        </button>
      </header>

      {!canLaunch && <p className="layouts-project-note">Open a folder to launch a layout.</p>}

      <div className="layouts-scroll">
        <section className="layouts-section">
          <div className="layouts-section-head">
            <span>Saved</span>
            <span>{saved.length}</span>
            <button type="button" onClick={saveCurrent}>
              Save current
            </button>
          </div>
          {saved.length === 0 ? (
            <div className="layouts-empty">
              <span className="layouts-empty-mark" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <rect x="2" y="2.5" width="5" height="4.5" rx=".8" />
                  <rect x="9" y="2.5" width="5" height="4.5" rx=".8" />
                  <rect x="2" y="9" width="12" height="4.5" rx=".8" />
                </svg>
              </span>
              <strong>No layouts yet</strong>
              <div className="layouts-empty-actions">
                <button type="button" onClick={createNew}>
                  Create one
                </button>
                <button type="button" onClick={saveCurrent}>
                  Save this tab
                </button>
              </div>
            </div>
          ) : (
            <div className="layouts-list">
              {saved.map((layout) => (
                <TemplateCard
                  key={layout.id}
                  layout={layout}
                  canLaunch={canLaunch}
                  editable
                  isDefault={layout.id === defaultLayoutId}
                  onOpen={() => onOpen(layout)}
                  onEdit={() =>
                    setEditor({
                      id: layout.id,
                      title: "Edit layout",
                      name: layout.name,
                      root: layout.root,
                      canChangeCount: false,
                      defaultAtStartup: layout.id === defaultLayoutId,
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {editor && (
        <LayoutEditor
          state={editor}
          onClose={() => setEditor(null)}
          onSave={(draft, defaultAtStartup) => {
            const savedLayout = saveLayout(draft, editor.id);
            if (savedLayout && defaultAtStartup) {
              setDefaultLayout(savedLayout.id);
            } else if (editor.id && editor.id === defaultLayoutId) {
              setDefaultLayout(null);
            }
            setEditor(null);
          }}
          onDelete={
            editor.id
              ? () => {
                  const layout = saved.find((entry) => entry.id === editor.id);
                  if (layout) void requestDelete(layout);
                }
              : undefined
          }
        />
      )}

    </div>
  );
}

function LayoutEditor({
  state,
  onClose,
  onSave,
  onDelete,
}: {
  state: EditorState;
  onClose: () => void;
  onSave: (draft: LayoutDraft, defaultAtStartup: boolean) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(state.name);
  const [root, setRoot] = useState(state.root);
  const [defaultAtStartup, setDefaultAtStartup] = useState(state.defaultAtStartup);
  const [activeCommandIndex, setActiveCommandIndex] = useState<number | null>(null);
  const commands = useMemo(() => templateCommands(root), [root]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !getConfirmClose()) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const setCommands = (next: string[]) => setRoot((current) => withTemplateCommands(current, next));
  const resizeTo = (count: number) => {
    const safe = Math.max(1, Math.min(MAX_LAYOUT_PANES, count));
    const next = Array.from({ length: safe }, (_, index) => commands[index] ?? "");
    setActiveCommandIndex(null);
    setRoot(gridTemplate(next));
  };
  const setSetup = (setup: "blank" | "codex" | "claude" | "mixed") => {
    const next = commands.map((_, index) => {
      if (setup === "blank") return "";
      if (setup === "codex") return "codex";
      if (setup === "claude") return "claude";
      return index < Math.ceil(commands.length / 2) ? "codex" : "claude";
    });
    setCommands(next);
  };

  return createPortal(
    <div className="layout-modal-backdrop" onPointerDown={onClose}>
      <div
        className="layout-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="layout-editor-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="layout-modal-head">
          <div>
            <span className="tools-section-title">Layout template</span>
            <h2 id="layout-editor-title">{state.title}</h2>
          </div>
          <button type="button" aria-label="Close layout editor" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="layout-modal-body">
          <div className="layout-editor-config">
            <label className="layout-field">
              <span>Name</span>
              <input
                autoFocus
                value={name}
                maxLength={60}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            {state.canChangeCount && (
              <fieldset className="layout-field layout-pane-picker">
                <legend>Pane count</legend>
                <div className="layout-stepper">
                  <button
                    type="button"
                    aria-label="Remove one pane"
                    disabled={commands.length <= 1}
                    onClick={() => resizeTo(commands.length - 1)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8h9" />
                    </svg>
                  </button>
                  <span>
                    <strong>{commands.length}</strong>
                    <small>of {MAX_LAYOUT_PANES}</small>
                  </span>
                  <button
                    type="button"
                    aria-label="Add one pane"
                    disabled={commands.length >= MAX_LAYOUT_PANES}
                    onClick={() => resizeTo(commands.length + 1)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 3.5v9M3.5 8h9" />
                    </svg>
                  </button>
                </div>
                <div className="layout-count-presets" aria-label="Common pane counts">
                  {PANE_PRESETS.map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={commands.length === count ? "is-active" : ""}
                      onClick={() => resizeTo(count)}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            <fieldset className="layout-field">
              <legend>Fill commands</legend>
              <div className="layout-setups">
                <button type="button" onClick={() => setSetup("blank")}>
                  Blank
                </button>
                <button type="button" onClick={() => setSetup("codex")}>
                  Codex
                </button>
                <button type="button" onClick={() => setSetup("claude")}>
                  Claude
                </button>
                <button type="button" onClick={() => setSetup("mixed")}>
                  Half and half
                </button>
              </div>
            </fieldset>

            <label className="layout-default-choice">
              <input
                type="checkbox"
                checked={defaultAtStartup}
                onChange={(event) => setDefaultAtStartup(event.target.checked)}
              />
              <span className="layout-default-check" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M3.5 8.3l2.7 2.7 6.3-6.3" />
                </svg>
              </span>
              <span>
                <strong>Use at startup</strong>
                <small>Applied to the restored tab when Duckweed opens.</small>
              </span>
            </label>

            <div className="layout-editor-preview">
              <div className="layout-editor-preview-copy">
                <span>Preview</span>
                <strong>
                  {commands.length} {commands.length === 1 ? "pane" : "panes"}
                </strong>
              </div>
              <div className="layout-editor-preview-frame" aria-label="Layout preview">
                <LayoutPreview node={root} activeIndex={activeCommandIndex} numbered />
              </div>
            </div>
          </div>

          <section
            className="layout-field layout-commands"
            aria-labelledby="layout-commands-title"
          >
            <div className="layout-commands-head">
              <div>
                <span id="layout-commands-title">Startup commands</span>
                <p>Blank opens a plain shell.</p>
              </div>
              <span>{commands.filter((command) => command.trim()).length}/{commands.length} set</span>
            </div>
            <div className="layout-command-grid">
              {commands.map((command, index) => (
                <label key={index}>
                  <span>{index + 1}</span>
                  <input
                    value={command}
                    maxLength={1_000}
                    spellCheck={false}
                    placeholder="Shell only"
                    onFocus={() => setActiveCommandIndex(index)}
                    onBlur={() =>
                      setActiveCommandIndex((current) => (current === index ? null : current))
                    }
                    onChange={(event) => {
                      const next = [...commands];
                      next[index] = event.target.value;
                      setCommands(next);
                    }}
                  />
                </label>
              ))}
            </div>
          </section>
        </div>

        <footer className="layout-modal-actions">
          {onDelete && (
            <button type="button" className="layout-delete" onClick={onDelete}>
              Delete
            </button>
          )}
          <span />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="layout-save"
            disabled={!name.trim()}
            onClick={() => onSave({ name, root }, defaultAtStartup)}
          >
            Save layout
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
