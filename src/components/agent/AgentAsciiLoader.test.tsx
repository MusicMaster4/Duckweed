import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentId } from "../../lib/agents/types";
import { AgentAsciiLoader, ASCII_PAINTERS } from "./AgentAsciiLoader";

const AGENTS: AgentId[] = ["codex", "claude", "grok", "cursor", "opencode"];

describe("agent startup animation", () => {
  test("every provider paints a full, non-empty grid", () => {
    for (const agent of AGENTS) {
      const rows = ASCII_PAINTERS[agent](0).split("\n");
      const width = rows[0].length;
      expect(rows.length).toBeGreaterThan(4);
      expect(width).toBeGreaterThan(12);
      for (const row of rows) expect(row.length).toBe(width);
      expect(ASCII_PAINTERS[agent](0).trim().length).toBeGreaterThan(0);
    }
  });

  test("every provider actually animates", () => {
    for (const agent of AGENTS) {
      expect(ASCII_PAINTERS[agent](0)).not.toBe(ASCII_PAINTERS[agent](0.4));
    }
  });

  test("renders a labelled status region without a server-side timer", () => {
    const html = renderToStaticMarkup(<AgentAsciiLoader agent="grok" label="Starting session" />);
    expect(html).toContain('role="status"');
    expect(html).toContain("agent-ascii-loader is-grok");
    expect(html).toContain("Starting session");
  });
});
