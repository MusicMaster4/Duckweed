import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentGoalIndicator } from "./AgentGoalIndicator";

describe("AgentGoalIndicator", () => {
  test("shows an accessible icon for an active goal", () => {
    const html = renderToStaticMarkup(
      <AgentGoalIndicator
        goal={{ objective: "Finish the migration", status: "active" }}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Active goal: Finish the migration"');
    expect(html).toContain("agent-goal-indicator");
  });

  test("stays hidden when there is no active goal", () => {
    expect(
      renderToStaticMarkup(
        <AgentGoalIndicator
          goal={{ objective: "Finished", status: "complete" }}
        />,
      ),
    ).toBe("");
    expect(renderToStaticMarkup(<AgentGoalIndicator goal={null} />)).toBe("");
  });
});
