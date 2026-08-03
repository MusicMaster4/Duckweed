export type Dir = "row" | "col";

/** A single terminal occupying a rectangle of the tab. */
export interface LeafNode {
  kind: "leaf";
  id: string;
  /** Key into the terminal registry. */
  term: string;
  /** Held at the top of the fullscreen switcher; does not change the layout. */
  pinned?: boolean;
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
  /** Pinned tabs stay on the left of the strip. */
  pinned?: boolean;
  /** Optional accent color id for finding this tab at a glance. */
  color?: string | null;
  /** Optional tab icon id; null/absent keeps the default folder. */
  icon?: string | null;
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

/** One row of the project explorer's tree. */
export interface DirEntry {
  name: string;
  /** Absolute path — the tree never joins paths itself. */
  path: string;
  is_dir: boolean;
  /** git ignores this entry; still listed, just dimmed. */
  ignored: boolean;
}

/** A file available to the agent composer's `@` completion. */
export interface WorkspacePath {
  name: string;
  /** Absolute path, used for tooltips. */
  path: string;
  /** Project-relative path inserted in the prompt. */
  relative: string;
}

/** What the project explorer's file popup loads from disk. */
export interface FileContent {
  path: string;
  /** Empty when binary or too large. */
  content: string;
  binary: boolean;
  too_large: boolean;
  /** Bytes on disk. */
  size: number;
}

/** A project included in the explorer's cross-project text search. */
export interface ProjectSearchTarget {
  path: string;
  name: string;
}

/** One literal text occurrence returned by the native project search. */
export interface ProjectSearchMatch {
  project_path: string;
  project_name: string;
  path: string;
  relative: string;
  line: number;
  /** UTF-16 offsets line up with textarea selectionStart/selectionEnd. */
  column: number;
  match_length: number;
  line_text: string;
}

export interface ProjectSearchResponse {
  matches: ProjectSearchMatch[];
  files_scanned: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface EditorReveal {
  line: number;
  column: number;
  matchLength: number;
}

export interface Branches {
  /** Branch HEAD points at, or null on a detached HEAD. */
  current: string | null;
  local: string[];
  /** `origin/feature` names with no local branch yet. */
  remote: string[];
}

/** What the status-bar chip counts: uncommitted work, at a glance. */
export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  /** Number this line had before the change — null on an added line. */
  old: number | null;
  /** Number this line has now — null on a removed line. */
  new: number | null;
  text: string;
}

export interface DiffHunk {
  old_start: number;
  new_start: number;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface FileDiff {
  /** Relative to the repo root, in git's forward-slash form. */
  path: string;
  /** Where a renamed file came from. */
  old_path: string | null;
  status: FileStatus;
  insertions: number;
  deletions: number;
  /** Nothing to show: a binary file, or one too large to read. */
  binary: boolean;
  /** Lines the file has now — what sizes the run after the last hunk. */
  new_lines: number;
  hunks: DiffHunk[];
}

export interface Diff {
  /** Repo root; the paths inside are relative to it, not to the tab's folder. */
  root: string;
  stats: DiffStats;
  files: FileDiff[];
}

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

export interface DropTarget {
  paneId: string;
  zone: DropZone;
}
