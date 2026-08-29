import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  activeFileMention,
  clipboardImageFiles,
  droppedImageFile,
  droppedImageMimeType,
  formatDroppedPaths,
  imageFileToAttachment,
  insertComposerText,
  loadWorkspaceIndex,
  MAX_PROMPT_IMAGES,
  replaceMention,
  searchWorkspaceIndex,
  type FileMention,
} from "../../lib/agentComposer";
import { highlightAgentComposer } from "../../lib/agentComposerSyntax";
import * as bus from "../../lib/bus";
import {
  GUIDED_ARG_COMMANDS,
  INLINE_ARG_COMMANDS,
} from "../../lib/agents/slashCatalog";
import { subagentComposerCopy } from "../../lib/agents/subagents";
import {
  effortsFor,
  shortModelLabel,
  type AgentImageAttachment,
  type AgentSessionState,
} from "../../lib/agents/types";
import * as agents from "../../lib/agents/session";
import * as terminals from "../../lib/terminals";
import { cKeyAction } from "../../lib/platform";
import {
  isCaretOnFirstVisualLine,
  shouldNavigatePromptHistory,
} from "../../lib/textareaCaret";
import { AgentControls } from "./AgentControls";
import { AgentImageAttachments } from "./AgentImageAttachments";

interface Props {
  session: AgentSessionState;
  /** The pane holding this composer has the keyboard. */
  active: boolean;
  /** Shared with the surface, so a click anywhere quiet can focus the input. */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  onSubmit: (
    text: string,
    images: AgentImageAttachment[],
    delivery?: "default" | "alternate",
  ) => boolean | void;
  onInterrupt: () => void;
  /** When focused on a child, the composer talks to that subagent instead. */
  target?: {
    kind: "subagent";
    label: string;
    canMessage: boolean;
  };
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

export function AgentComposer({
  session,
  active,
  inputRef,
  onSubmit,
  onInterrupt,
  target,
}: Props) {
  const own = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const ref = inputRef ?? own;
  const [value, setValue] = useState(() => agents.getDraft(session.termId));
  const [images, setImages] = useState(() => agents.getDraftImages(session.termId));
  const imagesRef = useRef(images);
  /** Draft wiped by Ctrl+C — restored by the next Ctrl+Z while the box stays empty. */
  const undoClearRef = useRef<string | null>(null);
  /**
   * Index into this pane's submitted prompt history while ↑/↓ browsing.
   * null means not in history walk (queue pulls use {@link historyDraftRef} alone).
   */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  /** Composer text + images saved when the first ↑ leaves the live draft. */
  const historyDraftRef = useRef<{ text: string; images: AgentImageAttachment[] } | null>(
    null,
  );
  const [highlighted, setHighlighted] = useState(0);
  const [cursor, setCursor] = useState(value.length);
  const [fileRows, setFileRows] = useState<MenuRow[]>([]);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [fileDragging, setFileDragging] = useState(false);

  const working = session.status === "working";
  const loadingHistory = session.loadingHistory === true;
  const ended = session.status === "exited" || session.status === "error";
  const subagentCopy = target
    ? subagentComposerCopy(target.label, target.canMessage)
    : null;
  const exitArmed = session.exitArmed === true;
  const mention = useMemo(() => activeFileMention(value, cursor), [value, cursor]);
  const mentionKey = mention ? `${mention.start}:${mention.query}` : null;
  const commandMenu = buildMenu(value, session);
  const paintedTokens = useMemo(() => highlightAgentComposer(value), [value]);
  const showPaintedText = paintedTokens.some((token) => token.kind !== "plain");
  const menu: Menu | null =
    mention && mentionKey !== dismissedMention && fileRows.length
      ? { kind: "files", mention, rows: fileRows }
      : commandMenu;
  const rows = menu?.rows ?? [];

  const leaveHistoryBrowse = () => {
    setHistoryIndex(null);
    historyDraftRef.current = null;
  };

  const change = (text: string, nextCursor?: number) => {
    setValue(text);
    setCursor(nextCursor ?? Math.min(cursor, text.length));
    setDismissedMention(null);
    agents.setDraft(session.termId, text);
  };

  useEffect(
    () =>
      bus.on("term:clear-draft", ({ termId }) => {
        if (termId !== session.termId) return;
        setValue("");
        setCursor(0);
        setImages([]);
        imagesRef.current = [];
        setAttachmentError(null);
        leaveHistoryBrowse();
        undoClearRef.current = null;
        agents.setDraft(session.termId, "");
        agents.setDraftImages(session.termId, []);
      }),
    [session.termId],
  );

  const applyHistoryEntry = (text: string, nextImages: AgentImageAttachment[] = []) => {
    change(text, text.length);
    replaceImages(nextImages);
    placeCursor(text.length);
  };

  const rememberHistoryDraft = () => {
    if (historyDraftRef.current !== null || historyIndex !== null) return;
    historyDraftRef.current = {
      text: value,
      images: [...imagesRef.current],
    };
  };

  const restoreHistoryDraft = () => {
    const draft = historyDraftRef.current;
    leaveHistoryBrowse();
    if (!draft) {
      applyHistoryEntry("");
      return;
    }
    applyHistoryEntry(draft.text, draft.images);
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
    leaveHistoryBrowse();
    replaceImages((current) => [...current, ...added.slice(0, room)]);
    ref.current?.focus();
  };

  const insertText = (text: string) => {
    const node = ref.current;
    const current = agents.getDraft(session.termId);
    const start = node?.selectionStart ?? current.length;
    const end = node?.selectionEnd ?? current.length;
    const next = insertComposerText(current, start, end, text);
    leaveHistoryBrowse();
    change(next.value, next.cursor);
    placeCursor(next.cursor);
  };

  const commit = (text: string, delivery: "default" | "alternate" = "default") => {
    if (subagentCopy?.disabled) return;
    if (!text.trim() && imagesRef.current.length === 0) return;
    if (onSubmit(text, imagesRef.current, delivery) === true) return;
    undoClearRef.current = null;
    leaveHistoryBrowse();
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
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = node.scrollTop;
      mirrorRef.current.scrollLeft = node.scrollLeft;
    }
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
      leaveHistoryBrowse();
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
        const imagePaths = payload.paths.filter((path) => droppedImageMimeType(path));
        const otherPaths = payload.paths.filter((path) => !droppedImageMimeType(path));
        if (otherPaths.length) insertText(formatDroppedPaths(otherPaths));
        if (imagePaths.length) {
          void Promise.all(imagePaths.map(droppedImageFile))
            .then(addImageFiles)
            .catch((error: unknown) => {
              setAttachmentError(
                error instanceof Error ? error.message : "Could not attach this image.",
              );
            });
        }
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

  // Pane swap reuses this component only via key=termId usually; still reseed
  // browse state if termId changes without an unmount.
  useEffect(() => {
    leaveHistoryBrowse();
  }, [session.termId]);

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

    // ↑/↓ prompt history (shell-style). Queued follow-ups come first; further
    // ups walk this pane's submitted prompts. A new walk only starts from the
    // first rendered line, including lines created by automatic text wrapping.
    if (
      rows.length === 0 &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      const el = event.currentTarget;
      const key = event.key as "ArrowUp" | "ArrowDown";
      const browsingHistory = historyIndex !== null || historyDraftRef.current !== null;
      const caretOnFirstLine =
        key === "ArrowUp" && !browsingHistory
          ? isCaretOnFirstVisualLine(el)
          : false;

      if (!shouldNavigatePromptHistory(key, browsingHistory, caretOnFirstLine)) {
        // Let the textarea move its caret between rendered lines.
        return;
      }

      if (event.key === "ArrowUp") {
        if (historyIndex === null) {
          // Prefer the newest waiting follow-up before submitted history.
          const queued = agents.editLastQueued(session.termId);
          if (queued) {
            event.preventDefault();
            rememberHistoryDraft();
            applyHistoryEntry(queued.text, queued.images);
            return;
          }
        }
        const hist = agents.localPromptHistory(session.termId);
        if (hist.length === 0) {
          if (historyDraftRef.current !== null && historyIndex === null) {
            // Still "browsing" after a queue pull with no history — stay put.
            event.preventDefault();
          }
          return;
        }
        event.preventDefault();
        rememberHistoryDraft();
        const next =
          historyIndex === null ? hist.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(next);
        applyHistoryEntry(hist[next] ?? "");
        return;
      } else {
        // ArrowDown
        if (historyIndex !== null) {
          event.preventDefault();
          const hist = agents.localPromptHistory(session.termId);
          if (historyIndex >= hist.length - 1) {
            restoreHistoryDraft();
            return;
          }
          const next = historyIndex + 1;
          setHistoryIndex(next);
          applyHistoryEntry(hist[next] ?? "");
          return;
        }
        if (historyDraftRef.current !== null) {
          // Pulled a queued prompt (or left history) — next ↓ restores draft.
          event.preventDefault();
          restoreHistoryDraft();
          return;
        }
      }
    }

    if (
      event.key === "Enter" &&
      event.altKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      commit(value, "alternate");
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
        // Complete commands that expect an argument instead of submitting the
        // bare name. Guided commands open their picker; side commands leave a
        // clean insertion point for the question.
        if (
          GUIDED_ARG_COMMANDS.has(selected.value.toLowerCase()) ||
          INLINE_ARG_COMMANDS.has(selected.value.toLowerCase()) ||
          value.toLowerCase() !== selected.value.toLowerCase()
        ) {
          change(`${selected.value} `);
          return;
        }
      }
      commit(value);
      return;
    }

