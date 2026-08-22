import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentItem } from "./agents/types";
import type {
  Branches,
  Diff,
  DiffStats,
  DirEntry,
  FileContent,
  FileDiff,
  ProjectInfo,
  ProjectSearchResponse,
  ProjectSearchTarget,
  ShellInfo,
  WorkspacePath,
} from "./types";

export const listShells = () => invoke<ShellInfo[]>("list_shells");
export const homeDir = () => invoke<string>("home_dir");
export const projectInfo = (path: string) => invoke<ProjectInfo>("project_info", { path });
export const watchProject = (path: string | null) => invoke<void>("watch_project", { path });
export const frontendReady = () => invoke<void>("frontend_ready");
export const toggleWindowFullscreen = () => invoke<boolean>("toggle_window_fullscreen");
export const syncWebviewBounds = () => invoke<void>("sync_webview_bounds");

/** Open an http(s) URL in the system default browser (Ctrl/Cmd-click on links). */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/**
 * Play one completion cue from the app process instead of the WebView, so the
 * Windows volume mixer lists it as Duckweed. Resolves when the cue starts.
 */
export const playCompletionCue = (cueIndex: number) =>
  invoke<void>("play_completion_sound", { cueIndex });

export interface MobileDevice {
  id: string;
  name: string;
  pairedAt: number;
}

export interface PendingMobilePairing {
  id: string;
  expiresAt: number;
}

export interface MobileNotificationStatus {
  relayUrl: string;
  devices: MobileDevice[];
  pending: PendingMobilePairing | null;
}

export interface MobilePairingStart {
  id: string;
  qrPayload: string;
  expiresAt: number;
}

export interface MobileCompletionMessage {
  agent: string;
  project: string;
  projectId: string | null;
  terminalId: string | null;
  terminalTitle: string | null;
  kind: "completed" | "attention";
  response: string | null;
  durationMs: number | null;
  soundCue: number | null;
  unreadOnDesktop: boolean;
  /** Identifies the exact terminal completion this notification represents. */
  completionSeq: number | null;
}

export interface MobileTerminalSnapshot {
  id: string;
  title: string;
  shell: string;
  agent: string | null;
  model: string | null;
  status: "starting" | "idle" | "working" | "waiting" | "exited";
  /** Raw PTY grid or the structured agent conversation surface. */
  mode: "terminal" | "conversation";
  terminalColumns?: number;
  terminalRows?: number;
  unreadOnDesktop: boolean;
  /** Current terminal completion identity, used to reject stale read receipts. */
  completionSeq: number;
  /** Slash commands currently available in this agent session. */
  commands: MobileSlashCommandSnapshot[];
  /** Recent reasoning, plan, and tool steps shown inline with the conversation. */
  activity: MobileAgentActivitySnapshot[];
  conversation: MobileConversationSnapshot[];
  permission: MobilePermissionSnapshot | null;
  terminalOutput?: string;
}

export interface MobileSlashCommandSnapshot {
  name: string;
  description: string;
}

export interface MobileAgentActivitySnapshot {
  id: string;
  at: number;
  kind: "thinking" | "tool" | "plan";
  title: string;
  detail: string | null;
  /** Shell command kept separate from output so the phone can style it as code. */
  command: string | null;
  /** File edits attached to this tool call, including a bounded diff preview. */
  changes: MobileFileChangeSnapshot[];
  /** A plan stays one docked tracker on mobile instead of one timeline row per step. */
  planType?: "tasks" | "workflow";
  steps?: MobilePlanStepSnapshot[];
  status: "pending" | "running" | "done" | "error";
}

export interface MobilePlanStepSnapshot {
  text: string;
  status: "pending" | "running" | "done";
}

export interface MobileFileChangeSnapshot {
  path: string;
  insertions: number;
  deletions: number;
  diff: string | null;
}

export interface MobilePermissionOptionSnapshot {
  id: string;
  label: string;
  kind: "allow" | "allow-always" | "reject" | "reject-always";
}

export interface MobilePermissionSnapshot {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string | null;
  command: string | null;
  options: MobilePermissionOptionSnapshot[];
  questions: MobileQuestionSnapshot[];
}

export interface MobileQuestionOptionSnapshot {
  id: string;
  label: string;
  description: string;
  preview: string | null;
}

export interface MobileQuestionSnapshot {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: MobileQuestionOptionSnapshot[];
}

