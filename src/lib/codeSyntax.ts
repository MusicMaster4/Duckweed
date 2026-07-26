/**
 * Lightweight syntax highlighting for the project-explorer file popup.
 *
 * Not a full language server — just enough colour for common source files so
 * a vite.config.ts does not look like a wall of grey. Every input character is
 * emitted exactly once so a painted mirror can sit under a transparent textarea.
 */

export type CodeTokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "property"
  | "operator"
  | "punct"
  | "boolean"
  | "regex";

export interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

export type CodeLang =
  | "js"
  | "ts"
  | "json"
  | "css"
  | "html"
  | "md"
  | "rust"
  | "python"
  | "shell"
  | "toml"
  | "yaml"
  | "plain";

/** Map a file path to a highlighter dialect. */
export function langFromPath(path: string): CodeLang {
  const base = path.replace(/^.*[/\\]/, "").toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";

  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "shell";
  if (base === "makefile" || base === "gnumakefile") return "shell";
  if (base === "cargo.lock") return "toml";

  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "ts";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "vue":
    case "svelte":
      return "html";
    case "md":
    case "mdx":
    case "markdown":
      return "md";
    case "rs":
      return "rust";
    case "py":
    case "pyi":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ps1":
    case "psm1":
    case "bat":
    case "cmd":
      return "shell";
    case "toml":
      return "toml";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plain";
  }
}

function words(s: string): Set<string> {
  return new Set(s.trim().split(/\s+/).filter(Boolean));
}

const JS_KEYWORDS = words(`
  as async await break case catch class const continue debugger default delete
  do else enum export extends finally for from function get if implements import
  in instanceof interface let new of package private protected public return set
  static super switch this throw try typeof var void while with yield
`);

const TS_KEYWORDS = new Set([
  ...JS_KEYWORDS,
  ...words(
    "abstract declare is keyof module namespace never readonly require type unknown satisfies asserts overrides override",
  ),
]);

const RUST_KEYWORDS = words(`
  as async await break const continue crate dyn else enum extern false fn for if
  impl in let loop match mod move mut pub ref return self Self static struct super
  trait true type unsafe use where while yield
`);

const PYTHON_KEYWORDS = words(`
  False None True and as assert async await break class continue def del elif else
  except finally for from global if import in is lambda nonlocal not or pass raise
  return try while with yield match case
`);

const BOOLISH = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "None",
  "True",
  "False",
  "nil",
]);

/**
 * Tokenize `source` for display. Safe on incomplete / mid-edit input: a
 * never-closed string simply paints to the end of the buffer.
 */
export function highlightCode(source: string, lang: CodeLang): CodeToken[] {
  if (!source) return [];
  switch (lang) {
    case "plain":
      return [{ text: source, kind: "plain" }];
    case "json":
      return highlightJson(source);
    case "css":
      return highlightCss(source);
    case "html":
      return highlightHtml(source);
    case "md":
      return highlightMarkdown(source);
    case "toml":
    case "yaml":
      return highlightConfig(source);
    case "python":
      return highlightPython(source);
    case "shell":
      return highlightShell(source);
    case "rust":
      return highlightCLike(source, RUST_KEYWORDS, { templates: false, regex: false });
    case "ts":
      return highlightCLike(source, TS_KEYWORDS, { templates: true, regex: true });
    case "js":
    default:
      return highlightCLike(source, JS_KEYWORDS, { templates: true, regex: true });
  }
}

function push(tokens: CodeToken[], text: string, kind: CodeTokenKind) {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
}

function isIdent(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function readLineComment(source: string, i: number): number {
  while (i < source.length && source[i] !== "\n") i++;
  return i;
}

function readBlockComment(source: string, i: number): number {
  // i points at the char after "/*"
  while (i < source.length) {
    if (source[i] === "*" && source[i + 1] === "/") return i + 2;
    i++;
  }
  return i;
}

function readString(source: string, i: number, quote: string): number {
  // i points at the opening quote
  i++;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    // unclosed template expr is handled by the caller for `
    i++;
  }
  return i;
}

function readNumber(source: string, i: number): number {
  const start = i;
  if (source[i] === "0" && i + 1 < source.length && "xXbBoO".includes(source[i + 1]!)) {
    i += 2;
    while (i < source.length && /[0-9a-fA-F_]/.test(source[i]!)) i++;
    return i;
  }
  while (i < source.length && (isDigit(source[i]!) || source[i] === "_")) i++;
  if (source[i] === "." && isDigit(source[i + 1] ?? "")) {
    i++;
    while (i < source.length && (isDigit(source[i]!) || source[i] === "_")) i++;
  }
  if (source[i] === "e" || source[i] === "E") {
    i++;
    if (source[i] === "+" || source[i] === "-") i++;
    while (i < source.length && (isDigit(source[i]!) || source[i] === "_")) i++;
  }
  if (source[i] === "n" && i > start) i++; // bigint
  return i;
}

