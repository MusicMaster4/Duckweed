import type { MouseEvent } from "react";

import { writeClipboardText } from "../../lib/clipboard";

/**
 * Browser selections and form-control selections use separate DOM APIs. Read
 * both so right-click copy works in the transcript and in agent text fields.
 */
function selectedTextWithin(root: HTMLElement, target: EventTarget | null): string {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start !== null && end !== null && start !== end) {
      return target.value.slice(Math.min(start, end), Math.max(start, end));
    }
  }

  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    return "";
  }
  return selection.toString();
}

/** Copy a selection owned by one custom-agent surface on right click. */
export function copySelectedTextFromContextMenu(
  event: MouseEvent<HTMLElement>,
): Promise<boolean> | null {
  const selected = selectedTextWithin(event.currentTarget, event.target);
  if (!selected) return null;
  event.preventDefault();
  event.stopPropagation();
  return writeClipboardText(selected);
}
