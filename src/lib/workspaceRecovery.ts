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

/** Session state is saved while editing, including panes that are not mounted. */
export function createRecoveryStore(read: () => string | null, write: (raw: string) => void) {
  let state: RecoveryState | null = null;
  let frozen = false;
  const load = () => state ??= parseRecovery(read());
  const persist = () => {
    const current = load();
    current.savedAt = Math.max(Date.now(), current.savedAt + 1);
    write(JSON.stringify(current));
  };
  return {
    get(id: string): PaneRecovery | undefined { return load().panes[id]; },
    update(id: string, patch: Partial<PaneRecovery>) {
      if (frozen) return;
      load().panes[id] = { ...load().panes[id], ...patch };
      persist();
    },
    prune(ids: string[]) {
      if (frozen) return;
      const keep = new Set(ids);
      for (const id of Object.keys(load().panes)) {
        if (!keep.has(id)) delete load().panes[id];
      }
      for (const pane of Object.values(load().panes)) {
        if (pane.scheduled && !keep.has(pane.scheduled.targetTermId)) pane.scheduled = null;
      }
      persist();
    },
    remove(id: string) {
      if (frozen) return;
      delete load().panes[id];
      for (const pane of Object.values(load().panes)) {
        if (pane.scheduled?.targetTermId === id) pane.scheduled = null;
      }
      persist();
    },
    freeze() { frozen = true; },
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
