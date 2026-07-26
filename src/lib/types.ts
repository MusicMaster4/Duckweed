export type Dir = "row" | "col";

/** A single terminal occupying a rectangle of the tab. */
export interface LeafNode {
  kind: "leaf";
  id: string;
  /** Key into the terminal registry. */
  term: string;
}

/** A row or column of children, sized by fractions that sum to 1. */
export interface SplitNode {
  kind: "split";
  id: string;
  dir: Dir;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = LeafNode | SplitNode;

export interface Tab {
  id: string;
  title: string;
  root: LayoutNode;
  /** Leaf id of the pane that had focus in this tab. */
  activeLeaf: string;
  /** Leaf id rendered full-tab, hiding its siblings. */
  zoomedLeaf: string | null;
  /** Folder this tab works in. Each tab can hold a different project. */
  project: ProjectInfo | null;
}

export interface ShellInfo {
  id: string;
  label: string;
  program: string;
  args: string[];
}

export interface ProjectInfo {
  path: string;
  name: string;
  branch: string | null;
  is_git: boolean;
}

export interface Branches {
  /** Branch HEAD points at, or null on a detached HEAD. */
  current: string | null;
  local: string[];
  /** `origin/feature` names with no local branch yet. */
  remote: string[];
}

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

export interface DropTarget {
  paneId: string;
  zone: DropZone;
}