function highlightCLike(
  source: string,
  keywords: Set<string>,
  opts: { templates: boolean; regex: boolean },
): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  let maybeRegex = true;

  while (i < source.length) {
    const c = source[i]!;
    const n = source[i + 1] ?? "";

    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      const start = i++;
      while (i < source.length && " \t\n\r".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "plain");
      if (source.slice(start, i).includes("\n")) maybeRegex = true;
      continue;
    }

    // line comment
    if (c === "/" && n === "/") {
      const start = i;
      i = readLineComment(source, i + 2);
      push(tokens, source.slice(start, i), "comment");
      maybeRegex = true;
      continue;
    }

    // block comment
    if (c === "/" && n === "*") {
      const start = i;
      i = readBlockComment(source, i + 2);
      push(tokens, source.slice(start, i), "comment");
      maybeRegex = true;
      continue;
    }

    // strings / templates
    if (c === '"' || c === "'" || (opts.templates && c === "`")) {
      if (c === "`") {
        i = readTemplate(source, i, tokens, keywords, opts);
      } else {
        const start = i;
        i = readString(source, i, c);
        push(tokens, source.slice(start, i), "string");
      }
      maybeRegex = false;
      continue;
    }

    // regex literal
    if (opts.regex && c === "/" && maybeRegex) {
      const start = i;
      const end = tryReadRegex(source, i);
      if (end > i) {
        i = end;
        push(tokens, source.slice(start, i), "regex");
        maybeRegex = false;
        continue;
      }
    }

    // number
    if (isDigit(c) || (c === "." && isDigit(n))) {
      const start = i;
      i = readNumber(source, i);
      push(tokens, source.slice(start, i), "number");
      maybeRegex = false;
      continue;
    }

    // identifier / keyword
    if (isIdentStart(c)) {
      const start = i++;
      while (i < source.length && isIdent(source[i]!)) i++;
      const word = source.slice(start, i);
      let kind: CodeTokenKind = "plain";
      if (BOOLISH.has(word)) kind = "boolean";
      else if (keywords.has(word)) kind = "keyword";
      else if (word[0]! >= "A" && word[0]! <= "Z") kind = "type";
      push(tokens, word, kind);
      maybeRegex =
        kind === "keyword" &&
        ["return", "throw", "case", "delete", "void", "typeof", "await", "yield", "in", "of"].includes(
          word,
        );
      if (kind === "plain" || kind === "type" || kind === "boolean") maybeRegex = false;
      continue;
    }

    // operators
    if ("=<>!&|+-*%^~?:".includes(c) || c === "/") {
      const start = i++;
      while (i < source.length && "=<>!&|+-*%^~?:/".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "operator");
      maybeRegex = true;
      continue;
    }

    // punctuation
    if ("(){}[],.;".includes(c)) {
      push(tokens, c, "punct");
      i++;
      maybeRegex = c === "(" || c === "{" || c === "[" || c === "," || c === ";" || c === ":";
      continue;
    }

    push(tokens, c, "plain");
    i++;
    maybeRegex = false;
  }

  return tokens;
}

/** Read a template literal starting at backtick `i`, pushing tokens as we go. */
function readTemplate(
  source: string,
  i: number,
  tokens: CodeToken[],
  keywords: Set<string>,
  opts: { templates: boolean; regex: boolean },
): number {
  // opening `
  let chunkStart = i;
  i++; // past `
  push(tokens, "`", "string");
  chunkStart = i;

  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      push(tokens, source.slice(chunkStart, i), "string");
      push(tokens, "`", "string");
      return i + 1;
    }
    if (c === "$" && source[i + 1] === "{") {
      push(tokens, source.slice(chunkStart, i), "string");
      push(tokens, "${", "punct");
      i += 2;
      const exprStart = i;
      let depth = 1;
      while (i < source.length && depth > 0) {
        // skip strings inside the expression so braces in them don't count
        const ch = source[i]!;
        if (ch === '"' || ch === "'" || ch === "`") {
          if (ch === "`") {
            // nested template: approximate by scanning until unescaped `
            i = readString(source, i, "`");
          } else {
            i = readString(source, i, ch);
          }
          continue;
        }
        if (ch === "/" && source[i + 1] === "/") {
          i = readLineComment(source, i + 2);
          continue;
        }
        if (ch === "/" && source[i + 1] === "*") {
          i = readBlockComment(source, i + 2);
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      const inner = source.slice(exprStart, i);
      for (const t of highlightCLike(inner, keywords, opts)) push(tokens, t.text, t.kind);
      if (i < source.length && source[i] === "}") {
        push(tokens, "}", "punct");
        i++;
      }
      chunkStart = i;
      continue;
    }
    i++;
  }
  // unclosed
  push(tokens, source.slice(chunkStart, i), "string");
  return i;
}

