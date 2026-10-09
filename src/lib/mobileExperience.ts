import type { AgentItem, AgentSessionState } from "./agents/types";
import { truncateUtf8, utf8ByteLength } from "./mobileWorkspace";

export type MobileAgentExperience = Pick<AgentSessionState,
  "termId" | "agent" | "program" | "label" | "mark" | "accent" | "status" | "workStartedAt" |
  "lastWorkedForMs" | "cwd" | "model" | "effort" | "nextModel" | "nextEffort" |
  "sessionId" | "goal" | "usage" | "started" | "loadingHistory" | "error" | "serviceTier"
> & { items: AgentItem[]; focused: boolean; conversationEpoch: string };

function compactItem(item: AgentItem, depth = 0, textBudget = 24_000): AgentItem {
  if (item.kind === "user") return { ...item, text: truncateUtf8(item.text, Math.min(16_000, textBudget)), images: [] };
  if (item.kind === "assistant" || item.kind === "thinking") return { ...item, text: truncateUtf8(item.text, textBudget) };
  if (item.kind !== "tool") return { ...item };
  return {
    ...item,
    title: truncateUtf8(item.title, 512),
    output: truncateUtf8(item.output, Math.min(4_000, textBudget)),
    command: item.command ? truncateUtf8(item.command, Math.min(4_000, textBudget)) : null,
    changes: item.changes.slice(-4).map(change => ({
      ...change,
      before: change.before === null ? null : truncateUtf8(change.before, Math.min(2_000, textBudget)),
      after: change.after === null ? null : truncateUtf8(change.after, Math.min(2_000, textBudget)),
      diff: change.diff === null ? null : truncateUtf8(change.diff, Math.min(4_000, textBudget)),
    })),
    subagent: item.subagent ? { ...item.subagent,
      items: depth === 0 ? item.subagent.items?.slice(-8).map(child => compactItem(child, 1, Math.min(textBudget, 1_000))) : [],
    } : undefined,
  };
}

/** Budget entire encoded items, preserving IDs and provider-specific structure. */
export function mobileAgentExperience(session: AgentSessionState, focused = false): MobileAgentExperience {
  const { termId, agent, program, label, mark, accent, status, workStartedAt, lastWorkedForMs, cwd,
    model, effort, nextModel, nextEffort, sessionId, goal, usage, started, loadingHistory, error, serviceTier } = session;
  const result: MobileAgentExperience = { termId, agent, program, label, mark, accent, status, workStartedAt,
    lastWorkedForMs, cwd, model, effort, nextModel, nextEffort, sessionId, goal, usage, started,
    loadingHistory, error, serviceTier, items: [], focused, conversationEpoch: session.items[0]?.id ?? "empty" };
  let remaining = (focused ? 125_000 : 10_000) - utf8ByteLength(JSON.stringify(result));
  for (const item of session.items.slice(focused ? -300 : -24).reverse()) {
    let textBudget = focused ? 24_000 : 6_000;
    let compact = compactItem(item, 0, textBudget);
    let bytes = utf8ByteLength(JSON.stringify(compact)) + 1;
    // A large tool/subagent must not hide the newest live state of a background tab.
    if (result.items.length === 0) {
      while (bytes > remaining && textBudget > 128) {
        textBudget = Math.floor(textBudget / 2);
        compact = compactItem(item, 0, textBudget);
        bytes = utf8ByteLength(JSON.stringify(compact)) + 1;
      }
    }
    if (bytes > remaining) break;
    result.items.unshift(compact);
    remaining -= bytes;
  }
  const plan = [...session.items].reverse().find(item => item.kind === "plan");
  if (plan && !result.items.some(item => item.id === plan.id)) {
    const compact = compactItem(plan);
    if (utf8ByteLength(JSON.stringify(compact)) < remaining) result.items.unshift(compact);
  }
  return result;
}
