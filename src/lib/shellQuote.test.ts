import { describe, expect, test } from "bun:test";

import {
  buildCdCommand,
  quoteShellPath,
  shellFamily,
} from "./shellQuote";

describe("shellFamily", () => {
  test("recognises PowerShell labels and ids", () => {
    expect(shellFamily("PowerShell 7")).toBe("powershell");
    expect(shellFamily("Windows PowerShell")).toBe("powershell");
    expect(shellFamily("pwsh")).toBe("powershell");
  });

  test("recognises cmd", () => {
    expect(shellFamily("Command Prompt")).toBe("cmd");
    expect(shellFamily("cmd")).toBe("cmd");
    expect(shellFamily("cmd.exe")).toBe("cmd");
  });

  test("treats bash / zsh / Git Bash / unknown as posix", () => {
    expect(shellFamily("Git Bash")).toBe("posix");
    expect(shellFamily("Bash")).toBe("posix");
    expect(shellFamily("zsh (default)")).toBe("posix");
    expect(shellFamily("")).toBe("posix");
  });
});

describe("quoteShellPath", () => {
  test("PowerShell doubles single quotes and leaves $(...) literal", () => {
    expect(quoteShellPath("C:\\proj\\$(rm -rf ~)", "powershell")).toBe(
      "'C:\\proj\\$(rm -rf ~)'",
    );
    expect(quoteShellPath("O'Brien", "powershell")).toBe("'O''Brien'");
  });

  test("cmd doubles double quotes", () => {
    expect(quoteShellPath('C:\\say "hi"', "cmd")).toBe('"C:\\say ""hi"""');
  });

  test("posix uses '\\'' for embedded single quotes", () => {
    expect(quoteShellPath("/tmp/it's", "posix")).toBe(`'/tmp/it'\\''s'`);
    expect(quoteShellPath("/tmp/$(whoami)", "posix")).toBe("'/tmp/$(whoami)'");
  });
});

describe("buildCdCommand", () => {
  test("does not wrap paths in expandable double quotes", () => {
    const evil = "/tmp/$(echo pwned)";
    expect(buildCdCommand(evil, "Bash")).toBe(`cd -- '${evil}'`);
    expect(buildCdCommand(evil, "PowerShell 7")).toBe(
      `Set-Location -LiteralPath '${evil}'`,
    );
    expect(buildCdCommand(evil, "Command Prompt")).toBe(`cd /d "${evil}"`);
  });

  test("cmd uses /d so drive letters can change", () => {
    expect(buildCdCommand("D:\\work", "cmd")).toBe('cd /d "D:\\work"');
  });
});
