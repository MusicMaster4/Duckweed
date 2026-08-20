export interface CompletionFlash {
  key: number;
  /**
   * A completion seen live fades in first. A completion carried in from a
   * background tab is already lit, then waits before fading away.
   */
  kind: "focused" | "review";
}

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

/**
 * Read receipts from older companions have no completion identity. Newer
 * receipts must match exactly so an offline phone cannot review later work.
 */
export function shouldAcknowledgeMobileCompletion(
  currentCompletionSeq: number | null,
  receiptCompletionSeq: number | null,
): boolean {
  return receiptCompletionSeq === null || currentCompletionSeq === receiptCompletionSeq;
}

/**
 * Switching to a tab reviews its selected terminal, but an unread completion
 * there must remain visible long enough for the newly rendered pane to show it.
 */
export function shouldFlashCompletionReview(
  unreadTermIds: ReadonlySet<string>,
  termId: string | null,
  viewChanged: boolean,
): boolean {
  return viewChanged && termId !== null && unreadTermIds.has(termId);
}
