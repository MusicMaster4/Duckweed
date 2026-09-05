/** Match a borderless, border-box textarea without rounding fractional pixels. */
export function syncTextareaMirror(
  textarea: HTMLTextAreaElement,
  mirror: HTMLElement,
): void {
  const style = getComputedStyle(textarea);
  // clientWidth/clientHeight are integers. Using them as CSS dimensions can
  // move a word to another line in fractional-width panes or at browser zoom.
  const scrollbarWidth = textarea.offsetWidth - textarea.clientWidth;
  const scrollbarHeight = textarea.offsetHeight - textarea.clientHeight;
  mirror.style.width = `${parseFloat(style.width) - scrollbarWidth}px`;
  mirror.style.height = `${parseFloat(style.height) - scrollbarHeight}px`;
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
}
