/**
 * Lightweight syntax highlighting for the custom agent composer.
 *
 * This is intentionally a display tokenizer, not a prompt parser. Every input
 * character is emitted exactly once so the painted text remains aligned with
 * the native textarea, including while a command or quoted mention is typed.
 */
export type AgentComposerTokenKind = "plain" | "command" | "file";

export interface AgentComposerToken {
  text: string;
  kind: AgentComposerTokenKind;
}

/** Highlight a leading slash command and workspace-style `@file` mentions. */
export function highlightAgentComposer(input: string): AgentComposerToken[] {
  const tokens: AgentComposerToken[] = [];
  let index = 0;

  const push = (text: string, kind: AgentComposerTokenKind) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === kind) previous.text += text;
    else tokens.push({ text, kind });
  };

  // Slash commands are actionable only at the start of a composer submission.
  if (input.startsWith("/")) {
    const end = firstWhitespace(input, 1);
    push(input.slice(0, end), "command");
    index = end;
  }

  let plainStart = index;
  while (index < input.length) {
    if (input[index] !== "@" || (index > 0 && !isWhitespace(input[index - 1]!))) {
      index++;
      continue;
    }

    push(input.slice(plainStart, index), "plain");
    const end = mentionEnd(input, index);
    push(input.slice(index, end), "file");
    index = end;
    plainStart = end;
  }

  push(input.slice(plainStart), "plain");
  return tokens;
}

function firstWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && !isWhitespace(input[index]!)) index++;
  return index;
}

function mentionEnd(input: string, start: number): number {
  if (input[start + 1] !== '"') return firstWhitespace(input, start + 1);

  let index = start + 2;
  while (index < input.length) {
    if (input[index] === "\\" && index + 1 < input.length) {
      index += 2;
      continue;
    }
    if (input[index] === '"') return index + 1;
    index++;
  }
  return input.length;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}
