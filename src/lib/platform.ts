/**
 * Platform helpers shared by keyboard handling.
 *
 * Terminals treat Control and Command as different keys on macOS: Cmd+C copies,
 * Ctrl+C interrupts. Windows and Linux fold both jobs into Ctrl+C (copy when
 * there is a selection, otherwise interrupt / clear draft).
 */

/** True on macOS and other Apple platforms where Command is the app modifier. */
export function isApplePlatform(
  platform: string = typeof navigator !== "undefined" ? navigator.platform : "",
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return true;
  // iPadOS 13+ reports a desktop Mac platform string sometimes; also cover UA.
  return /Mac OS X|Macintosh/i.test(userAgent) && !/Windows/i.test(userAgent);
}

export type CKeyAction = "copy" | "control" | null;

/**
 * What plain C + modifier should do for terminal / composer handling.
 *
 * - Apple: Cmd+C copies when there is a selection; Ctrl+C always runs the
 *   control path (clear draft / interrupt). Cmd without a selection is left
 *   alone so the OS/browser keep their defaults.
 * - Windows / Linux: Ctrl+C copies when there is a selection, otherwise control.
 */
export function cKeyAction(
  event: { ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean; altKey?: boolean },
  hasCopyableSelection: boolean,
  apple: boolean = isApplePlatform(),
): CKeyAction {
  if (event.shiftKey || event.altKey) return null;

  if (apple) {
    if (event.metaKey && !event.ctrlKey) {
      return hasCopyableSelection ? "copy" : null;
    }
    if (event.ctrlKey && !event.metaKey) {
      return "control";
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey) {
    return hasCopyableSelection ? "copy" : "control";
  }
  return null;
}

/**
 * Physical Control chord (not Command). Used for terminal control keys such as
 * Ctrl+D (EOF) that must never fire from Cmd on macOS.
 */
export function isControlChord(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey && !event.metaKey;
}

/**
 * Primary app modifier: Command on Apple platforms, Control elsewhere.
 * Accepts either key when the platform is not Apple so WebView quirks still
 * reach app shortcuts.
 */
export function isAppModifier(event: { ctrlKey: boolean; metaKey: boolean }, apple: boolean = isApplePlatform()): boolean {
  if (apple) return event.metaKey || event.ctrlKey;
  return event.ctrlKey || event.metaKey;
}

/** True for the F11 key, including auto-repeat. `code` covers odd layouts. */
export function isFullscreenKey(event: { key: string; code?: string }): boolean {
  return event.key === "F11" || event.code === "F11";
}

/**
 * F11 toggles the OS window, not pane zoom. Auto-repeat is ignored so holding
 * the key does not flicker in and out of fullscreen.
 */
export function isFullscreenHotkey(event: {
  key: string;
  code?: string;
  repeat?: boolean;
}): boolean {
  return !event.repeat && isFullscreenKey(event);
}
