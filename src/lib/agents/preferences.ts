import { saveDurably } from "../durableStorage";
import type { AgentLaunch } from "./launch";

export const AGENT_PREFERENCES_KEY = "duckweed:agent-preferences:v1";

interface AgentPreference {
  model: string | null;
  effort: string | null;
}

interface PreferenceStore {
  version: 1;
  choices: Record<string, AgentPreference>;
}

let cached: PreferenceStore | null = null;

function emptyStore(): PreferenceStore {
  return { version: 1, choices: {} };
}

function cleanValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function load(): PreferenceStore {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(AGENT_PREFERENCES_KEY);
    if (!raw) return (cached = emptyStore());
    const parsed = JSON.parse(raw) as Partial<PreferenceStore>;
    if (parsed.version !== 1 || !parsed.choices || typeof parsed.choices !== "object") {
      return (cached = emptyStore());
    }
    const choices: Record<string, AgentPreference> = {};
    for (const [scope, value] of Object.entries(parsed.choices)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<AgentPreference>;
      const model = cleanValue(record.model);
      const effort = cleanValue(record.effort);
      if (model || effort) choices[scope] = { model, effort };
    }
    return (cached = { version: 1, choices });
  } catch {
    return (cached = emptyStore());
  }
}

function persist(store: PreferenceStore): void {
  cached = store;
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(AGENT_PREFERENCES_KEY, raw);
    saveDurably(AGENT_PREFERENCES_KEY, raw);
  } catch {
    // A preference should never prevent an agent from starting.
  }
}

/**
 * Keep direct CLI wrappers independent. `claude`, `claudex`, and `omc` share
 * a protocol but may point at completely different model catalogs.
 */
export function preferenceScope(launch: AgentLaunch): string {
  const base = launch.program.split(/[\\/]/).pop() ?? launch.program;
  const program = base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return `${launch.agent}:${program || launch.agent}`;
}

/** Fill missing launch choices without overriding flags the user just typed. */
export function withRememberedPreferences(launch: AgentLaunch): AgentLaunch {
  const preference = load().choices[preferenceScope(launch)];
  if (!preference) return launch;
  return {
    ...launch,
    model: launch.model ?? preference.model,
    effort: launch.effort ?? preference.effort,
  };
}

/** Save the latest choices confirmed by a CLI or selected in the custom UI. */
export function rememberPreferences(
  launch: AgentLaunch,
  selection: Partial<AgentPreference>,
): void {
  if (selection.model === undefined && selection.effort === undefined) return;
  const store = load();
  const scope = preferenceScope(launch);
  const previous = store.choices[scope] ?? { model: null, effort: null };
  const next = {
    model: selection.model === undefined ? previous.model : cleanValue(selection.model),
    effort: selection.effort === undefined ? previous.effort : cleanValue(selection.effort),
  };
  if (next.model === previous.model && next.effort === previous.effort) return;

  const choices = { ...store.choices };
  if (next.model || next.effort) choices[scope] = next;
  else delete choices[scope];
  persist({ version: 1, choices });
}

/** Test seam that also avoids coupling unit tests to Bun's localStorage. */
export function resetForTests(choices: Record<string, AgentPreference> = {}): void {
  cached = { version: 1, choices };
}
