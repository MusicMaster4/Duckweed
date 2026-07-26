/**
 * Lightweight shell syntax highlighting for the command composer.
 *
 * This deliberately does not try to execute or fully parse the command. It
 * recognises the syntax shared by PowerShell and POSIX shells, then adds a
 * small amount of command-aware context for common subcommand-based CLIs.
 * Every input character is returned exactly once, so the painted mirror stays
 * pixel-aligned with the textarea and remains safe for incomplete commands.
 */

export type CommandTokenKind =
  | "plain"
  | "command"
  | "subcommand"
  | "flag"
  | "string"
  | "variable"
  | "operator"
  | "path"
  | "number"
  | "url"
  | "comment";

export interface CommandToken {
  text: string;
  kind: CommandTokenKind;
}

const SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set(["add", "build", "create", "dev", "install", "link", "pm", "remove", "run", "test", "update", "x"]),
  cargo: new Set(["add", "bench", "build", "check", "clean", "clippy", "doc", "fix", "fmt", "install", "new", "publish", "remove", "run", "search", "test", "tree", "update"]),
  deno: new Set(["add", "bench", "check", "compile", "doc", "eval", "fmt", "info", "install", "lint", "repl", "run", "task", "test", "uninstall"]),
  docker: new Set(["build", "compose", "container", "exec", "image", "inspect", "login", "logs", "network", "ps", "pull", "push", "rm", "run", "start", "stop", "system", "volume"]),
  dotnet: new Set(["add", "build", "clean", "format", "help", "list", "new", "nuget", "pack", "publish", "remove", "restore", "run", "test", "tool", "workload"]),
  gh: new Set(["alias", "api", "auth", "browse", "codespace", "gist", "issue", "pr", "release", "repo", "run", "search", "secret", "ssh-key", "status", "variable", "workflow"]),
  git: new Set(["add", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "diff", "fetch", "grep", "init", "log", "merge", "mv", "pull", "push", "rebase", "remote", "reset", "restore", "revert", "rm", "show", "stash", "status", "switch", "tag", "worktree"]),
  go: new Set(["build", "clean", "doc", "env", "fmt", "generate", "get", "install", "list", "mod", "run", "test", "tool", "version", "vet", "work"]),
  kubectl: new Set(["annotate", "apply", "attach", "auth", "autoscale", "config", "cordon", "create", "delete", "describe", "diff", "drain", "edit", "exec", "explain", "expose", "get", "label", "logs", "patch", "plugin", "port-forward", "proxy", "replace", "rollout", "run", "scale", "set", "taint", "top", "uncordon", "version", "wait"]),
  npm: new Set(["access", "adduser", "audit", "cache", "ci", "config", "dedupe", "deprecate", "diff", "dist-tag", "docs", "exec", "explain", "help", "init", "install", "link", "login", "logout", "outdated", "owner", "pack", "ping", "prefix", "profile", "prune", "publish", "query", "rebuild", "repo", "restart", "root", "run", "search", "start", "stop", "team", "test", "token", "uninstall", "unpublish", "update", "version", "view", "whoami"]),
  pnpm: new Set(["add", "approve-builds", "audit", "build", "config", "create", "deploy", "dlx", "exec", "fetch", "import", "init", "install", "link", "list", "outdated", "pack", "patch", "prune", "publish", "rebuild", "remove", "run", "self-update", "setup", "store", "test", "unlink", "update", "why"]),
  rustup: new Set(["check", "component", "default", "doc", "override", "profile", "run", "self", "set", "show", "target", "toolchain", "update", "which"]),
  yarn: new Set(["add", "bin", "cache", "config", "create", "dedupe", "dlx", "exec", "info", "init", "install", "link", "npm", "pack", "patch", "plugin", "rebuild", "remove", "run", "set", "stage", "unlink", "up", "why", "workspace", "workspaces"]),
};

const COMMAND_WRAPPERS = new Set(["command", "env", "nohup", "sudo", "time"]);
const COMMAND_SEPARATORS = new Set(["|", "|&", "||", "&&", ";", "&", "\n"]);
/**
 * Tokenize a complete or partially typed shell command for display.
 */
