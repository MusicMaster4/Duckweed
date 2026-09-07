import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { makeChange, makePatchChange } from "../../lib/agents/types";
import { AgentDiff } from "./AgentDiff";

function addCount(html: string): number {
  return html.match(/agent-diff-line is-add/g)?.length ?? 0;
}

function delCount(html: string): number {
  return html.match(/agent-diff-line is-del/g)?.length ?? 0;
}

function ctxCount(html: string): number {
  return html.match(/agent-diff-line is-ctx/g)?.length ?? 0;
}

describe("AgentDiff", () => {
  test("paints every line of a new file as an addition", () => {
    const html = renderToStaticMarkup(
      <AgentDiff change={makeChange("src/new.ts", null, "one\ntwo\nthree")} />,
    );

    expect(addCount(html)).toBe(3);
    expect(delCount(html)).toBe(0);
    expect(ctxCount(html)).toBe(0);
    expect(html).toContain("+3");
  });

  test("treats an empty previous version as a new file", () => {
    const html = renderToStaticMarkup(
      <AgentDiff
        change={{
          path: "src/new.ts",
          before: "",
          after: "one\ntwo",
          diff: null,
          insertions: 2,
          deletions: 0,
        }}
      />,
    );

    expect(addCount(html)).toBe(2);
    expect(ctxCount(html)).toBe(0);
  });

  test("paints a raw added-file body with no diff markers as additions", () => {
    const html = renderToStaticMarkup(
      <AgentDiff change={makePatchChange("src/new.ts", "export const n = 1;\nexport const m = 2;")} />,
    );

    expect(addCount(html)).toBe(2);
    expect(ctxCount(html)).toBe(0);
  });

  test("keeps context lines on a real unified patch", () => {
    const html = renderToStaticMarkup(
      <AgentDiff
        change={makePatchChange(
          "src/app.ts",
          "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n keep\n-old\n+new\n end\n",
        )}
      />,
    );

    expect(addCount(html)).toBe(1);
    expect(delCount(html)).toBe(1);
    expect(ctxCount(html)).toBe(2);
  });
});