export interface MobileQuestionAnswerSnapshot {
  questionId: string;
  labels: string[];
  custom: string | null;
}

export interface MobileConversationSnapshot {
  id: string;
  sentAt: number;
  role: "user" | "assistant";
  text: string;
  /** True while the assistant response is still arriving from the provider. */
  streaming?: boolean;
}

export interface MobileProjectSnapshot {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  /** Desktop tab accent, shared with the companion app. */
  color?: string | null;
  terminals: MobileTerminalSnapshot[];
}

export interface MobileUsageLimitSnapshot {
  id: string;
  label: string;
  /** Provider-reported utilization, where 100 means the window is exhausted. */
  percent: number;
  resetsAt: number | null;
  /** Estimated hours of active use left, when the provider history supports it. */
  usageHoursLeft: number | null;
  /** Utilization points consumed per hour of continued use. */
  perHour: number | null;
  /** Utilization projected for the moment the window resets. */
  projectedPercent: number | null;
  /** Epoch ms this limit would hit 100%; null when the pace never gets there. */
  runsOutAt: number | null;
  /** Forecast basis from the desktop scan, including `exhausted`. */
  basis: "recent" | "blended" | "window" | "exhausted" | null;
}

export interface MobileUsageQuotaSnapshot {
  agent: string;
  label: string;
  plan: string | null;
  limits: MobileUsageLimitSnapshot[];
}

export interface MobileWorkspaceSnapshot {
  projects: MobileProjectSnapshot[];
  /** Compact provider-reported limits for the companion Settings page. */
  usageLimits?: MobileUsageQuotaSnapshot[];
}

export interface MobileRemoteCommand {
  deviceId: string;
  commandId: string;
  kind: "input" | "refresh" | "approval" | "question" | "read" | "create_terminal" | "close_terminal";
  terminalId: string | null;
  projectId: string | null;
  text: string | null;
  agent?: string | null;
  permissionId: string | null;
  optionId: string | null;
  completionSeq: number | null;
  answers: MobileQuestionAnswerSnapshot[];
  images: Array<{
    id: string;
    name: string;
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    dataUrl: string;
    size: number;
  }>;
}

export interface MobileSendResult {
  sent: number;
  failed: number;
  errors: string[];
}

/** Paired phones and any QR code that is still waiting to be scanned. */
export const mobileStatus = () =>
  invoke<MobileNotificationStatus>("mobile_status");

/** Create a ten-minute, single-use pairing QR payload. */
export const mobilePairStart = () =>
  invoke<MobilePairingStart>("mobile_pair_start");

/** Ask the relay whether the pending phone has finished pairing. */
export const mobilePairPoll = () =>
  invoke<MobileNotificationStatus>("mobile_pair_poll");

export const mobileDeviceRemove = (id: string) =>
  invoke<MobileNotificationStatus>("mobile_device_remove", { id });

export const mobileSendCompletion = (message: MobileCompletionMessage) =>
  invoke<MobileSendResult>("mobile_send_completion", { message });

// React effects can restart while a previous encrypted snapshot is still in
// flight. Keep sends ordered across effect lifetimes so an older "working"
// snapshot cannot reach the relay after the newer settled state.
let mobileWorkspaceSendQueue: Promise<void> = Promise.resolve();

export const mobileSendWorkspace = (snapshot: MobileWorkspaceSnapshot) => {
  const send = mobileWorkspaceSendQueue
    .catch(() => undefined)
    .then(() => invoke<MobileSendResult>("mobile_send_workspace", { snapshot }));
  mobileWorkspaceSendQueue = send.then(() => undefined, () => undefined);
  return send;
};

export const mobileSendPresence = () =>
  invoke<MobileSendResult>("mobile_send_presence");

export const mobilePollCommands = () =>
  invoke<MobileRemoteCommand[]>("mobile_poll_commands");

export const mobileAckCommand = (deviceId: string, commandId: string) =>
  invoke<void>("mobile_ack_command", { deviceId, commandId });

export const mobileSendTest = () =>
  invoke<MobileSendResult>("mobile_send_test");

/**
 * Suspend or shut the machine down, for the power watch.
 *
 * A sleep only resolves once the machine wakes up again — the caller should
 * treat resolution as "the OS took it", not as "it happened just now".
 */
export const powerAction = (action: "suspend" | "shutdown") =>
  invoke<void>("power_action", { action });

