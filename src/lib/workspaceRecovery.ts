import { readStoredValue, saveDurably } from "./durableStorage";
import type { AgentLaunch } from "./agents/launch";
import { AGENT_IDS } from "./agents/catalog";
import type { AgentImageAttachment, AgentItem, AgentPrompt, AgentSessionState } from "./agents/types";
import type { ScheduledSend, TimedSend } from "./scheduledSend";

export const RECOVERY_KEY = "duckweed:workspace-recovery:v1";

export interface AgentRecovery {
  launch: AgentLaunch;
  cwd: string;
  sessionId: string | null;
  draft: string;
  images: AgentImageAttachment[];
  history: string[];
  queued: Array<{ id: string; prompt: AgentPrompt; echoed: boolean }>;
  queuePaused?: boolean;
  items: AgentItem[];
  usage: AgentSessionState["usage"];
  goal?: AgentSessionState["goal"];
  serviceTier?: string | null;
}

export interface PaneRecovery {
  cwd?: string;
  shell?: string | null;
  title?: string;
  draft?: string;
  history?: string[];
  agent?: AgentRecovery | null;
  timed?: TimedSend | null;
  scheduled?: ScheduledSend | null;
}

interface RecoveryState {
  version: 1;
  savedAt: number;
  panes: Record<string, PaneRecovery>;
}

function validAgent(agent: AgentRecovery | null | undefined): agent is AgentRecovery {
  const launch = agent?.launch;
  return !!agent && !!launch && AGENT_IDS.includes(launch.agent) &&
    typeof launch.program === "string" && typeof agent.cwd === "string" &&
    !!launch.env && typeof launch.env === "object" &&
    [launch.args, launch.wrapperArgs, launch.forwardArgs, agent.history].every((rows) =>
      Array.isArray(rows) && rows.every((row) => typeof row === "string")) &&
    Array.isArray(agent.items) && agent.items.every((item) => item && typeof item.kind === "string") &&
    Array.isArray(agent.queued) && agent.queued.every((entry) => entry &&
      typeof entry.id === "string" && typeof entry.prompt?.text === "string" && Array.isArray(entry.prompt.images)) &&
    Array.isArray(agent.images) && typeof agent.draft === "string" && !!agent.usage;
}

export function parseRecovery(raw: string | null): RecoveryState {
  const empty: RecoveryState = { version: 1, savedAt: 0, panes: {} };
  try {
    const value = JSON.parse(raw ?? "null");
    if (value?.version !== 1 || !value.panes || typeof value.panes !== "object" || Array.isArray(value.panes)) return empty;
    const panes: Record<string, PaneRecovery> = {};
    for (const [id, candidate] of Object.entries(value.panes)) {
      if (!candidate || typeof candidate !== "object") continue;
      const pane = candidate as PaneRecovery;
      panes[id] = {
        cwd: typeof pane.cwd === "string" ? pane.cwd : undefined,
        shell: typeof pane.shell === "string" ? pane.shell : null,
        title: typeof pane.title === "string" ? pane.title : undefined,
        draft: typeof pane.draft === "string" ? pane.draft : "",
        history: Array.isArray(pane.history) ? pane.history.filter((entry) => typeof entry === "string") : [],
        timed: pane.timed && Number.isFinite(pane.timed.at) ? pane.timed : null,
        scheduled: typeof pane.scheduled?.targetTermId === "string" &&
          typeof pane.scheduled.targetLabel === "string" ? pane.scheduled : null,
        agent: validAgent(pane.agent) ? pane.agent : null,
      };
    }
    return { version: 1, savedAt: Number.isFinite(value.savedAt) ? value.savedAt : 0, panes };
  } catch {
    return empty;
  }
}

export const RECOVERY_SAVE_INTERVAL_MS = 250;

type ScheduleSave = (save: () => void) => () => void;

const scheduleSave: ScheduleSave = (save) => {
  const timer = setTimeout(save, RECOVERY_SAVE_INTERVAL_MS);
  return () => clearTimeout(timer);
};

/**
 * Updates are immediately readable, including for unmounted panes. Batch disk
 * checkpoints across all sessions so typing never serializes every transcript.
 * The timer is not reset by edits, so continuous output still reaches disk.
 */
export function createRecoveryStore(
  read: () => string | null,
  write: (raw: string) => void,
  schedule: ScheduleSave = scheduleSave,
) {
  let state: RecoveryState | null = null;
  let frozen = false;
  let dirty = false;
  let cancelSave: (() => void) | null = null;
  // Recovery patches replace pane snapshots. Reuse JSON for untouched panes
  // instead of walking their histories and image attachments on every save.
  const serialized = new Map<string, { pane: PaneRecovery; json: string }>();
  const load = () => state ??= parseRecovery(read());
  const flush = () => {
    cancelSave?.();
    cancelSave = null;
    if (!dirty) return;
    const current = load();
    current.savedAt = Math.max(Date.now(), current.savedAt + 1);
    const panes = Object.entries(current.panes).map(([id, pane]) => {
      let cached = serialized.get(id);
      if (cached?.pane !== pane) {
        cached = { pane, json: `${JSON.stringify(id)}:${JSON.stringify(pane)}` };
        serialized.set(id, cached);
      }
      return cached.json;
    });
    write(`{"version":1,"savedAt":${current.savedAt},"panes":{${panes.join(",")}}}`);
    dirty = false;
  };
  const persist = () => {
    dirty = true;
    cancelSave ??= schedule(flush);
  };
  return {
    get(id: string): PaneRecovery | undefined { return load().panes[id]; },
    update(id: string, patch: Partial<PaneRecovery>) {
      if (frozen) return;
      const previous = load().panes[id];
      if (previous && Object.entries(patch).every(([key, value]) =>
        previous[key as keyof PaneRecovery] === value)) return;
      load().panes[id] = { ...previous, ...patch };
      persist();
    },
    prune(ids: string[]) {
      if (frozen) return;
      const keep = new Set(ids);
      let changed = false;
      for (const id of Object.keys(load().panes)) {
        if (!keep.has(id)) {
          delete load().panes[id];
          serialized.delete(id);
          changed = true;
        }
      }
      for (const [id, pane] of Object.entries(load().panes)) {
        if (pane.scheduled && !keep.has(pane.scheduled.targetTermId)) {
          load().panes[id] = { ...pane, scheduled: null };
          changed = true;
        }
      }
      if (changed) persist();
    },
    remove(id: string) {
      if (frozen) return;
      let changed = Object.hasOwn(load().panes, id);
      delete load().panes[id];
      serialized.delete(id);
      for (const [paneId, pane] of Object.entries(load().panes)) {
        if (pane.scheduled?.targetTermId === id) {
          load().panes[paneId] = { ...pane, scheduled: null };
          changed = true;
        }
      }
      if (changed) persist();
    },
    flush,
    freeze() {
      flush();
      frozen = true;
    },
  };
}

export const workspaceRecovery = createRecoveryStore(
  () => readStoredValue(RECOVERY_KEY),
  (raw) => {
    try { (globalThis.window?.localStorage ?? globalThis.localStorage).setItem(RECOVERY_KEY, raw); }
    catch (error) { console.error("failed to save local workspace recovery", error); }
    // Images can exceed the WebView quota. Still save the native copy.
    saveDurably(RECOVERY_KEY, raw);
  },
);
