import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  activeFileMention,
  clipboardImageFiles,
  formatDroppedPaths,
  imageFileToAttachment,
  insertComposerText,
  loadWorkspaceIndex,
  MAX_PROMPT_IMAGES,
  replaceMention,
  searchWorkspaceIndex,
  type FileMention,
} from "../../lib/agentComposer";
import { GUIDED_ARG_COMMANDS } from "../../lib/agents/slashCatalog";
import {
  effortsFor,
  shortModelLabel,
  type AgentImageAttachment,
  type AgentSessionState,
} from "../../lib/agents/types";
import * as agents from "../../lib/agents/session";
import * as terminals from "../../lib/terminals";
import { AgentControls } from "./AgentControls";
import { AgentImageAttachments } from "./AgentImageAttachments";

interface Props {
  session: AgentSessionState;
  /** The pane holding this composer has the keyboard. */
  active: boolean;
  /** Shared with the surface, so a click anywhere quiet can focus the input. */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  onSubmit: (text: string, images: AgentImageAttachment[]) => void;
  onInterrupt: () => void;
}

/** Tallest the composer grows before it scrolls instead. */
const MAX_ROWS = 10;

type MenuRow = {
  /** Value inserted / submitted. */
  value: string;
  /** Primary label in the list. */
  label: string;
  description: string;
  /** True when this is the session's current model/effort. */
  current: boolean;
  /** Project-relative path for file mention rows. */
  path?: string;
};

type Menu =
  | { kind: "commands"; rows: MenuRow[] }
  | { kind: "args"; command: "/model" | "/effort"; rows: MenuRow[] }
  | { kind: "files"; mention: FileMention; rows: MenuRow[] };

function buildMenu(value: string, session: AgentSessionState): Menu | null {
  if (!value.startsWith("/")) return null;

  // `/model …` or `/effort …` — guided argument list once the command is
  // complete (has a trailing space or partial arg). Bare `/model` still
  // shows the command list so Tab can complete it.
  const argMatch = /^(\/(?:model|effort))(?:\s+)(.*)$/i.exec(value);
  if (argMatch) {
    const command = argMatch[1].toLowerCase() as "/model" | "/effort";
    const partial = argMatch[2].toLowerCase();
    if (command === "/model") {
      const rows = session.models
        .filter((model) => {
          if (!partial) return true;
          return (
            model.id.toLowerCase().includes(partial) ||
            model.label.toLowerCase().includes(partial)
          );
        })
        .slice(0, 12)
        .map((model) => ({
          value: model.id,
          label: model.label || shortModelLabel(model.id),
          description: model.id !== model.label ? model.id : model.efforts.join(", "),
          current:
            session.model === model.id ||
            session.model === model.label ||
            (!!session.model && model.id.endsWith(`/${session.model}`)),
        }));
      if (rows.length) return { kind: "args", command, rows };
      return null;
    }
    const rows = effortsFor(session)
      .filter((effort) => !partial || effort.toLowerCase().startsWith(partial))
      .map((effort) => ({
        value: effort,
        label: effort,
        description: session.effort === effort ? "current" : "",
        current: session.effort === effort,
      }));
    if (rows.length) return { kind: "args", command, rows };
    return null;
  }

  // Command name completion: only while there is no space yet.
  if (value.includes(" ")) return null;
  const query = value.toLowerCase();
  const rows = session.commands
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .slice(0, 8)
    .map((command) => ({
      value: command.name,
      label: command.name,
      description: command.description,
      current: false,
    }));
  return rows.length ? { kind: "commands", rows } : null;
}

