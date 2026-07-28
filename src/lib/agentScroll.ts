export const JUMP_TO_BOTTOM_DISTANCE = 96;
export const BOTTOM_FOLLOW_DISTANCE = 18;

type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export function distanceFromBottom(node: ScrollMetrics): number {
  return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight);
}

export function isAtScrollBottom(node: ScrollMetrics): boolean {
  return distanceFromBottom(node) <= BOTTOM_FOLLOW_DISTANCE;
}

export function shouldShowJumpToBottom(
  node: ScrollMetrics,
  userPaused: boolean,
): boolean {
  if (!userPaused || node.scrollHeight <= node.clientHeight) return false;
  return distanceFromBottom(node) > JUMP_TO_BOTTOM_DISTANCE;
}
