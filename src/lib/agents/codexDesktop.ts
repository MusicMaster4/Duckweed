/**
 * The ChatGPT desktop app hosts browser and Computer Use access for its local
 * Codex runtime. Duckweed's provider threads reach that host through per-thread
 * MCP settings read from the running desktop app (see `codex_desktop.rs`).
 * These helpers only classify the failures that remain when it is unavailable.
 */

const DESKTOP_REQUIRED = "Keep the ChatGPT desktop app open and signed in to the same account. Duckweed reconnects this conversation when the app is available.";

export interface DesktopConnectionFailure {
  message: string;
  /** Reloading the thread's MCP servers can fix it once the host is reachable. */
  reconnect: boolean;
}

/** Only known bridge errors count; ordinary page and tool failures are unrelated. */
export function desktopConnectionFailure(item: Record<string, unknown>): DesktopConnectionFailure | null {
  const server = typeof item.server === "string" ? item.server : "";
  if (!/(?:^|__)(?:cua_repl|node_repl)$/.test(server)) return null;
  const result = item.result as { content?: { text?: string }[] } | undefined;
  const error = item.error as { message?: string } | undefined;
  const text = [error?.message, ...(Array.isArray(result?.content) ? result.content.map(part => part?.text) : [])]
    .filter((value): value is string => typeof value === "string").join("\n");
  if (/Computer Use has been stopped[\s\S]*could not determine the current browser URL/i.test(text)) {
    return {
      message: "Computer Use stopped because it could not verify the current browser URL. Ask Codex to use the Chrome plugin for web pages instead of controlling the Chrome window.",
      reconnect: false,
    };
  }
  if (/Local browser use is disabled in Work settings/i.test(text)) {
    return {
      message: "The ChatGPT desktop app denied browser access for this account. Sign in to the same ChatGPT account in Duckweed and in the desktop app, and check its Work settings.",
      reconnect: false,
    };
  }
  if (/browser access host is unavailable|cannot authenticate the browser access response/i.test(text)) {
    return { message: `Browser control is not connected. ${DESKTOP_REQUIRED}`, reconnect: true };
  }
  if (/computer use native pipe (?:is unavailable|path is unavailable|connection timed out|closed)/i.test(text)) {
    return { message: `Computer Use is not connected. ${DESKTOP_REQUIRED}`, reconnect: true };
  }
  return null;
}
