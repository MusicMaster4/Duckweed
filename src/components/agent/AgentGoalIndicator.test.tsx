import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentGoalIndicator } from "./AgentGoalIndicator";

describe("AgentGoalIndicator", () => {
  test("shows an accessible target for an active objective", () => {
    const html = renderToStaticMarkup(
      <AgentGoalIndicator
        goal={{ objective: "Finish the migration", status: "active" }}
      />,
    );

    expect(html).toContain('class="agent-goal-indicator"');
    expect(html).toContain('aria-label="Active goal: Finish the migration"');
    expect(html).toContain("<svg");
  });

  test("disappears when the objective is complete or inactive", () => {
    expect(
      renderToStaticMarkup(
        <AgentGoalIndicator
          goal={{ objective: "Finish the migration", status: "complete" }}
        />,
      ),
    ).toBe("");
    expect(renderToStaticMarkup(<AgentGoalIndicator goal={null} />)).toBe("");
  });
});

