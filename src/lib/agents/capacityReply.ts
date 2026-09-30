export interface CodexCapacityReplySettings {
  enabled: boolean;
  message: string;
}

export const CODEX_CAPACITY_REPLY_DELAY_MS = 2000;

export function codexCapacityReplySettings(value?: unknown): CodexCapacityReplySettings {
  const settings = value && typeof value === "object"
    ? value as Partial<CodexCapacityReplySettings>
    : {};
  return {
    enabled: settings.enabled === true,
    message: typeof settings.message === "string" ? settings.message : "continue",
  };
}

export function isCodexCapacityError(text: string): boolean {
  return /\bselected model is at capacity\b/i.test(text);
}
