import * as terminals from "../lib/terminals";
import type { ProjectInfo } from "../lib/types";

interface Props {
  project: ProjectInfo | null;
  paneCount: number;
  tabCount: number;
  activeTerm: string | null;
  fontSize: number;
  onFontSize: (size: number) => void;
}

export function StatusBar({ project, paneCount, tabCount, activeTerm, fontSize, onFontSize }: Props) {
  const meta = activeTerm ? terminals.getMeta(activeTerm) : null;

  return (
    <footer className="statusbar">
      <span className="status-item status-path" title={meta?.cwd || project?.path || ""}>
        {meta?.cwd || project?.path || "no project"}
      </span>
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