export function highlightCommand(input: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  let expectsCommand = true;
  let rootCommand: string | null = null;

  const push = (text: string, kind: CommandTokenKind) => {
    if (!text) return;
    tokens.push({ text, kind });
  };

  while (index < input.length) {
    const char = input[index]!;

    if (isWhitespace(char)) {
      const start = index++;
      while (index < input.length && isWhitespace(input[index]!)) index++;
      const text = input.slice(start, index);
      push(text, "plain");
      if (text.includes("\n")) {
        expectsCommand = true;
        rootCommand = null;
      }
      continue;
    }

    if (expectsCommand) {
      const assignment = input.slice(index).match(/^[a-z_][a-z0-9_]*=[^\s|;&]*/i)?.[0];
      if (assignment) {
        push(assignment, "variable");
        index += assignment.length;
        continue;
      }
    }

    if (char === "#" && isCommentStart(input, index)) {
      const end = nextLine(input, index);
      push(input.slice(index, end), "comment");
      index = end;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const end = quotedEnd(input, index, char);
      push(input.slice(index, end), "string");
      index = end;
      continue;
    }

    if (char === "$" || (char === "%" && percentVariableEnd(input, index) > index)) {
      const end = char === "$" ? dollarVariableEnd(input, index) : percentVariableEnd(input, index);
      if (end > index + 1) {
        push(input.slice(index, end), "variable");
        index = end;
        continue;
      }
    }

    const operator = readOperator(input, index);
    if (operator) {
      push(operator, "operator");
      index += operator.length;
      if (COMMAND_SEPARATORS.has(operator)) {
        expectsCommand = true;
        rootCommand = null;
      }
      continue;
    }

    const start = index++;
    while (index < input.length && !isBoundary(input, index)) index++;
    const word = input.slice(start, index);
    const lower = word.toLowerCase();

    if (expectsCommand) {
      if (isFlag(word)) {
        pushFlagWithValue(tokens, word);
        continue;
      }
      push(word, "command");
      const commandName = normaliseCommand(word);
      if (COMMAND_WRAPPERS.has(commandName)) {
        rootCommand = null;
        expectsCommand = true;
      } else {
        rootCommand = commandName;
        expectsCommand = false;
      }
      continue;
    }

    if (isFlag(word)) {
      pushFlagWithValue(tokens, word);
    } else if (rootCommand && SUBCOMMANDS[rootCommand]?.has(lower)) {
      push(word, "subcommand");
      // The first recognised positional is the subcommand; later positionals
      // are its arguments, even when their text is also a valid top-level verb.
      rootCommand = null;
    } else {
      push(word, classifyArgument(word));
    }
  }

  return tokens;
}

function pushFlagWithValue(tokens: CommandToken[], word: string): void {
  const equals = word.indexOf("=");
  if (equals <= 0) {
    tokens.push({ text: word, kind: "flag" });
    return;
  }
  tokens.push({ text: word.slice(0, equals), kind: "flag" });
  tokens.push({ text: "=", kind: "operator" });
  const value = word.slice(equals + 1);
  if (value) tokens.push({ text: value, kind: classifyArgument(value) });
}

function classifyArgument(word: string): CommandTokenKind {
  if (/^(?:https?|ftp):\/\/\S+$/i.test(word)) return "url";
  if (isPath(word)) return "path";
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-z]+)?$/i.test(word)) return "number";
  return "plain";
}

function isPath(word: string): boolean {
  return (
    /^(?:\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/]|\\\\)/i.test(word) ||
    (/[\\/]/.test(word) && !/^\/[a-z?]+(?::.*)?$/i.test(word)) ||
    /^[\w@()-]+\.(?:[a-z0-9]{1,8})$/i.test(word)
  );
}

function isFlag(word: string): boolean {
  if (/^--?[\w?][\w.:-]*(?:=.*)?$/.test(word)) return true;
  return /^\/[a-z?]+(?::[^\s]+)?$/i.test(word);
}

function normaliseCommand(word: string): string {
  const unquoted = word.replace(/^["']|["']$/g, "");
  const last = unquoted.split(/[\\/]/).pop() ?? unquoted;
  return last.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isBoundary(input: string, index: number): boolean {
  const char = input[index]!;
  return (
    isWhitespace(char) ||
    char === "'" ||
    char === '"' ||
    char === "`" ||
    char === "$" ||
    readOperator(input, index) !== null ||
    (char === "#" && isCommentStart(input, index))
  );
}

function isCommentStart(input: string, index: number): boolean {
  if (index === 0) return true;
  const previous = input[index - 1]!;
  return isWhitespace(previous) || COMMAND_SEPARATORS.has(previous);
}

function nextLine(input: string, index: number): number {
  const newline = input.indexOf("\n", index);
  return newline === -1 ? input.length : newline;
}

function quotedEnd(input: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === quote) return index + 1;
    if (input[index] === "\\" && quote === '"' && index + 1 < input.length) {
      index += 2;
    } else if (input[index] === "`" && quote !== "'" && index + 1 < input.length) {
      index += 2;
    } else {
      index++;
    }
  }
  return input.length;
}

function dollarVariableEnd(input: string, start: number): number {
  if (input[start + 1] === "{") {
    const close = input.indexOf("}", start + 2);
    return close === -1 ? input.length : close + 1;
  }
  const match = input.slice(start).match(/^\$(?:env:)?[a-z_?][\w:?]*/i);
  return match ? start + match[0].length : start + 1;
}

function percentVariableEnd(input: string, start: number): number {
  const match = input.slice(start).match(/^%[a-z_][a-z0-9_]*%/i);
  return match ? start + match[0].length : start;
}

function readOperator(input: string, index: number): string | null {
  const rest = input.slice(index);
  const match = rest.match(
    /^(?:2>>|1>>|&&|\|\||\|&|>>|<<|2>|1>|&>|==|!=|=~|\+=|-=|\*=|\/=|[|;&<>(){}>=])/,
  );
  if (match) return match[0];
  if (rest[0] === "\n") return "\n";
  return null;
}