function tryReadRegex(source: string, i: number): number {
  // i at '/'
  let j = i + 1;
  let closed = false;
  while (j < source.length) {
    const c = source[j]!;
    if (c === "\n") return i; // not a regex
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") {
      j++;
      while (j < source.length && source[j] !== "]" && source[j] !== "\n") {
        if (source[j] === "\\") j++;
        j++;
      }
      if (j < source.length && source[j] === "]") j++;
      continue;
    }
    if (c === "/") {
      j++;
      closed = true;
      break;
    }
    j++;
  }
  if (!closed) return i;
  while (j < source.length && "gimsuy".includes(source[j]!)) j++;
  return j;
}

function highlightJson(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      const start = i++;
      while (i < source.length && " \t\n\r".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "plain");
      continue;
    }
    if (c === '"') {
      const start = i;
      i = readString(source, i, '"');
      // property if next non-ws is :
      let k = i;
      while (k < source.length && " \t\n\r".includes(source[k]!)) k++;
      const kind: CodeTokenKind = source[k] === ":" ? "property" : "string";
      push(tokens, source.slice(start, i), kind);
      continue;
    }
    if (isDigit(c) || (c === "-" && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      if (c === "-") i++;
      i = readNumber(source, i);
      push(tokens, source.slice(start, i), "number");
      continue;
    }
    if (source.startsWith("true", i) || source.startsWith("null", i)) {
      const word = source.startsWith("true", i) ? "true" : "null";
      push(tokens, word, "boolean");
      i += word.length;
      continue;
    }
    if (source.startsWith("false", i)) {
      push(tokens, "false", "boolean");
      i += 5;
      continue;
    }
    // comments in jsonc
    if (c === "/" && source[i + 1] === "/") {
      const start = i;
      i = readLineComment(source, i + 2);
      push(tokens, source.slice(start, i), "comment");
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i = readBlockComment(source, i + 2);
      push(tokens, source.slice(start, i), "comment");
      continue;
    }
    if ("{}[],:".includes(c)) {
      push(tokens, c, "punct");
      i++;
      continue;
    }
    push(tokens, c, "plain");
    i++;
  }
  return tokens;
}

function highlightCss(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      const start = i++;
      while (i < source.length && " \t\n\r".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "plain");
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i = readBlockComment(source, i + 2);
      push(tokens, source.slice(start, i), "comment");
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i = readString(source, i, c);
      push(tokens, source.slice(start, i), "string");
      continue;
    }
    if (c === "#") {
      const start = i++;
      while (i < source.length && /[0-9a-fA-F]/.test(source[i]!)) i++;
      push(tokens, source.slice(start, i), i - start > 1 ? "number" : "plain");
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      i = readNumber(source, i);
      // unit
      while (i < source.length && /[a-z%]/i.test(source[i]!)) i++;
      push(tokens, source.slice(start, i), "number");
      continue;
    }
    if (c === "@") {
      const start = i++;
      while (i < source.length && isIdent(source[i]!)) i++;
      push(tokens, source.slice(start, i), "keyword");
      continue;
    }
    if (isIdentStart(c) || c === "-") {
      const start = i++;
      while (i < source.length && (isIdent(source[i]!) || source[i] === "-")) i++;
      const word = source.slice(start, i);
      // property if followed by :
      let k = i;
      while (k < source.length && " \t".includes(source[k]!)) k++;
      if (source[k] === ":") push(tokens, word, "property");
      else if (word === "important") push(tokens, word, "keyword");
      else push(tokens, word, "plain");
      continue;
    }
    if ("{}[]();:,>+~*".includes(c)) {
      push(tokens, c, "punct");
      i++;
      continue;
    }
    push(tokens, c, "plain");
    i++;
  }
  return tokens;
}

