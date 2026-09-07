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

interface ObserverSet<T> {
  observe(target: T): void;
  unobserve(target: T): void;
}

/** Keep an observer from retaining children that React already removed. */
export function syncObservedChildren<T>(
  observer: ObserverSet<T>,
  observed: Set<T>,
  current: Iterable<T>,
): void {
  const currentSet = new Set(current);
  for (const child of observed) {
    if (currentSet.has(child)) continue;
    observer.unobserve(child);
    observed.delete(child);
  }
  for (const child of currentSet) {
    if (observed.has(child)) continue;
    observed.add(child);
    observer.observe(child);
  }
}