    // Ctrl+C with draft text clears the box (shell editor / Warp). Empty
    // Ctrl+C is the custom-UI close gesture handled in App (capture phase).
    // On macOS Cmd+C only copies; it must not wipe the draft.
    // Escape still stops a runaway turn when the box is empty.
    if (event.key.toLowerCase() === "c") {
      const el = event.currentTarget;
      const fieldSelection =
        el.selectionStart !== el.selectionEnd
          ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
          : "";
      const pageSelection = window.getSelection()?.toString() ?? "";
      const hasCopyable = Boolean(
        (fieldSelection && /\S/.test(fieldSelection)) ||
          (pageSelection && /\S/.test(pageSelection)),
      );
      const action = cKeyAction(event, hasCopyable);
      if (action === "copy") {
        // Field or page selection: let the browser / OS copy path run.
        return;
      }
      if (action === "control") {
        // Only the "copy" branch above leaves selection alone. On Apple Ctrl+C
        // is never copy, so a selected draft (or page selection) must still
        // clear/interrupt rather than falling through to the browser.
        if (value.length > 0) {
          event.preventDefault();
          undoClearRef.current = value;
          leaveHistoryBrowse();
          change("");
          placeCursor(0);
          return;
        }
        if (working) {
          event.preventDefault();
          onInterrupt();
        }
        return;
      }
    }

