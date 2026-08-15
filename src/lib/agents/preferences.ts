import { saveDurably } from "../durableStorage";
import type { AgentLaunch } from "./launch";
import type { AgentAccessMode } from "./types";

export const AGENT_PREFERENCES_KEY = "duckweed:agent-preferences:v1";

interface AgentPreference {
  model: string | null;
  effort: string | null;
  accessMode: AgentAccessMode;
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

/** Internal Codex utility models must never become a user-facing preference. */
function isInternalCodexModel(launch: AgentLaunch, model: string | null): boolean {
  return Boolean(
    launch.agent === "codex" &&
      model &&
      /^codex-auto-review(?:er)?$/i.test(model),
  );
}

function cleanModel(launch: AgentLaunch, value: unknown): string | null {
  const model = cleanValue(value);
  return isInternalCodexModel(launch, model) ? null : model;
}

function cleanAccessMode(value: unknown): AgentAccessMode {
  return value === "read-only" || value === "workspace" || value === "full-access"
    ? value
    : "default";
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
      const accessMode = cleanAccessMode(record.accessMode);
      if (model || effort || accessMode !== "default") {
        choices[scope] = { model, effort, accessMode };
      }
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
  if (!preference) {
    const model = cleanModel(launch, launch.model);
    return model === launch.model ? launch : { ...launch, model };
  }
  return {
    ...launch,
    model: cleanModel(launch, launch.model ?? preference.model),
    effort: launch.effort ?? preference.effort,
    accessMode: launch.accessMode ?? preference.accessMode,
  };
}

/** Save the latest choices confirmed by a CLI or selected in the custom UI. */
export function rememberPreferences(
  launch: AgentLaunch,
  selection: Partial<AgentPreference>,
): void {
  if (
    selection.model === undefined &&
    selection.effort === undefined &&
    selection.accessMode === undefined
  ) {
    return;
  }
  const store = load();
  const scope = preferenceScope(launch);
  const previous = store.choices[scope] ?? {
    model: null,
    effort: null,
    accessMode: "default" as const,
  };
  const selectedModel = cleanValue(selection.model);
  const next = {
    model:
      selection.model === undefined
        ? cleanModel(launch, previous.model)
        : isInternalCodexModel(launch, selectedModel)
          ? cleanModel(launch, previous.model)
          : selectedModel,
    effort: selection.effort === undefined ? previous.effort : cleanValue(selection.effort),
    accessMode:
      selection.accessMode === undefined
        ? previous.accessMode
        : cleanAccessMode(selection.accessMode),
  };
  if (
    next.model === previous.model &&
    next.effort === previous.effort &&
    next.accessMode === previous.accessMode
  ) {
    return;
  }

  const choices = { ...store.choices };
  if (next.model || next.effort || next.accessMode !== "default") choices[scope] = next;
  else delete choices[scope];
  persist({ version: 1, choices });
}

/** Test seam that also avoids coupling unit tests to Bun's localStorage. */
export function resetForTests(choices: Record<string, AgentPreference> = {}): void {
  cached = { version: 1, choices };
}
