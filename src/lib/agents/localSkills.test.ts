import { describe, expect, test } from "bun:test";

import type { DirEntry, FileContent } from "../types";
import { discoverLocalSkills, parseSkillMetadata, promptTextWithLocalSkills } from "./localSkills";

function entry(path: string, name: string, isDir: boolean): DirEntry {
  return { path, name, is_dir: isDir, ignored: false };
}

describe("local agent skills", () => {
  test("reads skill names and descriptions from frontmatter", () => {
    expect(
      parseSkillMetadata(
        '---\nname: "html-plan"\ndescription: Create pragmatic plans\n---\n\nInstructions',
        "fallback",
      ),
    ).toEqual({ name: "html-plan", description: "Create pragmatic plans" });
  });

  test("discovers shared and provider-local skills without plugin inventories", async () => {
    const directories = new Map<string, DirEntry[]>([
      ["C:/Users/me/.agents/skills", [entry("C:/Users/me/.agents/skills/unslop", "unslop", true)]],
      ["C:/Users/me/.agents/skills/unslop", [entry("C:/Users/me/.agents/skills/unslop/SKILL.md", "SKILL.md", false)]],
      ["C:/Users/me/.codex/skills", [entry("C:/Users/me/.codex/skills/workos", "workos", true)]],
      ["C:/Users/me/.codex/skills/workos", [entry("C:/Users/me/.codex/skills/workos/SKILL.md", "SKILL.md", false)]],
    ]);
    const files = new Map<string, string>([
      ["C:/Users/me/.agents/skills/unslop/SKILL.md", "---\nname: unslop\ndescription: Humanize prose\n---\n"],
      ["C:/Users/me/.codex/skills/workos/SKILL.md", "---\nname: workos\ndescription: WorkOS docs\n---\n"],
    ]);
    const skills = await discoverLocalSkills("codex", "H:/repo", {
      homeDir: async () => "C:/Users/me",
      listDir: async (path) => {
        const value = directories.get(path);
        if (!value) throw new Error("missing");
        return value;
      },
      readFile: async (path) =>
        ({
          path,
          content: files.get(path) ?? "",
          binary: false,
          too_large: false,
          size: files.get(path)?.length ?? 0,
        }) satisfies FileContent,
    });

    expect(skills.map((skill) => skill.name)).toEqual(["unslop", "workos"]);
    expect(skills.every((skill) => skill.local && skill.path?.endsWith("SKILL.md"))).toBe(true);
  });

  test("turns a selected local skill into provider-readable instructions", () => {
    expect(
      promptTextWithLocalSkills({
        text: "$unslop rewrite this paragraph",
        images: [],
        parts: [
          { type: "text", text: "$unslop rewrite this paragraph" },
          { type: "skill", id: "local-skill:unslop", name: "unslop", path: "C:/skills/unslop/SKILL.md" },
        ],
      }),
    ).toBe(
      'Use the local skill "unslop" for this request. Read "C:/skills/unslop/SKILL.md" completely before acting, and resolve its relative references from that file\'s directory.\n\nrewrite this paragraph',
    );
  });
});
