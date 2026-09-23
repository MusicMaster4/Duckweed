/**
 * Browser events that prove somebody is using the desktop app.
 *
 * Pointer movement is intentionally included while Duckweed is the active
 * window. Merely moving across an inactive WebView is not reliable evidence
 * that the completion was seen: WebView2 can deliver hover events without
 * activating the native window.
 */
export const DESKTOP_ACTIVITY_EVENTS = [
  "focus",
  "keydown",
  "beforeinput",
  "pointerdown",
  "pointermove",
  // WebView mouse events are kept as a fallback for environments where
  // pointer events are not emitted while the native window is inactive.
  "mousedown",
  "mousemove",
  "touchmove",
  "wheel",
] as const;

/**
 * Observe meaningful local input while the app window has focus.
 *
 * Only focus on the window itself counts. Captured focus events from fields
 * can be caused by automatic composer or approval-card focus without input.
 * Other events are ignored while the native window is inactive so background
 * hover traffic cannot suppress every delayed mobile notification.
 */
export function observeDesktopActivity(
  target: EventTarget,
  hasFocus: () => boolean,
  onActivity: () => void,
): () => void {
  const recordActivity: EventListener = (event) => {
    if (event.type === "focus") {
      if (event.target === target) onActivity();
      return;
    }
    if (hasFocus()) onActivity();
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };

  for (const event of DESKTOP_ACTIVITY_EVENTS) {
    target.addEventListener(event, recordActivity, options);
  }

  return () => {
    for (const event of DESKTOP_ACTIVITY_EVENTS) {
      target.removeEventListener(event, recordActivity, options);
    }
  };
}