function highlightHtml(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const start = i;
      i += 4;
      while (i < source.length && !source.startsWith("-->", i)) i++;
      if (i < source.length) i += 3;
      push(tokens, source.slice(start, i), "comment");
      continue;
    }
    if (source[i] === "<") {
      const start = i++;
      // closing or opening
      if (source[i] === "/") i++;
      const nameStart = i;
      while (i < source.length && /[A-Za-z0-9:_-]/.test(source[i]!)) i++;
      push(tokens, source.slice(start, nameStart), "punct");
      if (i > nameStart) push(tokens, source.slice(nameStart, i), "keyword");

      while (i < source.length && source[i] !== ">") {
        if (source[i] === " " || source[i] === "\t" || source[i] === "\n" || source[i] === "\r") {
          const ws = i++;
          while (i < source.length && " \t\n\r".includes(source[i]!)) i++;
          push(tokens, source.slice(ws, i), "plain");
          continue;
        }
        if (source[i] === '"' || source[i] === "'") {
          const q = source[i]!;
          const s = i;
          i = readString(source, i, q);
          push(tokens, source.slice(s, i), "string");
          continue;
        }
        if (source[i] === "=" || source[i] === "/") {
          push(tokens, source[i]!, "punct");
          i++;
          continue;
        }
        if (isIdentStart(source[i]!) || source[i] === "-") {
          const s = i++;
          while (i < source.length && (isIdent(source[i]!) || source[i] === "-")) i++;
          push(tokens, source.slice(s, i), "property");
          continue;
        }
        push(tokens, source[i]!, "plain");
        i++;
      }
      if (i < source.length && source[i] === ">") {
        push(tokens, ">", "punct");
        i++;
      }
      continue;
    }
    // text
    const start = i++;
    while (i < source.length && source[i] !== "<") i++;
    push(tokens, source.slice(start, i), "plain");
  }
  return tokens;
}

function highlightMarkdown(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const lines = source.split(/(\n)/);
  for (const line of lines) {
    if (line === "\n") {
      push(tokens, "\n", "plain");
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      push(tokens, line, "keyword");
      continue;
    }
    if (/^(\s*[-*+]|\s*\d+\.)\s/.test(line)) {
      const m = line.match(/^(\s*(?:[-*+]|\d+\.))\s/)!;
      push(tokens, m[1]!, "operator");
      push(tokens, line.slice(m[1]!.length), "plain");
      continue;
    }
    if (/^```/.test(line) || /^~~~/.test(line)) {
      push(tokens, line, "comment");
      continue;
    }
    // inline: `code`, **bold** roughly
    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        const start = i++;
        while (i < line.length && line[i] !== "`") i++;
        if (i < line.length) i++;
        push(tokens, line.slice(start, i), "string");
        continue;
      }
      if (line[i] === "[") {
        const start = i;
        const close = line.indexOf("](", i);
        if (close >= 0) {
          const end = line.indexOf(")", close + 2);
          if (end >= 0) {
            push(tokens, line.slice(start, end + 1), "string");
            i = end + 1;
            continue;
          }
        }
      }
      const start = i++;
      while (i < line.length && line[i] !== "`" && line[i] !== "[") i++;
      push(tokens, line.slice(start, i), "plain");
    }
  }
  return tokens;
}

