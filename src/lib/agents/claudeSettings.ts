import { homeDir, readFile } from "../ipc";

/**
 * Defaults Claude Code persists in `~/.claude/settings.json`.
 *
 * The stream-json `system/init` frame only arrives with the first turn, so
 * the custom UI would otherwise show "Model" / "Effort" until the user sent
 * something. Reading the settings file gives the same values the real TUI
 * shows on open (`model`, `effortLevel`).
 */
export interface ClaudeSettingsDefaults {
  model: string | null;
  effort: string | null;
}

export async function loadClaudeSettingsDefaults(): Promise<ClaudeSettingsDefaults> {
  try {
    const home = await homeDir();
    const sep = home.includes("\\") ? "\\" : "/";
    const path = `${home}${sep}.claude${sep}settings.json`;
    const file = await readFile(path);
    const raw = JSON.parse(file.content) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { model: null, effort: null };
    }
    const record = raw as Record<string, unknown>;
    const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : null;
    const effort =
      typeof record.effortLevel === "string" && record.effortLevel.trim()
        ? record.effortLevel.trim().toLowerCase()
        : typeof record.effort === "string" && record.effort.trim()
          ? record.effort.trim().toLowerCase()
          : null;
    return { model, effort };
  } catch {
    // Missing file, unreadable, or non-desktop: just leave defaults empty.
    return { model: null, effort: null };
  }
}
