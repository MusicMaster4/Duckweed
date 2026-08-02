import { beforeEach, describe, expect, test } from "bun:test";

import {
  captureLayout,
  countTemplatePanes,
  getDefaultLayout,
  getDefaultLayoutId,
  gridTemplate,
  instantiateLayout,
  removeLayout,
  resetLayoutsForTests,
  saveLayout,
  setDefaultLayout,
  templateCommands,
  withTemplateCommands,
} from "./layouts";
import type { LayoutNode } from "./types";

beforeEach(() => resetLayoutsForTests());

describe("layout templates", () => {
  test("builds balanced two-row grids", () => {
    const root = gridTemplate(Array.from({ length: 8 }, (_, index) => `agent-${index}`));
    expect(root.kind).toBe("split");
    if (root.kind !== "split") throw new Error("expected a split");
    expect(root.dir).toBe("col");
    expect(root.children).toHaveLength(2);
    expect(countTemplatePanes(root)).toBe(8);
    expect(templateCommands(root)).toEqual([
      "agent-0",
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
      "agent-6",
      "agent-7",
    ]);
  });

  test("supports a full 16-pane startup layout", () => {
    const root = gridTemplate(Array.from({ length: 16 }, (_, index) => `command-${index + 1}`));
    expect(countTemplatePanes(root)).toBe(16);
    expect(templateCommands(root)).toHaveLength(16);
    expect(root).toMatchObject({ kind: "split", dir: "col" });
  });

  test("captures geometry and replaces commands without changing it", () => {
    const live: LayoutNode = {
      kind: "split",
      id: "split",
      dir: "row",
      sizes: [0.3, 0.7],
      children: [
        { kind: "leaf", id: "left", term: "one" },
        { kind: "leaf", id: "right", term: "two" },
      ],
    };
    const captured = captureLayout(live, (term) => (term === "one" ? "codex" : "claude"));
    const updated = withTemplateCommands(captured, ["npm test", ""]);
    expect(templateCommands(updated)).toEqual(["npm test", ""]);
    expect(updated).toMatchObject({ kind: "split", dir: "row", sizes: [0.3, 0.7] });
  });

  test("omits a runtime-only one-pane wrapper when capturing", () => {
    const live: LayoutNode = {
      kind: "split",
      id: "retained",
      dir: "row",
      sizes: [1],
      children: [{ kind: "leaf", id: "only", term: "one" }],
    };

    expect(captureLayout(live, () => "codex")).toEqual({
      kind: "leaf",
      command: "codex",
    });
  });

  test("instantiates every template leaf with a fresh terminal", () => {
    let index = 0;
    const live = instantiateLayout(gridTemplate(["codex", "claude"]), (command) => ({
      kind: "leaf",
      id: `pane-${++index}`,
      term: `${command}-${index}`,
    }));
    expect(countTemplatePanes(gridTemplate(["codex", "claude"]))).toBe(2);
    expect(live.kind).toBe("split");
    expect(index).toBe(2);
  });

  test("saves a named reusable layout", () => {
    const saved = saveLayout({ name: " Agent team ", root: gridTemplate(["codex", "claude"]) });
    expect(saved?.name).toBe("Agent team");
    expect(saved?.id).toStartWith("layout-");
  });

  test("keeps one saved layout as the startup default", () => {
    const saved = saveLayout({ name: "Daily agents", root: gridTemplate(["codex", "claude"]) });
    if (!saved) throw new Error("expected a saved layout");

    setDefaultLayout(saved.id);
    expect(getDefaultLayoutId()).toBe(saved.id);
    expect(getDefaultLayout()?.name).toBe("Daily agents");

    removeLayout(saved.id);
    expect(getDefaultLayoutId()).toBeNull();
    expect(getDefaultLayout()).toBeNull();
  });

  test("ignores a missing layout when choosing the startup default", () => {
    setDefaultLayout("layout-that-does-not-exist");
    expect(getDefaultLayoutId()).toBeNull();
  });
});
