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
  "touchmove",
  "wheel",
] as const;

/** Observe all meaningful local input while the app window has focus. */
export function observeDesktopActivity(
  target: EventTarget,
  hasFocus: () => boolean,
  onActivity: () => void,
): () => void {
  const recordActivity: EventListener = () => {
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
