import { uid } from "./layout";
import { newTermId, type InputMode } from "./terminals";
import type { LayoutNode, Tab } from "./types";

const KEY = "duckweed:state:v1";
const MAX_RECENTS = 12;
export const DEFAULT_TOOLS_WIDTH = 260;

export interface PersistedTab {
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
  /** Warp-style command editor, or a conventional raw terminal. */
  inputMode: InputMode;
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
      inputMode: parsed.inputMode === "raw" ? "raw" : "editor",
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
  inputMode: InputMode;
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
      inputMode: state.inputMode,
      toolsOpen: state.toolsOpen,
      toolsWidth: state.toolsWidth,
      tabs: state.tabs.map((t) => ({
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
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Storage can be unavailable (private mode, quota); layout persistence is
    // a convenience, never a requirement.
  }
}

export function pushRecent(recents: string[], path: string): string[] {
  return [path, ...recents.filter((p) => p !== path)].slice(0, MAX_RECENTS);
}
