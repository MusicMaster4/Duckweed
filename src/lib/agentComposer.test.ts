import { describe, expect, test } from "bun:test";

import {
  activeFileMention,
  formatDroppedPaths,
  insertComposerText,
  mentionText,
  replaceMention,
  searchWorkspaceIndex,
} from "./agentComposer";

const files = [
  { name: "AgentComposer.tsx", path: "C:\\repo\\src\\AgentComposer.tsx", relative: "src/AgentComposer.tsx" },
  { name: "composer.test.ts", path: "C:\\repo\\test\\composer.test.ts", relative: "test/composer.test.ts" },
  { name: "README.md", path: "C:\\repo\\README.md", relative: "README.md" },
];

describe("agent composer file mentions", () => {
  test("finds only the mention touching the caret", () => {
    expect(activeFileMention("Check @Agent", 12)).toEqual({ start: 6, end: 12, query: "Agent" });
    expect(activeFileMention("mail@example.com", 16)).toBeNull();
    expect(activeFileMention("@src/file.ts later", 18)).toBeNull();
  });

  test("ranks file-name matches ahead of path-only matches", () => {
    expect(searchWorkspaceIndex(files, "composer").map((file) => file.relative)).toEqual([
      "test/composer.test.ts",
      "src/AgentComposer.tsx",
    ]);
  });

  test("replaces the live token and quotes paths containing spaces", () => {
    const mention = activeFileMention("Open @release", 13)!;
    expect(replaceMention("Open @release", mention, "docs/release notes.md")).toEqual({
      value: 'Open @"docs/release notes.md" ',
      cursor: 30,
    });
    expect(mentionText("src/app.ts")).toBe("@src/app.ts");
  });
});

describe("agent composer path drops", () => {
  test("keeps absolute paths and quotes only the paths that need it", () => {
    expect(formatDroppedPaths(["C:\\repo\\app.ts", "C:\\My Repo\\notes.md"])).toBe(
      'C:\\repo\\app.ts "C:\\My Repo\\notes.md"',
    );
  });

  test("inserts around a selection with readable spacing", () => {
    expect(insertComposerText("Explainthis", 7, 7, "C:\\repo\\a.ts")).toEqual({
      value: "Explain C:\\repo\\a.ts this",
      cursor: 20,
    });
  });
});
