/**
 * Quote paths for shell commands submitted into a PTY.
 *
 * Double quotes still expand variables / command substitutions in PowerShell
 * and POSIX shells, so directory names like `$(rm -rf ~)` or `` `whoami` ``
 * would execute if we only wrapped the path in `"..."`. Prefer literal
 * quoting for each family instead.
 */

export type ShellFamily = "powershell" | "cmd" | "posix";

/** Map a UI shell label (or id) to the quoting rules it needs. */
export function shellFamily(label: string): ShellFamily {
  const s = label.toLowerCase();
  if (
    s.includes("powershell") ||
    s === "pwsh" ||
    s.startsWith("pwsh ") ||
    s.includes("pwsh.exe")
  ) {
    return "powershell";
  }
  if (
    s.includes("command prompt") ||
    s === "cmd" ||
    s.includes("cmd.exe") ||
    s === "comspec"
  ) {
    return "cmd";
  }
  // bash, zsh, fish, Git Bash, WSL, nu, sh, and unknown → POSIX-style single quotes.
  return "posix";
}

/** Quote `path` so the shell treats it as a single literal argument. */
export function quoteShellPath(path: string, family: ShellFamily): string {
  switch (family) {
    case "powershell":
      // Single-quoted: only `'` is special (doubled).
      return `'${path.replace(/'/g, "''")}'`;
    case "cmd":
      // Double-quoted: `"` is escaped by doubling.
      return `"${path.replace(/"/g, '""')}"`;
    case "posix":
      // Single-quoted: close, escaped quote, reopen — classic `'\''` form.
      return `'${path.replace(/'/g, `'\\''`)}'`;
  }
}

/**
 * Build a `cd` (or equivalent) that moves the shell into `path` without
 * expanding metacharacters inside the path.
 */
export function buildCdCommand(path: string, shellLabel: string): string {
  const family = shellFamily(shellLabel);
  const quoted = quoteShellPath(path, family);
  switch (family) {
    case "powershell":
      // -LiteralPath ignores wildcards in folder names like `[build]`.
      return `Set-Location -LiteralPath ${quoted}`;
    case "cmd":
      // /d allows changing drive as well as directory.
      return `cd /d ${quoted}`;
    case "posix":
      return `cd -- ${quoted}`;
  }
}
