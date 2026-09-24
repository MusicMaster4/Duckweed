import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { QuotaCards } from "./QuotaCards";
import type { Quota } from "../lib/usage";

test("quota cards show every provider's limits and unavailable state", () => {
  const now = 1_700_000_000_000;
  const quotas: Quota[] = [
    {
      agent: "claude",
      label: "Claude Code",
      source: "reported",
      plan: "pro",
      message: null,
      limits: [
        {
          id: "five-hour",
          label: "Five-hour limit",
          used: 40,
          limit: 100,
          percent: 40,
          unit: "percent",
          resets_at: now + 60 * 60_000,
          window_ms: 5 * 60 * 60_000,
          forecast: null,
        },
      ],
    },
    {
      agent: "codex",
      label: "Codex CLI",
      source: "unavailable",
      plan: null,
      message: "Sign in to check limits.",
      limits: [],
    },
  ];

  const html = renderToStaticMarkup(<QuotaCards quotas={quotas} now={now} />);
  expect(html).toContain("Claude Code");
  expect(html).toContain("Codex CLI");
  expect(html).toContain("Five-hour limit");
  expect(html).toContain('aria-valuenow="60"');
  expect(html).toContain("resets in 1h");
  expect(html).toContain("Sign in to check limits.");
});