    // Ctrl+Z restores a draft just wiped by Ctrl+C (while the box is still empty).
    // Programmatic clears don't join the browser undo stack, so we keep our own.
    if (
      event.key.toLowerCase() === "z" &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      value.length === 0 &&
      undoClearRef.current !== null
    ) {
      event.preventDefault();
      const restored = undoClearRef.current;
      undoClearRef.current = null;
      change(restored);
      placeCursor(restored.length);
      return;
    }

    if (working && event.key === "Escape" && !value) {
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
      className={[
        "agent-composer",
        session.serviceTier === "priority" ? "is-fast" : "",
        fileDragging ? "is-file-drag" : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
          Drop to attach images or insert paths
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
        <div className="agent-composer-editor">
          {showPaintedText && (
            <div ref={mirrorRef} className="agent-composer-mirror" aria-hidden="true">
              {paintedTokens.map((token, index) => (
                <span key={index} className={`agent-composer-token token-${token.kind}`}>
                  {token.text}
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={ref}
            className={`agent-composer-input${showPaintedText ? " has-painted-text" : ""}`}
            value={value}
            rows={1}
            spellCheck={false}
            placeholder={
              subagentCopy
                ? subagentCopy.placeholder
                : exitArmed
                  ? "Ctrl+C again to close"
                  : loadingHistory
                    ? "Queue a message after the conversation loads..."
                    : working
                      ? agents.getFollowupMode() === "steer"
                        ? "Steer this turn…"
                        : "Queue a follow-up…"
                      : `Message ${session.label}…`
            }
            aria-label={subagentCopy ? subagentCopy.ariaLabel : `Message ${session.label}`}
            disabled={Boolean(subagentCopy?.disabled)}
            onChange={(event) => {
              // Typing after a Ctrl+C clear discards that one-shot undo.
              if (undoClearRef.current !== null) undoClearRef.current = null;
              // Manual edits leave history browse; the buffer is the new draft.
              leaveHistoryBrowse();
              change(event.target.value, event.target.selectionStart);
            }}
            onClick={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
            onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={(event) => {
              if (!mirrorRef.current) return;
              mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
              mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }}
          />
        </div>
        {/* No send button: Enter submits, and a button that only ever repeats
            a key everybody already presses is a permanent third of the row. */}
        {working && (
          <button
            type="button"
            className="agent-composer-stop"
            onClick={onInterrupt}
            title={
              loadingHistory ? "Cancel loading this conversation" : "Stop this turn (Ctrl+C)"
            }
            aria-label={loadingHistory ? "Cancel loading conversation" : "Stop this turn"}
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