export interface PortForward {
  id: string;
  target_pid: number;
  target_port: number;
  url: string;
}

export interface AppPort {
  pid: number;
  port: number;
  address: string;
  process: string;
  owner_id: string;
  owner_kind: "terminal" | "agent";
  forward: PortForward | null;
}

export interface PortSnapshot {
  ports: AppPort[];
  scanned_at: number;
}

/** Listening TCP ports owned by terminal and agent process trees. */
export const portsList = () => invoke<PortSnapshot>("ports_list");

/** Stop the process currently owning this Duckweed-created listener. */
export const portClose = (pid: number, port: number) =>
  invoke<void>("port_close", { pid, port });

/** Expose a local HTTP listener through a temporary public tunnel. */
export const portForward = (pid: number, port: number) =>
  invoke<PortForward>("port_forward", { pid, port });

export const portForwardStop = (id: string) =>
  invoke<void>("port_forward_stop", { id });

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

/** Bounded project file index for agent `@` completion. */
export const workspacePaths = (path: string) =>
  invoke<WorkspacePath[]>("workspace_paths", { path });

/** Parallel, gitignore-aware literal search across open projects. */
export const projectSearch = (
  projects: ProjectSearchTarget[],
  query: string,
  generation: number,
) => invoke<ProjectSearchResponse>("project_search", { projects, query, generation });

/** Stop an older native walk when the query is cleared or replaced. */
export const cancelProjectSearch = (generation: number) =>
  invoke<void>("project_search_cancel", { generation });

/** Read a file for the project explorer's popup editor. */
export const readFile = (path: string) => invoke<FileContent>("read_file", { path });

/** Read a size-limited image that arrived through Tauri's native file drop. */
export const readDroppedImage = (path: string) =>
  invoke<number[]>("read_dropped_image", { path });

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

/** One line of an agent's headless protocol, or the notice that it ended. */
export type AgentFrame =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null };

export interface AgentAvailability {
  name: string;
  /** Absolute path when the executable is on PATH, else null. */
  path: string | null;
}

export interface AgentSpawnOptions {
  program: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string> | null;
}

export interface AgentStarted {
  program: string;
  pid: number | null;
}

/** One resumable conversation, read from an agent CLI's own session store. */
export interface AgentSessionSummary {
  /** What that agent's resume takes — a CLI flag value or a protocol id. */
  id: string;
  title: string;
  /** Epoch milliseconds of the newest activity. */
  updatedAt: number;
  /** Epoch milliseconds, or 0 when the record does not say. */
  createdAt: number;
  /** 0 when counting would have meant reading the whole transcript. */
  messageCount: number;
  /** Empty unless the record names the model it ran with. */
  model: string;
  path: string;
}

/** Past sessions `agent` recorded for `cwd`, newest first. Starts nothing. */
export const agentSessionsList = (agent: string, cwd: string) =>
  invoke<AgentSessionSummary[]>("agent_sessions_list", { agent, cwd });

/**
 * Normalized visible transcript from a selected session's durable record.
 *
 * Most agents replay history through their protocol. This is the fallback for
 * CLIs such as Claude Code that resume context without re-emitting old turns.
 */
export const agentSessionTranscript = (agent: string, cwd: string, sessionId: string) =>
  invoke<AgentItem[]>("agent_session_transcript", { agent, cwd, sessionId });

/** Which agent CLIs this machine has, without starting any of them. */
export const agentProcProbe = (names: string[]) =>
  invoke<AgentAvailability[]>("agent_proc_probe", { names });

/** Launch a coding agent in its line-delimited JSON mode. */
export const agentProcStart = (
  id: string,
  options: AgentSpawnOptions,
  onFrame: Channel<AgentFrame>,
) => invoke<AgentStarted>("agent_proc_start", { id, options, onFrame });

export const agentProcSend = (id: string, line: string) =>
  invoke<void>("agent_proc_send", { id, line });

/** End-of-input without killing the process. */
export const agentProcCloseStdin = (id: string) =>
  invoke<void>("agent_proc_close_stdin", { id });

export const agentProcStop = (id: string) => invoke<void>("agent_proc_stop", { id });

/** True when the shell for `id` has a child process (a command still running). */
export const ptyIsBusy = (id: string) => invoke<boolean>("pty_is_busy", { id });

/** True when any of the listed sessions has a command still running. */
export const ptyAnyBusy = (ids: string[]) => invoke<boolean>("pty_any_busy", { ids });
