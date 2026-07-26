import type { Updater } from "../hooks/useUpdater";
import * as terminals from "../lib/terminals";
import type { DiffStats, ProjectInfo } from "../lib/types";
import { BranchMenu } from "./BranchMenu";

interface Props {
  project: ProjectInfo | null;
  paneCount: number;
  tabCount: number;
  activeTerm: string | null;
  fontSize: number;
  onFontSize: (size: number) => void;
  updater: Updater;
  /** Uncommitted work in the visible tab, or null when there is no repo. */
  changes: DiffStats | null;
  onOpenChanges: () => void;
  /** Re-read the active project after switching branches. */
  onProjectRefresh: () => void;
}

const FileIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M4 2.5h4.5L12 6v7.5H4z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path d="M8.5 2.5V6H12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

/** What the version chip says — it doubles as the update indicator. */
function updateLabel({ status, version, channel }: Updater): string {
  switch (status.kind) {
    case "checking":
      return "checking…";
    case "available":
      return `update to ${status.update.version}`;
    case "installing":
      return status.fraction === null
        ? "installing…"
        : `installing ${Math.round(status.fraction * 100)}%`;
    default:
      return `v${version || "?"}${channel === "testing" ? " beta" : ""}`;
  }
}

export function StatusBar({
  project,
  paneCount,
  tabCount,
  activeTerm,
  fontSize,
  onFontSize,
  updater,
  changes,
  onOpenChanges,
  onProjectRefresh,
}: Props) {
  const meta = activeTerm ? terminals.getMeta(activeTerm) : null;
  const alert = updater.status.kind === "available" || updater.status.kind === "installing";

  return (
    <footer className="statusbar">
      <span className="status-item status-path" title={meta?.cwd || project?.path || ""}>
        {meta?.cwd || project?.path || "no project"}
      </span>
      {project?.is_git && (
        <div className="status-git">
          <BranchMenu project={project} onSwitched={onProjectRefresh} />
          {/* A clean tree says nothing: the chip appears the moment there is work
              in it, which is the only time its numbers mean anything. */}
          {changes && changes.files > 0 && (
            <button
              type="button"
              className="status-diff"
              title={`${changes.files} changed file${changes.files === 1 ? "" : "s"} — click to review the diff (Ctrl+Shift+G)`}
              onClick={onOpenChanges}
            >
              <FileIcon />
              <span className="status-diff-files">{changes.files}</span>
              <span className="status-diff-dot">•</span>
              <span className="status-diff-add">+{changes.insertions}</span>
              <span className="status-diff-del">−{changes.deletions}</span>
            </button>
          )}
        </div>
      )}
      <span className="status-spacer" />
      {meta && (
        <span className="status-item" title="Shell">
          {meta.shellLabel || "shell"}
        </span>
      )}
      {meta && (
        <span className="status-item" title="Terminal size">
          {meta.cols}×{meta.rows}
        </span>
      )}
      <span className="status-item">
        {paneCount} pane{paneCount === 1 ? "" : "s"} · {tabCount} tab{tabCount === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        className={`status-update ${alert ? "is-alert" : ""}`}
        onClick={updater.check}
        title={
          updater.channel === "testing"
            ? "Beta channel — check for updates (beta releases only)"
            : "Stable channel — check for updates (stable releases only)"
        }
      >
        {updateLabel(updater)}
      </button>
      <span className="status-zoom">
        <button type="button" title="Decrease font size (Ctrl+-)" onClick={() => onFontSize(fontSize - 1)}>
          −
        </button>
        <button type="button" title="Reset font size (Ctrl+0)" onClick={() => onFontSize(13.5)}>
          {Math.round(fontSize * 10) / 10}px
        </button>
        <button type="button" title="Increase font size (Ctrl+=)" onClick={() => onFontSize(fontSize + 1)}>
          +
        </button>
      </span>
    </footer>
  );
}
