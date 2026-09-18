import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentGoalIndicator } from "./AgentGoalIndicator";

describe("AgentGoalIndicator", () => {
  test("offers stop while active and resume while paused", () => {
    const onAction = () => {};
    const active = renderToStaticMarkup(<AgentGoalIndicator
      goal={{ objective: "Finish", status: "active" }} onAction={onAction} />);
    expect(active).toContain("Stop goal</button>");
    expect(active).not.toContain("Resume goal</button>");
    const paused = renderToStaticMarkup(<AgentGoalIndicator
      goal={{ objective: "Finish", status: "paused" }} onAction={onAction} />);
    expect(paused).toContain("Paused goal: Finish");
    expect(paused).toContain("Resume goal</button>");
    expect(paused).not.toContain("Stop goal</button>");
  });

  test.each(["blocked", "usageLimited", "budgetLimited"] as const)(
    "keeps the decision available for %s goals", (status) => {
      const html = renderToStaticMarkup(<AgentGoalIndicator
        goal={{ objective: "Finish", status }} onAction={() => {}} />);
      expect(html).toContain("Resume goal</button>");
      expect(html).toContain("Stop goal</button>");
    },
  );

  test("disables controls when the session cannot accept commands", () => {
    const html = renderToStaticMarkup(<AgentGoalIndicator
      goal={{ objective: "Finish", status: "paused" }} onAction={() => {}} disabled />);
    expect(html).toContain('disabled=""');
  });

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
