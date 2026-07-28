import { uid } from "./layout";
import { newTermId, type InputMode } from "./terminals";
import type { LayoutNode, Tab } from "./types";
import { saveDurably } from "./durableStorage";

const KEY = "duckweed:state:v1";
const MAX_RECENTS = 12;
export const DEFAULT_TOOLS_WIDTH = 260;

export interface PersistedTab {
  /**
   * The tab's id, kept across restarts so per-tab data — checklists today —
   * finds its tab again. Absent in saves written before this existed; boot
   * mints a fresh one then, which loses nothing that was ever stored.
   */
  id?: string;
  title: string;
  root: LayoutNode;
  /** Folder this tab works in — projects belong to tabs, not to the window. */
  project: string | null;
  pinned?: boolean;
  /** Tab accent color id, or null/absent for default. */
  color?: string | null;
  /** Tab icon id, or null/absent for the default folder. */
  icon?: string | null;
}

export interface Persisted {
  version: 1;
  /** Last folder opened anywhere, used only to seed the folder picker. */
  project: string | null;
  recents: string[];
  fontSize: number;
  shell: string | null;
  /** Colourise output that arrives with no ANSI colour of its own. */
  highlight: boolean;
  /**
   * Mark finished background processes: rose outline on the pane and a
   * completion dot on the tab until the user reviews it.
   */
  completionHighlights: boolean;
  /** Play the bundled cue whenever a process or persistent agent finishes. */
  completionSoundEnabled: boolean;
  /**
   * Draw duckweed's own interface over a recognised coding-agent CLI instead
   * of its terminal UI.
   */
  customAgentUi: boolean;
  /** Warp-style command editor, or a conventional raw terminal. */
  inputMode: InputMode;
  /**
   * Ask before closing a pane, tab, or the window when a process is still
   * running. Users can turn this off from the dialog ("Don't show this again")
   * or from Settings.
   */
  confirmCloseRunning: boolean;
  /** Left tool dock: whether it is showing, and how wide it was left. */
  toolsOpen: boolean;
  toolsWidth: number;
  /** Layout only — processes are never restored, just the arrangement. */
  tabs: PersistedTab[];
  activeTabIndex: number;
}

function isLayout(node: unknown): node is LayoutNode {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "leaf") return true;
  if (n.kind === "split") {
    return (
      (n.dir === "row" || n.dir === "col") &&
      Array.isArray(n.children) &&
      n.children.length > 0 &&
      n.children.every(isLayout)
    );
  }
  return false;
}

/** Rebuild a saved tree with fresh pane and terminal ids. */
export function rehydrate(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return { kind: "leaf", id: uid("p"), term: newTermId() };
  const children = node.children.map(rehydrate);
  const sizes =
    Array.isArray(node.sizes) && node.sizes.length === children.length
      ? node.sizes
      : children.map(() => 1 / children.length);
  return { kind: "split", id: uid("s"), dir: node.dir, children, sizes };
}

export function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Persisted;
    if (parsed.version !== 1) return null;
    const project = typeof parsed.project === "string" ? parsed.project : null;
    const tabs = (parsed.tabs ?? [])
      .filter((t) => isLayout(t.root))
      // Written before projects moved onto tabs: every tab was in the one
      // window-wide project, so that is where they all belong now.
      .map((t) => ({
        ...t,
        id: typeof t.id === "string" && t.id ? t.id : undefined,
        project: typeof t.project === "string" ? t.project : project,
        pinned: t.pinned === true,
        color: typeof t.color === "string" ? t.color : null,
        icon: typeof t.icon === "string" ? t.icon : null,
      }));
    return {
      version: 1,
      project,
      recents: Array.isArray(parsed.recents) ? parsed.recents.slice(0, MAX_RECENTS) : [],
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : 13.5,
      shell: typeof parsed.shell === "string" ? parsed.shell : null,
      highlight: typeof parsed.highlight === "boolean" ? parsed.highlight : true,
      completionHighlights:
        typeof parsed.completionHighlights === "boolean" ? parsed.completionHighlights : true,
      completionSoundEnabled:
        typeof parsed.completionSoundEnabled === "boolean" ? parsed.completionSoundEnabled : true,
      // Default on, including for saves written before the setting existed.
      customAgentUi: typeof parsed.customAgentUi === "boolean" ? parsed.customAgentUi : true,
      inputMode: parsed.inputMode === "raw" ? "raw" : "editor",
      // Default on so a missing field from older saves still asks before killing work.
      confirmCloseRunning:
        typeof parsed.confirmCloseRunning === "boolean" ? parsed.confirmCloseRunning : true,
      toolsOpen: parsed.toolsOpen === true,
      toolsWidth: typeof parsed.toolsWidth === "number" ? parsed.toolsWidth : DEFAULT_TOOLS_WIDTH,
      tabs,
      activeTabIndex: typeof parsed.activeTabIndex === "number" ? parsed.activeTabIndex : 0,
    };
  } catch {
    return null;
  }
}

export function save(state: {
  project: string | null;
  recents: string[];
  fontSize: number;
  shell: string | null;
  highlight: boolean;
  completionHighlights: boolean;
  completionSoundEnabled: boolean;
  customAgentUi: boolean;
  inputMode: InputMode;
  confirmCloseRunning: boolean;
  toolsOpen: boolean;
  toolsWidth: number;
  tabs: Tab[];
  activeTabId: string;
}): void {
  try {
    const payload: Persisted = {
      version: 1,
      project: state.project,
      recents: state.recents.slice(0, MAX_RECENTS),
      fontSize: state.fontSize,
      shell: state.shell,
      highlight: state.highlight,
      completionHighlights: state.completionHighlights,
      completionSoundEnabled: state.completionSoundEnabled,
      customAgentUi: state.customAgentUi,
      inputMode: state.inputMode,
      confirmCloseRunning: state.confirmCloseRunning,
      toolsOpen: state.toolsOpen,
      toolsWidth: state.toolsWidth,
      tabs: state.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        root: t.root,
        project: t.project?.path ?? null,
        pinned: t.pinned === true ? true : undefined,
        color: t.color ?? null,
        icon: t.icon ?? null,
      })),
      activeTabIndex: Math.max(
        0,
        state.tabs.findIndex((t) => t.id === state.activeTabId),
      ),
    };
    const raw = JSON.stringify(payload);
    localStorage.setItem(KEY, raw);
    saveDurably(KEY, raw);
  } catch {
    // Storage can be unavailable (private mode, quota); layout persistence is
    // a convenience, never a requirement.
  }
}

export function pushRecent(recents: string[], path: string): string[] {
  return [path, ...recents.filter((p) => p !== path)].slice(0, MAX_RECENTS);
}
