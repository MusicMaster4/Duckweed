import { afterEach, describe, expect, test } from "bun:test";

import {
  getPromptTemplates,
  removePromptTemplate,
  resetPromptTemplatesForTests,
  savePromptTemplate,
  searchPromptTemplates,
} from "./promptTemplates";

afterEach(() => resetPromptTemplatesForTests());

describe("prompt templates", () => {
  test("saves templates globally and searches both their title and content", () => {
    savePromptTemplate({ title: "Review", content: "Review this change for accessibility" });
    savePromptTemplate({ title: "Tests", content: "Add focused regression coverage" });

    expect(getPromptTemplates()).toHaveLength(2);
    expect(searchPromptTemplates("review accessibility").map((item) => item.title)).toEqual([
      "Review",
    ]);
    expect(searchPromptTemplates("regression").map((item) => item.title)).toEqual(["Tests"]);
  });

  test("edits and removes one saved template without changing its identity", () => {
    const saved = savePromptTemplate({ title: "First", content: "Initial prompt" });
    if (!saved) throw new Error("expected a saved template");

    const edited = savePromptTemplate(
      { title: "Updated", content: "Improved prompt" },
      saved.id,
    );
    expect(edited?.id).toBe(saved.id);
    expect(getPromptTemplates()[0]).toMatchObject({
      title: "Updated",
      content: "Improved prompt",
    });

    removePromptTemplate(saved.id);
    expect(getPromptTemplates()).toEqual([]);
  });

  test("rejects blank names or prompt bodies", () => {
    expect(savePromptTemplate({ title: "", content: "Prompt" })).toBeNull();
    expect(savePromptTemplate({ title: "Name", content: "  " })).toBeNull();
  });
});
