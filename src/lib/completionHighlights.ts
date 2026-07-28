/**
 * Mark one terminal completion as reviewed without disturbing completion
 * markers owned by other panes.
 */
export function acknowledgeCompletion(
  unreadTermIds: Set<string>,
  termId: string,
): Set<string> {
  if (!unreadTermIds.has(termId)) return unreadTermIds;
  const next = new Set(unreadTermIds);
  next.delete(termId);
  return next;
}
