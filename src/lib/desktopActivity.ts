/**
 * Browser events that prove somebody is using the desktop app.
 *
 * Pointer movement is intentionally included. Merely moving the cursor over
 * Duckweed is enough to suppress an unattended selected-terminal alert.
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
 * Observe local input delivered to the app.
 *
 * Do not gate this with `document.hasFocus()`. A visible but inactive native
 * window can receive hover movement before the operating system gives it
 * focus, and that movement is still proof that the computer is attended.
 */
export function observeDesktopActivity(
  target: EventTarget,
  onActivity: () => void,
): () => void {
  const recordActivity: EventListener = () => onActivity();
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
