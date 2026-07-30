import type {
  AgentPermission,
  AgentQuestionAnswer,
  PermissionOption,
} from "./types";

/**
 * Pick the narrowest affirmative answer for an unattended approval.
 *
 * Prefer a one-time approval so enabling this feature does not silently widen
 * the agent's permissions for the rest of the session.
 */
export function autoApprovalOption(
  permission: AgentPermission | null,
): PermissionOption | null {
  if (!permission || permission.kind === "question") return null;
  return (
    permission.options.find((option) => option.kind === "allow") ??
    permission.options.find((option) => option.kind === "allow-always") ??
    null
  );
}

/**
 * Answer every structured agent question with its first listed option.
 *
 * Adapters expect option labels, not their internal ids. Returning null for a
 * malformed question prevents an empty or partial response from being sent.
 */
export function autoQuestionAnswers(
  permission: AgentPermission | null,
): AgentQuestionAnswer[] | null {
  if (!permission || permission.kind !== "question") return null;
  const questions = permission.questions ?? [];
  if (questions.length === 0 || questions.some((question) => !question.options[0])) {
    return null;
  }
  return questions.map((question) => ({
    questionId: question.id,
    labels: [question.options[0].label],
    custom: null,
  }));
}

/** Dispatch one unattended prompt through the same callbacks used by the UI. */
export function handleUnattendedPermission(
  permission: AgentPermission | null,
  actions: {
    respond: (permissionId: string, optionId: string) => void;
    answer: (permissionId: string, answers: AgentQuestionAnswer[]) => void;
  },
): boolean {
  if (!permission) return false;
  const answers = autoQuestionAnswers(permission);
  if (answers) {
    actions.answer(permission.id, answers);
    return true;
  }
  const option = autoApprovalOption(permission);
  if (!option) return false;
  actions.respond(permission.id, option.id);
  return true;
}
