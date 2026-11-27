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

async function readClaudeGlobalConfig(): Promise<Record<string, unknown> | null> {
  try {
    const home = await homeDir();
    const sep = home.includes("\\") ? "\\" : "/";
    const file = await readFile(`${home}${sep}.claude.json`);
    const raw = JSON.parse(file.content) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The "Enabled by default" switch of Claude's `/chrome` dialog
 * (`claudeInChromeDefaultEnabled` in `~/.claude.json`).
 *
 * The interactive TUI honors it at startup, but `--print` (the headless mode
 * the custom UI drives) ignores it, so Claude in Chrome stays disconnected
 * unless the launch carries `--chrome` or CLAUDE_CODE_ENABLE_CFC=1.
 */
export async function loadClaudeChromeDefault(): Promise<boolean> {
  return (await readClaudeGlobalConfig())?.claudeInChromeDefaultEnabled === true;
}

/**
 * Launch flags that give a headless Claude session the same Chrome behavior
 * as the TUI. An explicit `--chrome` / `--no-chrome` typed by the user wins.
 */
export function claudeChromeArgs(typedArgs: readonly string[], chromeByDefault: boolean): string[] {
  if (!chromeByDefault) return [];
  const explicit = typedArgs.some((arg) => {
    const flag = arg.toLowerCase();
    return flag === "--chrome" || flag === "--no-chrome";
  });
  return explicit ? [] : ["--chrome"];
}

/**
 * Claude Code prints this on stderr when ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN or an apiKeyHelper outranks an existing claude.ai
 * login. That silently turns off every subscriber feature, so the session
 * shows why instead of just missing tools.
 */
export function shadowsClaudeAiLogin(stderrLine: string): boolean {
  return /takes precedence over your claude\.ai login/i.test(stderrLine);
}

export const CLAUDE_AI_LOGIN_SHADOWED_NOTICE =
  "Claude Code is authenticating with ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an apiKeyHelper instead of your claude.ai login, " +
  "so Claude in Chrome, claude.ai connectors and other subscription features are off in this session. " +
  "To keep them while routing through a proxy, remove ANTHROPIC_AUTH_TOKEN and send the proxy key as a header with " +
  "ANTHROPIC_CUSTOM_HEADERS=\"x-api-key: <key>\" next to ANTHROPIC_BASE_URL.";
