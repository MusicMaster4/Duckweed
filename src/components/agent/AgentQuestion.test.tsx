import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentPermission, AgentQuestionItem } from "../../lib/agents/types";
import { AgentQuestion } from "./AgentQuestion";

const library: AgentQuestionItem = {
  id: "q0",
  header: "Library",
  question: "Which date library should we use?",
  multiSelect: false,
  options: [
    { id: "o0", label: "date-fns", description: "Small and tree-shakeable", preview: null },
    {
      id: "o1",
      label: "Luxon",
      description: "Rich timezone support",
      preview: "DateTime.now().toISO()",
    },
  ],
};

const scope: AgentQuestionItem = {
  id: "q1",
  header: "Scope",
  question: "Which features should ship?",
  multiSelect: true,
  options: [
    { id: "o0", label: "Search", description: "Full-text over the archive", preview: null },
    { id: "o1", label: "Export", description: "CSV and JSON downloads", preview: null },
  ],
};

function permission(questions: AgentQuestionItem[]): AgentPermission {
  return {
    id: "perm-1",
    kind: "question",
    title: questions[0].question,
    detail: null,
    command: null,
    changes: [],
    options: [{ id: "deny", label: "Skip", kind: "reject" }],
    questions,
  };
}

function render(questions: AgentQuestionItem[]): string {
  return renderToStaticMarkup(
    <AgentQuestion
      permission={permission(questions)}
      onAnswer={() => {}}
      onSkip={() => {}}
    />,
  );
}

describe("agent question", () => {
  test("shows the question, its choices, and what each choice means", () => {
    const html = render([library]);

    expect(html).toContain("Which date library should we use?");
    expect(html).toContain("Library");
    expect(html).toContain("date-fns");
    expect(html).toContain("Small and tree-shakeable");
    expect(html).toContain("Rich timezone support");
    // The digit that picks each option is visible, not just bound.
    expect(html).toContain(">1</span>");
    expect(html).toContain(">2</span>");
  });

  test("always offers a way to answer with something that was not offered", () => {
    const html = render([library]);

    expect(html).toContain("Or write your own answer");
    expect(html).toContain("Answer in your own words");
  });

  test("keeps a long preview behind a toggle so the choices stay readable", () => {
    const html = render([library]);

    expect(html).toContain("Show preview");
    expect(html).not.toContain("DateTime.now().toISO()");
  });

  test("uses radio semantics for one choice and checkbox semantics for several", () => {
    expect(render([library])).toContain('role="radiogroup"');
    expect(render([library])).toContain('role="radio"');
    expect(render([scope])).toContain('role="checkbox"');
  });

  test("cannot be sent until every question has an answer", () => {
    const html = render([library, scope]);

    expect(html).toContain("0 of 2 answered");
    expect(html).toContain("Answer all 2");
    expect(html).toContain('class="agent-question-send" disabled=""');
  });

  test("renders numeric MCP fields with their bounds", () => {
    const html = render([
      {
        id: "count",
        header: "Count",
        question: "How many retries?",
        multiSelect: false,
        inputKind: "integer",
        required: true,
        minimum: 1,
        maximum: 10,
        options: [],
      },
    ]);

    expect(html).toContain('type="number"');
    expect(html).toContain('step="1"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="10"');
  });

  test("renders nothing when the permission carries no questions", () => {
    expect(
      renderToStaticMarkup(
        <AgentQuestion
          permission={{ ...permission([library]), questions: [] }}
          onAnswer={() => {}}
          onSkip={() => {}}
        />,
      ),
    ).toBe("");
  });
});
