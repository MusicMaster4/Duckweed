export interface MarkdownLink {
  label: string;
  destination: string;
  title?: string;
  image: boolean;
  end: number;
}

/** Read complete inline links, keeping partial streamed tokens as plain text. */
export function markdownLinkAt(text: string, start: number): MarkdownLink | null {
  const image = text.startsWith("![", start);
  let index = start + (image ? 2 : 1);
  if (!image && text[start] !== "[") return null;
  const labelStart = index;
  let brackets = 1;
  while (index < text.length && brackets > 0) {
    if (text[index] === "\\" && /[\\[\]]/.test(text[index + 1] ?? "")) index += 2;
    else {
      if (text[index] === "[") brackets += 1;
      if (text[index] === "]") brackets -= 1;
      if (brackets > 0) index += 1;
    }
  }
  if (brackets || text[index + 1] !== "(") return null;
  const label = text.slice(labelStart, index);
  index += 2;
  while (/\s/.test(text[index] ?? "") && index < text.length) index += 1;
  let destination: string;
  if (text[index] === "<") {
    const end = text.indexOf(">", index + 1);
    if (end < 0 || /[\n<>]/.test(text.slice(index + 1, end))) return null;
    destination = text.slice(index + 1, end);
    index = end + 1;
  } else {
    const destinationStart = index;
    let parentheses = 0;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\" && /[()]/.test(text[index + 1] ?? "")) {
        index += 2;
        continue;
      }
      if (character === "(") parentheses += 1;
      if (character === ")") {
        if (parentheses === 0) break;
        parentheses -= 1;
      }
      if (/\s/.test(character)) break;
      index += 1;
    }
    if (parentheses) return null;
    destination = text.slice(destinationStart, index).replace(/\\([()])/g, "$1");
  }
  const hadWhitespace = /\s/.test(text[index] ?? "");
  while (/\s/.test(text[index] ?? "") && index < text.length) index += 1;
  let title: string | undefined;
  if (hadWhitespace && /["'(]/.test(text[index] ?? "")) {
    const delimiter = text[index] === "(" ? ")" : text[index];
    const titleStart = ++index;
    while (index < text.length && text[index] !== delimiter) {
      if (text[index] === "\\") index += 1;
      index += 1;
    }
    if (index >= text.length) return null;
    title = text.slice(titleStart, index).replace(/\\(["'()\\])/g, "$1");
    index += 1;
    while (/\s/.test(text[index] ?? "") && index < text.length) index += 1;
  }
  if (text[index] !== ")" || !destination) return null;
  return { label, destination, title, image, end: index + 1 };
}

export type AgentMarkdownTarget = { kind: "web"; href: string } | { kind: "file"; path: string };

/** Allow web URLs and local paths without accepting arbitrary URI schemes. */
export function agentMarkdownTarget(destination: string, cwd = ""): AgentMarkdownTarget | null {
  if (/[\u0000-\u001f\u007f]/.test(destination)) return null;
  if (/^https?:\/\//i.test(destination)) {
    try {
      const url = new URL(destination);
      return { kind: "web", href: url.href };
    } catch { return null; }
  }
  let path = destination;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch { return null; }
  } else if (!/^[a-z]:[\\/]/i.test(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(path) || /^(?:\\\\|\/\/)/.test(path)) return null;
  if (!/^(?:[a-z]:[\\/]|\/)/i.test(path)) {
    if (!cwd) return null;
    path = `${cwd.replace(/[\\/]$/, "")}/${path}`;
  }
  return { kind: "file", path };
}
