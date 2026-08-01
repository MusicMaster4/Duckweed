import { afterEach, describe, expect, test } from "bun:test";

import {
  getPromptTemplates,
  MAX_CONTENT_LENGTH,
  MAX_TEMPLATES,
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

  test("rejects oversized prompts instead of truncating them", () => {
    const content = "x".repeat(MAX_CONTENT_LENGTH + 1);
    expect(savePromptTemplate({ title: "Long prompt", content })).toBeNull();
    expect(getPromptTemplates()).toEqual([]);
  });

  test("refuses new templates at the limit without evicting saved ones", () => {
    const existing = Array.from({ length: MAX_TEMPLATES }, (_, index) => ({
      id: `template-${index}`,
      title: `Template ${index}`,
      content: `Prompt ${index}`,
      createdAt: index,
      updatedAt: index,
    }));
    resetPromptTemplatesForTests(existing);

    expect(savePromptTemplate({ title: "One too many", content: "Keep everything" })).toBeNull();
    expect(getPromptTemplates()).toEqual(existing);
  });
});
