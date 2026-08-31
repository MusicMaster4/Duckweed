import { homeDir, listDir, readFile } from "../ipc";
import type { AgentExtension, AgentId, AgentPrompt } from "./types";

interface SkillIo {
  homeDir: () => Promise<string>;
  listDir: typeof listDir;
  readFile: typeof readFile;
}

const defaultIo: SkillIo = { homeDir, listDir, readFile };

interface SkillRoot {
  path: string;
  source: string;
  priority: number;
}

function separator(path: string): "\\" | "/" {
  return path.includes("\\") ? "\\" : "/";
}

function joinPath(root: string, ...parts: string[]): string {
  const sep = separator(root);
  return [root.replace(/[\\/]+$/, ""), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""))]
    .filter(Boolean)
    .join(sep);
}

function providerSkillDirs(agent: AgentId): string[] {
  switch (agent) {
    case "codex":
      return [".codex"];
    case "claude":
      return [".claude"];
    case "grok":
      // Grok's harness compatibility imports Claude and Cursor skills in
      // addition to the shared .agents convention.
      return [".claude", ".cursor", ".grok"];
    case "cursor":
      return [".cursor"];
    case "opencode":
      return [".opencode"];
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Read the small metadata surface every SKILL.md exposes in YAML frontmatter. */
export function parseSkillMetadata(
  contents: string,
  fallbackName: string,
): { name: string; description: string } {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1] ?? "";
  let name = "";
  let description = "";
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1].toLowerCase();
    if (key === "name") name = unquote(field[2]);
    if (key === "description") description = unquote(field[2]);
  }
  return { name: name || fallbackName, description };
}

async function skillsUnder(root: SkillRoot, io: SkillIo): Promise<AgentExtension[]> {
  let entries;
  try {
    entries = await io.listDir(root.path);
  } catch {
    return [];
  }

  const skills: AgentExtension[] = [];
  for (const directory of entries) {
    if (!directory.is_dir) continue;
    let children;
    try {
      children = await io.listDir(directory.path);
    } catch {
      continue;
    }
    const manifest = children.find(
      (entry) => !entry.is_dir && entry.name.toLowerCase() === "skill.md",
    );
    if (!manifest) continue;
    try {
      const file = await io.readFile(manifest.path);
      if (file.binary || file.too_large) continue;
      const metadata = parseSkillMetadata(file.content, directory.name);
      skills.push({
        id: `local-skill:${manifest.path}`,
        kind: "skill",
        name: metadata.name,
        description: metadata.description,
        enabled: true,
        callable: true,
        local: true,
        status: "ready",
        path: manifest.path,
        source: root.source,
      });
    } catch {
      // A malformed or concurrently removed skill should not hide the rest.
    }
  }
  return skills;
}

/**
 * Local skills visible to one agent. Shared .agents roots are universal;
 * provider roots are additive and never include plugin caches or app bundles.
 */
export async function discoverLocalSkills(
  agent: AgentId,
  cwd: string,
  io: SkillIo = defaultIo,
): Promise<AgentExtension[]> {
  const home = await io.homeDir();
  const roots: SkillRoot[] = [
    { path: joinPath(home, ".agents", "skills"), source: "User", priority: 10 },
    ...providerSkillDirs(agent).map((dir, index) => ({
      path: joinPath(home, dir, "skills"),
      source: `User (${dir.slice(1)})`,
      priority: 20 + index,
    })),
    { path: joinPath(cwd, ".agents", "skills"), source: "Project", priority: 100 },
    ...providerSkillDirs(agent).map((dir, index) => ({
      path: joinPath(cwd, dir, "skills"),
      source: `Project (${dir.slice(1)})`,
      priority: 110 + index,
    })),
  ];
  const discovered = (await Promise.all(roots.map((root) => skillsUnder(root, io))))
    .flat()
    .map((skill) => ({
      skill,
      priority: roots.find((root) => root.source === skill.source)?.priority ?? 0,
    }))
    .sort((a, b) => a.priority - b.priority);

  // Project definitions shadow user definitions with the same invocation name.
  const byName = new Map<string, AgentExtension>();
  for (const { skill } of discovered) byName.set(skill.name.toLowerCase(), skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a selected `$name` token while preserving the user's actual task. */
function withoutSkillToken(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`(^|\\s)\\$${escaped}(?=\\s|$)`, "gi"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Providers without Codex's structured skill input still receive a real skill
 * invocation: they are told to read the selected SKILL.md before acting.
 */
export function promptTextWithLocalSkills(prompt: AgentPrompt): string {
  const skills = (prompt.parts ?? []).filter(
    (part): part is Extract<NonNullable<AgentPrompt["parts"]>[number], { type: "skill" }> =>
      part.type === "skill" && Boolean(part.path),
  );
  if (!skills.length) return prompt.text;
  let task = prompt.text;
  for (const skill of skills) task = withoutSkillToken(task, skill.name);
  const instructions = skills.map(
    (skill) =>
      `Use the local skill "${skill.name}" for this request. Read "${skill.path}" completely before acting, and resolve its relative references from that file's directory.`,
  );
  return `${instructions.join("\n")}\n\n${task || "Apply the selected skill."}`;
}
