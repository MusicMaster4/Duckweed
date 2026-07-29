const MIRRORED_TEXT_PROPERTIES = [
  "direction",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "tab-size",
  "white-space",
  "overflow-wrap",
  "word-break",
] as const;

/**
 * Detect whether a collapsed textarea caret is on its first rendered line.
 * A hidden mirror is needed because selectionStart exposes character offsets,
 * but does not expose lines created by the textarea's automatic wrapping.
 */
export function isCaretOnFirstVisualLine(textarea: HTMLTextAreaElement): boolean {
  const start = textarea.selectionStart;
  if (start !== textarea.selectionEnd) return false;
  if (start === 0) return true;

  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const borderWidth =
    Number.parseFloat(computed.borderLeftWidth) + Number.parseFloat(computed.borderRightWidth);

  Object.assign(mirror.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    width: `${textarea.clientWidth + borderWidth}px`,
    minHeight: "0",
    maxHeight: "none",
    height: "auto",
    overflow: "hidden",
  });
  for (const property of MIRRORED_TEXT_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  document.body.appendChild(mirror);
  try {
    const caretTop = (prefix: string) => {
      const marker = document.createElement("span");
      marker.textContent = "\u200b";
      mirror.replaceChildren(document.createTextNode(prefix), marker);
      return marker.offsetTop;
    };
    const firstLineTop = caretTop("");
    const currentLineTop = caretTop(textarea.value.slice(0, start));
    return currentLineTop <= firstLineTop + 1;
  } finally {
    mirror.remove();
  }
}

export function shouldNavigatePromptHistory(
  key: "ArrowUp" | "ArrowDown",
  browsingHistory: boolean,
  caretOnFirstVisualLine: boolean,
): boolean {
  if (browsingHistory) return true;
  return key === "ArrowUp" && caretOnFirstVisualLine;
}
