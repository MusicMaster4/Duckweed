import type { AgentId } from "./types";

export type AgentAuthAction = "login" | "logout";

/** Run authentication in the real CLI, where browser and device flows live. */
export function nativeAuthCommand(agent: AgentId, action: AgentAuthAction): string {
  switch (agent) {
    case "claude":
      return `claude auth ${action}`;
    case "codex":
      return `codex ${action}`;
    case "cursor":
      return `cursor-agent ${action}`;
    case "grok":
      return `grok ${action}`;
    case "opencode":
      return `opencode providers ${action}`;
  }
}

/** Provider errors that cannot succeed on retry until the user signs in. */
export function isAuthenticationFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return (
    /\b(?:401|unauthenticated|unauthorized)\b/i.test(message) ||
    /\bnot (?:authenticated|logged in|signed in)\b/i.test(message) ||
    /\b(?:authentication|authorization|login|sign[ -]?in) (?:is )?required\b/i.test(message) ||
    /\bmissing (?:authentication|authorization|bearer|credentials?)\b/i.test(message) ||
    /\b(?:invalid|expired) (?:api key|access token|auth token|credentials?)\b/i.test(message) ||
    /(?:run|use|please).*\/(?:login|auth)\b/i.test(message)
  );
}
