import { describe, expect, test } from "bun:test";

import {
  autoApprovalOption,
  autoQuestionAnswers,
  handleUnattendedPermission,
} from "./autoApproval";
import type { AgentPermission } from "./types";

function permission(
  options: AgentPermission["options"],
  kind: AgentPermission["kind"] = "approval",
): AgentPermission {
  return {
    id: "permission-1",
    kind,
    title: "Run a command",
    detail: null,
    command: "example",
    changes: [],
    options,
  };
}

describe("automatic approval selection", () => {
  test("prefers a one-time approval over a session-wide approval", () => {
    const selected = autoApprovalOption(
      permission([
        { id: "always", label: "Always", kind: "allow-always" },
        { id: "once", label: "Allow", kind: "allow" },
      ]),
    );

    expect(selected?.id).toBe("once");
  });

  test("uses a session-wide approval when it is the only affirmative option", () => {
    const selected = autoApprovalOption(
      permission([
        { id: "deny", label: "Deny", kind: "reject" },
        { id: "always", label: "Always", kind: "allow-always" },
      ]),
    );

    expect(selected?.id).toBe("always");
  });

  test("answers every agent question with its first option", () => {
    const prompt = {
      ...permission([{ id: "skip", label: "Skip", kind: "reject" }], "question"),
      questions: [
        {
          id: "q0",
          header: "Library",
          question: "Which library?",
          multiSelect: false,
          options: [
            { id: "o0", label: "First library", description: "", preview: null },
            { id: "o1", label: "Second library", description: "", preview: null },
          ],
        },
        {
          id: "q1",
          header: "Database",
          question: "Which database?",
          multiSelect: true,
          options: [
            { id: "o0", label: "First database", description: "", preview: null },
            { id: "o1", label: "Second database", description: "", preview: null },
          ],
        },
      ],
    };

    expect(autoQuestionAnswers(prompt)).toEqual([
      { questionId: "q0", labels: ["First library"], custom: null },
      { questionId: "q1", labels: ["First database"], custom: null },
    ]);
    expect(autoApprovalOption(prompt)).toBeNull();
  });

  test("does not send a partial answer when a question has no options", () => {
    const prompt = {
      ...permission([], "question"),
      questions: [
        {
          id: "q0",
          header: "Empty",
          question: "What now?",
          multiSelect: false,
          options: [],
        },
      ],
    };

    expect(autoQuestionAnswers(prompt)).toBeNull();
  });

  test("returns null when no affirmative option exists", () => {
    expect(
      autoApprovalOption(
        permission([{ id: "deny", label: "Deny", kind: "reject" }]),
      ),
    ).toBeNull();
  });

  test("dispatches approvals through respond and questions through answer", () => {
    const calls: unknown[] = [];
    const actions = {
      respond: (permissionId: string, optionId: string) =>
        calls.push(["respond", permissionId, optionId]),
      answer: (permissionId: string, answers: unknown[]) =>
        calls.push(["answer", permissionId, answers]),
    };
    const approval = permission([
      { id: "allow", label: "Allow", kind: "allow" },
      { id: "deny", label: "Deny", kind: "reject" },
    ]);
    const question = {
      ...permission([], "question"),
      questions: [
        {
          id: "q0",
          header: "Choice",
          question: "Choose one",
          multiSelect: false,
          options: [
            { id: "o0", label: "First", description: "", preview: null },
            { id: "o1", label: "Second", description: "", preview: null },
          ],
        },
      ],
    };

    expect(handleUnattendedPermission(approval, actions)).toBe(true);
    expect(handleUnattendedPermission(question, actions)).toBe(true);
    expect(calls).toEqual([
      ["respond", "permission-1", "allow"],
      [
        "answer",
        "permission-1",
        [{ questionId: "q0", labels: ["First"], custom: null }],
      ],
    ]);
  });
});