function highlightConfig(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const lines = source.split(/(\n)/);
  for (const line of lines) {
    if (line === "\n") {
      push(tokens, "\n", "plain");
      continue;
    }
    // full-line comment
    const trimmed = line.match(/^(\s*)(#|\/\/|;)/);
    if (trimmed) {
      push(tokens, line, "comment");
      continue;
    }
    // [section]
    if (/^\s*\[/.test(line)) {
      push(tokens, line, "keyword");
      continue;
    }
    // key: value / key = value
    const m = line.match(/^(\s*)([^:=#]+?)(\s*)([:=])(.*)$/);
    if (m) {
      push(tokens, m[1]!, "plain");
      push(tokens, m[2]!, "property");
      push(tokens, m[3]!, "plain");
      push(tokens, m[4]!, "punct");
      const rest = m[5] ?? "";
      // value may have trailing comment
      const hash = rest.search(/(^|[^\\])#/);
      if (hash >= 0) {
        const cut = hash === 0 ? 0 : hash + 1;
        highlightConfigValue(tokens, rest.slice(0, cut));
        push(tokens, rest.slice(cut), "comment");
      } else {
        highlightConfigValue(tokens, rest);
      }
      continue;
    }
    push(tokens, line, "plain");
  }
  return tokens;
}

function highlightConfigValue(tokens: CodeToken[], value: string) {
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === " " || c === "\t") {
      const start = i++;
      while (i < value.length && " \t".includes(value[i]!)) i++;
      push(tokens, value.slice(start, i), "plain");
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i = readString(value, i, c);
      push(tokens, value.slice(start, i), "string");
      continue;
    }
    if (isDigit(c) || (c === "-" && isDigit(value[i + 1] ?? ""))) {
      const start = i;
      if (c === "-") i++;
      i = readNumber(value, i);
      push(tokens, value.slice(start, i), "number");
      continue;
    }
    if (value.startsWith("true", i) || value.startsWith("false", i) || value.startsWith("null", i)) {
      const w = value.startsWith("false", i) ? "false" : value.startsWith("true", i) ? "true" : "null";
      push(tokens, w, "boolean");
      i += w.length;
      continue;
    }
    const start = i++;
    while (i < value.length && !" \t\"'#".includes(value[i]!)) i++;
    push(tokens, value.slice(start, i), "string");
  }
}

function highlightPython(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      const start = i++;
      while (i < source.length && " \t\n\r".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "plain");
      continue;
    }
    if (c === "#") {
      const start = i;
      i = readLineComment(source, i + 1);
      push(tokens, source.slice(start, i), "comment");
      continue;
    }
    // triple quotes
    if (
      (c === '"' || c === "'") &&
      source[i + 1] === c &&
      source[i + 2] === c
    ) {
      const q = c;
      const start = i;
      i += 3;
      while (i < source.length && !(source[i] === q && source[i + 1] === q && source[i + 2] === q)) i++;
      if (i < source.length) i += 3;
      push(tokens, source.slice(start, i), "string");
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i = readString(source, i, c);
      push(tokens, source.slice(start, i), "string");
      continue;
    }
    // string prefixes: f", r', b"""
    if ("fFrRbBuU".includes(c) && (source[i + 1] === '"' || source[i + 1] === "'")) {
      const start = i++;
      // optional second prefix
      if ("fFrRbBuU".includes(source[i]!) && (source[i + 1] === '"' || source[i + 1] === "'")) i++;
      if (source[i] === source[i + 1] && source[i] === source[i + 2]) {
        const q = source[i]!;
        i += 3;
        while (i < source.length && !(source[i] === q && source[i + 1] === q && source[i + 2] === q)) i++;
        if (i < source.length) i += 3;
      } else {
        i = readString(source, i, source[i]!);
      }
      push(tokens, source.slice(start, i), "string");
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      i = readNumber(source, i);
      push(tokens, source.slice(start, i), "number");
      continue;
    }
    if (isIdentStart(c)) {
      const start = i++;
      while (i < source.length && isIdent(source[i]!)) i++;
      const word = source.slice(start, i);
      let kind: CodeTokenKind = "plain";
      if (BOOLISH.has(word)) kind = "boolean";
      else if (PYTHON_KEYWORDS.has(word)) kind = "keyword";
      else if (word[0]! >= "A" && word[0]! <= "Z") kind = "type";
      push(tokens, word, kind);
      continue;
    }
    if ("=<>!&|+-*%^~@".includes(c) || c === "/") {
      const start = i++;
      while (i < source.length && "=<>!&|+-*%^~@/".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "operator");
      continue;
    }
    if ("(){}[],.:;".includes(c)) {
      push(tokens, c, "punct");
      i++;
      continue;
    }
    push(tokens, c, "plain");
    i++;
  }
  return tokens;
}

function highlightShell(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      const start = i++;
      while (i < source.length && " \t\n\r".includes(source[i]!)) i++;
      push(tokens, source.slice(start, i), "plain");
      continue;
    }
    if (c === "#") {
      const start = i;
      i = readLineComment(source, i + 1);
      push(tokens, source.slice(start, i), "comment");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      i = readString(source, i, c);
      push(tokens, source.slice(start, i), "string");
      continue;
    }
    if (c === "$") {
      const start = i++;
      if (source[i] === "{") {
        while (i < source.length && source[i] !== "}") i++;
        if (i < source.length) i++;
      } else {
        while (i < source.length && isIdent(source[i]!)) i++;
      }
      push(tokens, source.slice(start, i), "property");
      continue;
    }
    if (c === "-" && (isIdentStart(source[i + 1] ?? "") || source[i + 1] === "-")) {
      const start = i++;
      while (i < source.length && !/[\s|&;<>]/.test(source[i]!)) i++;
      push(tokens, source.slice(start, i), "keyword");
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      i = readNumber(source, i);
      push(tokens, source.slice(start, i), "number");
      continue;
    }
    if (isIdentStart(c)) {
      const start = i++;
      while (i < source.length && (isIdent(source[i]!) || source[i] === "-" || source[i] === ".")) i++;
      push(tokens, source.slice(start, i), "plain");
      continue;
    }
    if ("|&;<>(){}[]=".includes(c)) {
      push(tokens, c, "operator");
      i++;
      continue;
    }
    push(tokens, c, "plain");
    i++;
  }
  return tokens;
}
