import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Branches,
  Diff,
  DiffStats,
  DirEntry,
  FileContent,
  FileDiff,
  ProjectInfo,
  ShellInfo,
} from "./types";

export const listShells = () => invoke<ShellInfo[]>("list_shells");
export const homeDir = () => invoke<string>("home_dir");
export const projectInfo = (path: string) => invoke<ProjectInfo>("project_info", { path });
export const watchProject = (path: string | null) => invoke<void>("watch_project", { path });
export const frontendReady = () => invoke<void>("frontend_ready");

/** Folder request from Explorer / the CLI, if the app was cold-started with one. */
export type LaunchAction = "new_tab" | "new_window";

export interface LaunchIntent {
  action: LaunchAction;
  path: string;
}

export const takeLaunchIntent = () => invoke<LaunchIntent | null>("take_launch_intent");

export type ShellVerb = "tab" | "window";

export interface ShellIntegrationStatus {
  tab: boolean;
  window: boolean;
}

/**
 * Whether Explorer shows each Duckweed folder right-click verb.
 * `null` on non-Windows platforms where the setting does not apply.
 */
export const shellIntegrationStatus = () =>
  invoke<ShellIntegrationStatus | null>("shell_integration_status");

export const shellIntegrationSet = (verb: ShellVerb, enabled: boolean) =>
  invoke<ShellIntegrationStatus>("shell_integration_set", { verb, enabled });

/** One level of a folder: folders first, then files, ignored entries flagged. */
export const listDir = (path: string) => invoke<DirEntry[]>("list_dir", { path });

/** Read a file for the project explorer's popup editor. */
export const readFile = (path: string) => invoke<FileContent>("read_file", { path });

/** Save the popup editor's buffer. */
export const writeFile = (path: string, content: string) =>
  invoke<void>("write_file", { path, content });

export const gitBranches = (path: string) => invoke<Branches>("git_branches", { path });

export const gitCheckout = (path: string, branch: string) =>
  invoke<void>("git_checkout", { path, branch });

/** Counts only — cheap enough to poll while the window has focus. */
export const gitDiffStats = (path: string) => invoke<DiffStats>("git_diff_stats", { path });

/** Every uncommitted change, with the three context lines a patch carries. */
export const gitDiff = (path: string) => invoke<Diff>("git_diff", { path });

/** One file with its unmodified lines filled back in. */
export const gitFileDiff = (path: string, file: string) =>
  invoke<FileDiff>("git_file_diff", { path, file });

export interface SpawnResult {
  id: string;
  shell_id: string;
  shell_label: string;
  program: string;
  cwd: string;
}

export const ptySpawn = (args: {
  id: string;
  cwd?: string | null;
  shell?: string | null;
  cols: number;
  rows: number;
}, onData: Channel<ArrayBuffer>) =>
  invoke<SpawnResult>("pty_spawn", {
    ...args,
    onData,
    cols: Math.round(args.cols),
    rows: Math.round(args.rows),
  });

export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols: Math.round(cols), rows: Math.round(rows) });

export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

/** Bind a persistent coding-agent session to its on-disk turn-completion log. */
export const agentWatch = (id: string, agent: string, cwd: string) =>
  invoke<void>("agent_watch", { id, agent, cwd });

export const agentUnwatch = (id: string) => invoke<void>("agent_unwatch", { id });

/** True when the shell for `id` has a child process (a command still running). */
export const ptyIsBusy = (id: string) => invoke<boolean>("pty_is_busy", { id });

/** True when any of the listed sessions has a command still running. */
export const ptyAnyBusy = (ids: string[]) => invoke<boolean>("pty_any_busy", { ids });
