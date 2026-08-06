import type { AgentFileChange, AgentItem, ToolItem } from "./types";

/** Wrap arbitrary content without letting backticks inside it close the block. */
function fenced(content: string, language = "text"): string {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

/** Rebuild the textual before/after form as a portable unified-style patch. */
function textPatch(change: AgentFileChange): string {
  const { before, after, path } = change;
  const oldPath = before === null ? "/dev/null" : `a/${path}`;
  const newPath = after === null ? "/dev/null" : `b/${path}`;
  const lines = [`--- ${oldPath}`, `+++ ${newPath}`];

  if (before === null) {
    for (const line of (after ?? "").split("\n")) lines.push(`+${line}`);
    return lines.join("\n");
  }
  if (after === null) {
    for (const line of before.split("\n")) lines.push(`-${line}`);
    return lines.join("\n");
  }

  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  lines.push("@@");
  for (const line of oldLines.slice(0, head)) lines.push(` ${line}`);
  for (const line of oldLines.slice(head, oldLines.length - tail)) lines.push(`-${line}`);
  for (const line of newLines.slice(head, newLines.length - tail)) lines.push(`+${line}`);
  for (const line of oldLines.slice(oldLines.length - tail)) lines.push(` ${line}`);
  return lines.join("\n");
}

function changeText(change: AgentFileChange): string {
  const stats = `+${change.insertions} -${change.deletions}`;
  const heading = `File change: ${change.path} (${stats})`;
  if (!change.diff?.trim() && change.before === null && change.after === null) {
    return `${heading}\nDiff contents were not provided by the agent.`;
  }
  const patch = change.diff?.trim() || textPatch(change);
  return `${heading}\n${fenced(patch, "diff")}`;
}

function toolText(item: ToolItem, agentLabel: string): string {
  const sections = [`Tool call [${item.status}]: ${item.title || item.name}`, `Tool: ${item.name}`];

  if (item.command?.trim()) sections.push(`Command:\n${fenced(item.command, "shell")}`);
  if (item.output.trim()) sections.push(`Output:\n${fenced(item.output)}`);
  if (item.changes.length) sections.push(item.changes.map(changeText).join("\n\n"));

  const subagent = item.subagent;
  if (subagent) {
    const details = [
      subagent.label ? `Label: ${subagent.label}` : null,
      subagent.role ? `Role: ${subagent.role}` : null,
      subagent.model ? `Model: ${subagent.model}` : null,
      subagent.threadId ? `Thread: ${subagent.threadId}` : null,
      subagent.parentCallId ? `Parent call: ${subagent.parentCallId}` : null,
      subagent.activity ? `Activity: ${subagent.activity}` : null,
      subagent.prompt?.trim() ? `Prompt:\n${subagent.prompt.trim()}` : null,
    ].filter((detail): detail is string => detail !== null);
    if (subagent.items?.length) {
      const transcript = conversationText(subagent.items, subagent.label || agentLabel);
      if (transcript) details.push(`Transcript:\n${transcript}`);
    }
    sections.push(`Subagent${details.length ? `:\n${details.join("\n")}` : ""}`);
  }

  return sections.join("\n\n");
}

/**
 * Produce a portable, complete transcript in display order.
 *
 * The clipboard export intentionally includes every visible timeline item:
 * messages, exposed thinking, plans, notices, tool calls, their output, nested
 * subagents, and the full added/removed lines of every recorded file edit.
 */
export function conversationText(items: AgentItem[], agentLabel: string): string {
  const entries: string[] = [];

  for (const item of items) {
    switch (item.kind) {
      case "user": {
        const content = [
          item.text.trim(),
          ...(item.images ?? []).map(
            (image) => `[Image: ${image.name} (${image.mimeType}, ${image.size} bytes)]`,
          ),
        ]
          .filter(Boolean)
          .join("\n");
        if (content) entries.push(`${item.sameTurn ? "You (steering)" : "You"}:\n${content}`);
        break;
      }

      case "assistant": {
        const content = item.text.trim();
        if (content) entries.push(`${agentLabel}:\n${content}`);
        break;
      }

      case "thinking": {
        const content = item.text.trim();
        if (content) entries.push(`${agentLabel} thinking:\n${content}`);
        break;
      }

      case "tool":
        entries.push(toolText(item, agentLabel));
        break;

      case "plan": {
        const plan = item.steps
          .map((step) => {
            const mark = step.status === "done" ? "x" : step.status === "running" ? ">" : " ";
            return `- [${mark}] ${step.text}`;
          })
          .join("\n");
        entries.push(`Plan${item.planType === "workflow" ? " (workflow)" : ""}:\n${plan}`);
        break;
      }

      case "notice":
        entries.push(`Notice [${item.tone}]:\n${item.text}`);
        break;
    }
  }

  return entries.join("\n\n");
}
