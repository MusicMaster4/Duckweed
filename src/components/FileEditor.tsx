import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { confirmCloseRunning } from "../lib/confirmClose";
import { highlightCode, langFromPath } from "../lib/codeSyntax";
import { readFile, writeFile } from "../lib/ipc";

interface Props {
  /** Absolute path of the file to open. */
  path: string;
  onClose: () => void;
  /** Lets the explorer know whether a switch would discard edits. */
  onDirtyChange?: (dirty: boolean) => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; content: string; binary: boolean; tooLarge: boolean; size: number }
  | { kind: "error"; message: string };

function splitPath(path: string): [string, string] {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? ["", path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Popup file viewer/editor opened from the project explorer.
 *
 * Same chrome shape as the changes panel: backdrop, card, Esc to dismiss.
 * A painted mirror under a transparent textarea carries syntax colours; the
 * textarea keeps native editing, selection, and the caret.
 */
export function FileEditor({ path, onClose, onDirtyChange }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  /** Latest draft/saved for async close checks without rebinding Escape. */
  const dirtyRef = useRef(false);

  const dirty = load.kind === "ready" && !load.binary && !load.tooLarge && draft !== saved;
  dirtyRef.current = dirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    setSaveError(null);
    readFile(path)
      .then((file) => {
        if (cancelled) return;
        setLoad({
          kind: "ready",
          content: file.content,
          binary: file.binary,
          tooLarge: file.too_large,
          size: file.size,
        });
        setDraft(file.content);
        setSaved(file.content);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ kind: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => reload(), [reload]);

  const requestClose = useCallback(async () => {
    if (dirtyRef.current) {
      const ok = await confirmCloseRunning({
        title: "Unsaved changes",
        message: "This file has unsaved edits. Close and discard them?",
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    onClose();
  }, [onClose]);

  const save = useCallback(async () => {
    if (load.kind !== "ready" || load.binary || load.tooLarge || saving) return;
    if (draft === saved) return;
    setSaving(true);
    setSaveError(null);
    try {
      await writeFile(path, draft);
      setSaved(draft);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
    } catch (error: unknown) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, load, path, saved, saving]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void requestClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose, save]);

  // Focus the editor once content is ready so typing works immediately.
  useEffect(() => {
    if (load.kind !== "ready" || load.binary || load.tooLarge) return;
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [load, path]);

  const lang = useMemo(() => langFromPath(path), [path]);

  const tokens = useMemo(() => highlightCode(draft, lang), [draft, lang]);

  const lineCount = useMemo(() => {
    if (!draft) return 1;
    let n = 1;
    for (let i = 0; i < draft.length; i++) if (draft[i] === "\n") n++;
    return n;
  }, [draft]);

  const gutter = useMemo(() => {
    const lines: string[] = [];
    for (let i = 1; i <= lineCount; i++) lines.push(String(i));
    return lines.join("\n");
  }, [lineCount]);

  const syncScroll = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = ta.scrollTop;
      mirrorRef.current.scrollLeft = ta.scrollLeft;
    }
  };

  const [dir, name] = splitPath(path);
  const editable = load.kind === "ready" && !load.binary && !load.tooLarge;

  return (
    <div className="file-editor-backdrop" onPointerDown={() => void requestClose()}>
      <div className="file-editor" onPointerDown={(e) => e.stopPropagation()}>
        <header className="file-editor-head">
          <span className="file-editor-path" title={path}>
            {dir && <span className="file-editor-dir">{dir}</span>}
            <span className="file-editor-name">{name}</span>
            {dirty && (
              <span className="file-editor-dirty" title="Unsaved changes">
                ●
              </span>
            )}
          </span>
          {load.kind === "ready" && (
            <span className="file-editor-meta">{formatBytes(load.size)}</span>
          )}
          <span className="diff-spacer" />
          {editable && (
            <button
              type="button"
              className="changes-btn"
              title="Reload from disk"
              onClick={() => {
                if (dirty) {
                  void confirmCloseRunning({
                    title: "Unsaved changes",
                    message: "Reload and discard the edits in this buffer?",
                    confirmLabel: "Reload",
                  }).then((ok) => {
                    if (ok) reload();
                  });
                } else {
                  reload();
                }
              }}
            >
              reload
            </button>
          )}
          {editable && (
            <button
              type="button"
              className={`changes-btn file-editor-save ${dirty ? "is-active" : ""}`}
              title="Save (Ctrl+S)"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "saving…" : savedFlash ? "saved" : "save"}
            </button>
          )}
          <button
            type="button"
            className="changes-btn"
            title="Close (Esc)"
            onClick={() => void requestClose()}
          >
            ✕
          </button>
        </header>

        {saveError && <div className="file-editor-banner is-error">{saveError}</div>}

        <div className="file-editor-body">
          {load.kind === "loading" && <div className="diff-empty">reading file…</div>}
          {load.kind === "error" && <div className="menu-error">{load.message}</div>}
          {load.kind === "ready" && load.binary && (
            <div className="diff-empty">Binary file — nothing to show here.</div>
          )}
          {load.kind === "ready" && load.tooLarge && (
            <div className="diff-empty">
              File is too large to open in the popup ({formatBytes(load.size)}).
            </div>
          )}
          {editable && (
            <div className="file-editor-code">
              <div ref={gutterRef} className="file-editor-gutter" aria-hidden="true">
                {gutter}
              </div>
              <div className="file-editor-surface">
                <div ref={mirrorRef} className="file-editor-mirror" aria-hidden="true">
                  {tokens.map((token, index) => (
                    <span key={index} className={`code-token token-${token.kind}`}>
                      {token.text}
                    </span>
                  ))}
                  {/* A lone trailing newline is dropped by the DOM; pad so the
                      last empty line still matches the textarea's height. */}
                  {draft.endsWith("\n") ? <span className="code-token token-plain">{"\n"}</span> : null}
                </div>
                <textarea
                  ref={textareaRef}
                  className="file-editor-textarea"
                  value={draft}
                  spellCheck={false}
                  wrap="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  onChange={(e) => setDraft(e.target.value)}
                  onScroll={syncScroll}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