export function AgentComposer({ session, active, inputRef, onSubmit, onInterrupt }: Props) {
  const own = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = inputRef ?? own;
  const [value, setValue] = useState(() => agents.getDraft(session.termId));
  const [images, setImages] = useState(() => agents.getDraftImages(session.termId));
  const imagesRef = useRef(images);
  const [highlighted, setHighlighted] = useState(0);
  const [cursor, setCursor] = useState(value.length);
  const [fileRows, setFileRows] = useState<MenuRow[]>([]);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [fileDragging, setFileDragging] = useState(false);

  const working = session.status === "working";
  const ended = session.status === "exited" || session.status === "error";
  const exitArmed = session.exitArmed === true;
  const mention = useMemo(() => activeFileMention(value, cursor), [value, cursor]);
  const mentionKey = mention ? `${mention.start}:${mention.query}` : null;
  const commandMenu = buildMenu(value, session);
  const menu: Menu | null =
    mention && mentionKey !== dismissedMention && fileRows.length
      ? { kind: "files", mention, rows: fileRows }
      : commandMenu;
  const rows = menu?.rows ?? [];

  const change = (text: string, nextCursor?: number) => {
    setValue(text);
    setCursor(nextCursor ?? Math.min(cursor, text.length));
    setDismissedMention(null);
    agents.setDraft(session.termId, text);
  };

  const placeCursor = (position: number) => {
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(position, position);
      setCursor(position);
    });
  };

  const replaceImages = (
    update: AgentImageAttachment[] | ((current: AgentImageAttachment[]) => AgentImageAttachment[]),
  ) => {
    const next = typeof update === "function" ? update(imagesRef.current) : update;
    imagesRef.current = next;
    setImages(next);
    agents.setDraftImages(session.termId, next);
  };

  const addImageFiles = async (files: File[]) => {
    if (!files.length) {
      setAttachmentError("No image was found in the clipboard.");
      return;
    }
    const settled = await Promise.allSettled(files.map(imageFileToAttachment));
    const added = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failure = settled.find((result) => result.status === "rejected");
    const room = Math.max(0, MAX_PROMPT_IMAGES - imagesRef.current.length);
    if (failure?.status === "rejected") {
      setAttachmentError(
        failure.reason instanceof Error ? failure.reason.message : "Could not attach this image.",
      );
    } else if (added.length > room) {
      setAttachmentError(`You can attach up to ${MAX_PROMPT_IMAGES} images.`);
    } else {
      setAttachmentError(null);
    }
    replaceImages((current) => [...current, ...added.slice(0, room)]);
    ref.current?.focus();
  };

  const insertText = (text: string) => {
    const node = ref.current;
    const current = agents.getDraft(session.termId);
    const start = node?.selectionStart ?? current.length;
    const end = node?.selectionEnd ?? current.length;
    const next = insertComposerText(current, start, end, text);
    change(next.value, next.cursor);
    placeCursor(next.cursor);
  };

  const commit = (text: string) => {
    if (!text.trim() && imagesRef.current.length === 0) return;
    onSubmit(text, imagesRef.current);
    setValue("");
    setCursor(0);
    imagesRef.current = [];
    setImages([]);
    setAttachmentError(null);
    agents.setDraft(session.termId, "");
    agents.setDraftImages(session.termId, []);
  };

  useEffect(() => {
    if (!mention || mentionKey === dismissedMention) {
      setFileRows([]);
      return;
    }
    let cancelled = false;
    void loadWorkspaceIndex(session.cwd).then((files) => {
      if (cancelled) return;
      setFileRows(
        searchWorkspaceIndex(files, mention.query).map((file) => ({
          value: file.relative,
          label: file.name,
          description: file.relative,
          path: file.relative,
          current: false,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [session.cwd, mention?.query, mention?.start, mentionKey, dismissedMention]);

  // Grow with the text rather than scrolling a two-line box: a prompt is
  // usually a paragraph, and the composer is the only place to write it.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 20;
    node.style.height = `${Math.min(node.scrollHeight, lineHeight * MAX_ROWS)}px`;
  }, [value]);

  // Same registry the shell composer uses: pane activation, paste shortcuts,
  // and App's "keep OS focus on the active terminal" effect all call
  // terminals.focus(termId). Without a focuser here they land on the hidden
  // xterm grid, and typing vanishes while the message box looks selected.
  useEffect(() => {
    return terminals.registerInputFocus(session.termId, () => {
      if (ended) return;
      ref.current?.focus();
    });
  }, [session.termId, ended]);

  useEffect(() => {
    return terminals.registerInputPaste(session.termId, (text) => {
      if (ended) return;
      const node = ref.current;
      const current = agents.getDraft(session.termId);
      if (!node) {
        change(current + text);
        return;
      }
      const start = node.selectionStart ?? current.length;
      const end = node.selectionEnd ?? current.length;
      const next = current.slice(0, start) + text + current.slice(end);
      const pos = start + text.length;
      change(next, pos);
      placeCursor(pos);
    });
  }, [session.termId, ended]);

  // Alt+V is an explicit image-paste shortcut. Ctrl+V continues through the
  // browser's native paste event, which also preserves ordinary text pastes.
  useEffect(() => {
    if (!active || ended) return;
    const pasteImage = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.code !== "KeyV"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void clipboardImageFiles()
        .then(addImageFiles)
        .catch((error: unknown) => {
          setAttachmentError(
            error instanceof Error
              ? error.message
              : "Could not read an image from the clipboard.",
          );
        });
    };
    window.addEventListener("keydown", pasteImage, true);
    return () => window.removeEventListener("keydown", pasteImage, true);
  }, [active, ended, session.termId]);

  // Native OS file drops carry absolute paths through Tauri. A drop anywhere
  // inside the active custom terminal inserts those paths at the caret.
  useEffect(() => {
    if (!active || ended || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const isInsideSurface = (position: { toLogical: (scale: number) => { x: number; y: number } }) => {
      const surface = rootRef.current?.closest(".agent-surface");
      if (!surface) return false;
      const point = position.toLogical(window.devicePixelRatio);
      const rect = surface.getBoundingClientRect();
      return (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      );
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setFileDragging(false);
          return;
        }
        const inside = isInsideSurface(payload.position);
        if (payload.type === "enter" || payload.type === "over") {
          setFileDragging(inside);
          return;
        }
        setFileDragging(false);
        if (!inside || !payload.paths.length) return;
        insertText(formatDroppedPaths(payload.paths));
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });

    return () => {
      disposed = true;
      setFileDragging(false);
      unlisten?.();
    };
  }, [active, ended, session.termId]);

  useEffect(() => {
    if (active && !ended) ref.current?.focus();
  }, [active, ended]);

  useEffect(() => {
    setHighlighted(0);
  }, [menu?.kind, value]);

  const applyRow = (row: MenuRow) => {
    if (!menu) return;
    if (menu.kind === "files") {
      const next = replaceMention(value, menu.mention, row.path ?? row.value);
      change(next.value, next.cursor);
      setFileRows([]);
      placeCursor(next.cursor);
      return;
    }
    if (menu.kind === "commands") {
      // Trailing space opens the guided argument menu for /model and /effort.
      const next = `${row.value} `;
      change(next, next.length);
      placeCursor(next.length);
      return;
    }
    commit(`${menu.command} ${row.value}`);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // App-level shortcuts (new tab, palette, …) must still work from here.
    if (event.ctrlKey && event.shiftKey) return;

    if (rows.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + rows.length) % rows.length);
      return;
    }
    if (rows.length > 0 && event.key === "Tab") {
      event.preventDefault();
      applyRow(rows[highlighted]);
      return;
    }
    if (rows.length > 0 && event.key === "Escape") {
      event.preventDefault();
      if (menu?.kind === "files") {
        setDismissedMention(mentionKey);
        setFileRows([]);
      } else if (menu?.kind === "args") {
        // Back out to the bare command rather than wiping the draft.
        change(`${menu.command} `);
      } else {
        change("");
      }
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (menu && rows.length > 0) {
        if (menu.kind === "args" || menu.kind === "files") {
          applyRow(rows[highlighted]);
          return;
        }
        const selected = rows[highlighted];
        // Complete the command name (with a trailing space) instead of
        // submitting bare `/model` / `/effort`, so the options list opens.
        if (
          GUIDED_ARG_COMMANDS.has(selected.value.toLowerCase()) ||
          value.toLowerCase() !== selected.value.toLowerCase()
        ) {
          change(`${selected.value} `);
          return;
        }
      }
      commit(value);
      return;
    }

    // Ctrl+C is what a terminal user reaches for to stop a runaway turn, and
    // Escape is what the agent's own TUI uses. Both should mean the same here.
    if (
      working &&
      ((event.key.toLowerCase() === "c" && event.ctrlKey && !window.getSelection()?.toString()) ||
        (event.key === "Escape" && !value))
    ) {
      event.preventDefault();
      onInterrupt();
    }
  };

  if (ended) return null;

  /**
   * Clicks on the composer's chrome (padding, footer gap) still mean "type
   * here". Real controls (buttons, the textarea itself) keep their own
   * behaviour; everything else hands the keyboard to the message box.
   */
  const focusInputFromChrome = (event: React.MouseEvent) => {
    if (ended) return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea")) return;
    ref.current?.focus();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const direct = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    const files =
      direct.length > 0
        ? direct
        : Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .flatMap((item) => {
              const file = item.getAsFile();
              return file ? [file] : [];
            });
    if (!files.length) return;
    event.preventDefault();
    void addImageFiles(files);
  };

  return (
    <div
      ref={rootRef}
      className={`agent-composer${fileDragging ? " is-file-drag" : ""}`}
      onMouseDown={focusInputFromChrome}
    >
      {menu && rows.length > 0 && (
        <div
          className="agent-commands"
          role="listbox"
          aria-label={
            menu.kind === "commands"
              ? "Commands"
              : menu.kind === "files"
                ? "Files"
                : menu.command === "/model"
                  ? "Models"
                  : "Effort"
          }
        >
          {(menu.kind === "args" || menu.kind === "files") && (
            <div className="agent-commands-hint">
              {menu.kind === "files"
                ? "Mention a file"
                : menu.command === "/model"
                  ? "Model"
                  : "Reasoning effort"}
              <span>↑↓ · Enter</span>
            </div>
          )}
          {rows.map((row, index) => (
            <button
              key={`${row.value}-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              className={[
                index === highlighted ? "is-active" : "",
                row.current ? "is-current" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseDown={(event) => {
                event.preventDefault();
                applyRow(row);
                ref.current?.focus();
              }}
            >
              {menu.kind === "files" && (
                <svg className="agent-command-file" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 1.5h5l3 3v8H3z" />
                  <path d="M8 1.5v3h3" />
                </svg>
              )}
              <span className="agent-command-name">{row.label}</span>
              {row.description && (
                <span className="agent-command-desc">{row.description}</span>
              )}
              {row.current && (
                <span className="agent-command-current" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {exitArmed && (
        <div className="agent-exit-hint" role="status" aria-live="polite">
          <kbd>Ctrl+C</kbd>
          <span>again to close</span>
        </div>
      )}
      {fileDragging && (
        <div className="agent-file-drop-hint" role="status">
          Drop to insert the full path
        </div>
      )}
      <AgentImageAttachments
        images={images}
        variant="composer"
        onRemove={(id) => replaceImages((current) => current.filter((image) => image.id !== id))}
      />
      {attachmentError && (
        <div className="agent-attachment-error" role="status">
          {attachmentError}
        </div>
      )}
      <div className="agent-composer-row">
        <textarea
          ref={ref}
          className="agent-composer-input"
          value={value}
          rows={1}
          spellCheck={false}
          placeholder={
            exitArmed
              ? "Ctrl+C again to close"
              : working
                ? "Queue a follow-up…"
                : `Message ${session.label}…`
          }
          aria-label={`Message ${session.label}`}
          onChange={(event) => change(event.target.value, event.target.selectionStart)}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {/* No send button: Enter submits, and a button that only ever repeats
            a key everybody already presses is a permanent third of the row. */}
        {working && (
          <button
            type="button"
            className="agent-composer-stop"
            onClick={onInterrupt}
            title="Stop this turn (Ctrl+C)"
            aria-label="Stop this turn"
          >
            <span className="agent-stop-glyph" aria-hidden="true" />
          </button>
        )}
      </div>
      {/* T3-style footer: model + effort always available under the input.
          Picker changes use the adapter directly, without clearing the draft
          or exposing an internal slash command as a chat turn. */}
      <div className="agent-composer-footer">
        <AgentControls
          session={session}
          placement="composer"
          onSelect={(kind, value) => agents.configure(session.termId, kind, value)}
        />
      </div>
    </div>
  );
}
