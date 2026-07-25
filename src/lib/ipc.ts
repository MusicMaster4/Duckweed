import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo, ShellInfo } from "./types";

export const listShells = () => invoke<ShellInfo[]>("list_shells");
export const homeDir = () => invoke<string>("home_dir");
export const projectInfo = (path: string) => invoke<ProjectInfo>("project_info", { path });

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
}) => invoke<SpawnResult>("pty_spawn", { ...args, cols: Math.round(args.cols), rows: Math.round(args.rows) });

export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols: Math.round(cols), rows: Math.round(rows) });

export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

/** True when the shell for `id` has a child process (a command still running). */
export const ptyIsBusy = (id: string) => invoke<boolean>("pty_is_busy", { id });

/** True when any of the listed sessions has a command still running. */
export const ptyAnyBusy = (ids: string[]) => invoke<boolean>("pty_any_busy", { ids });
