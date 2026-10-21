import { describe, expect, test } from "bun:test";
import { agentMarkdownTarget, codexFileCitationAt, markdownLinkAt } from "./agentMarkdownLinks";

describe("agent Markdown links", () => {
  test("reads local artifact links and images with spaces in angle brackets", () => {
    const path = "D:/The stuff you'll need/YouTube Research/summary.html";
    const source = `[Open summary](<${path}>)`;
    expect(markdownLinkAt(source, 0)).toEqual({
      label: "Open summary", destination: path, title: undefined, image: false, end: source.length,
    });
    const image = "![Preview](<D:/The stuff you'll need/summary-preview.jpg>)";
    expect(markdownLinkAt(image, 0)?.image).toBe(true);
    expect(markdownLinkAt(image, 0)?.end).toBe(image.length);
  });

  test("reads nested labels, balanced destinations, escapes, and optional titles", () => {
    const source = '[**Docs** [v2]](https://example.com/a_(b) "Open docs")';
    expect(markdownLinkAt(source, 0)).toEqual({
      label: "**Docs** [v2]", destination: "https://example.com/a_(b)", title: "Open docs",
      image: false, end: source.length,
    });
    expect(markdownLinkAt('[Docs](https://example.com/a\\(b\\))', 0)?.destination)
      .toBe("https://example.com/a(b)");
    expect(markdownLinkAt('[Docs](<https://example.com/a b> \'Docs\')', 0)?.title).toBe("Docs");
    expect(markdownLinkAt('[Docs](https://example.com (Docs))', 0)?.title).toBe("Docs");
  });

  test("keeps incomplete streaming tokens and malformed links unparsed", () => {
    for (const source of ["[Open", "![Preview](<D:/preview.jpg>", "[Open](<D:/preview.jpg", '[Docs](https://example.com "Title)', "[bad](path with spaces)"]) {
      expect(markdownLinkAt(source, 0)).toBeNull();
    }
  });

  test("resolves Windows, POSIX, file URI, and workspace-relative paths", () => {
    expect(agentMarkdownTarget("D:/The stuff you'll need/report.html"))
      .toEqual({ kind: "file", path: "D:/The stuff you'll need/report.html" });
    expect(agentMarkdownTarget("D:\\Reports\\report.html"))
      .toEqual({ kind: "file", path: "D:\\Reports\\report.html" });
    expect(agentMarkdownTarget("/tmp/report.html"))
      .toEqual({ kind: "file", path: "/tmp/report.html" });
    expect(agentMarkdownTarget("file:///D:/Reports/with%20spaces.html"))
      .toEqual({ kind: "file", path: "D:/Reports/with spaces.html" });
    expect(agentMarkdownTarget("output/report.html", "H:\\project"))
      .toEqual({ kind: "file", path: "H:\\project/output/report.html" });
    expect(agentMarkdownTarget("output/report.html")).toBeNull();
  });

  test("encodes web URL spaces and rejects executable schemes and remote file hosts", () => {
    expect(agentMarkdownTarget("https://example.com/a b"))
      .toEqual({ kind: "web", href: "https://example.com/a%20b" });
    for (const source of ["javascript:alert(1)", "data:text/html,test", "vbscript:test", "file://server/report.html", "\\\\server\\report.html", "//server/report.html", "file:///tmp/a%00.html", "https://example.com/a\n"]) {
      expect(agentMarkdownTarget(source, "H:/project")).toBeNull();
    }
  });
});


describe("Codex file citations", () => {
  test("reads complete directives at an offset without consuming following text", () => {
    const path = "C:/Users/jubar/Pdf audio/output/A_Flor_do_Mamulengo.docx";
    const citation = `:codex-file-citation{path="${path}" purpose="output"}`;
    const source = `Ready: ${citation} Done.`;
    expect(codexFileCitationAt(source, 7)).toEqual({
      path, label: "A_Flor_do_Mamulengo.docx", end: 7 + citation.length,
    });
    expect(codexFileCitationAt(source, 0)).toBeNull();
  });

  test("handles optional labels, reordered attributes, and quoted braces", () => {
    const source = ":codex-file-citation[Download PDF]{ purpose='output' path='/tmp/{draft}/report.pdf' }";
    expect(codexFileCitationAt(source, 0)).toEqual({
      path: "/tmp/{draft}/report.pdf", label: "Download PDF", end: source.length,
    });
    expect(codexFileCitationAt(':codex-file-citation[]{path="/tmp/report.pdf"}', 0)?.label)
      .toBe("report.pdf");
  });

  test("preserves Windows backslashes and apostrophes in double quoted paths", () => {
    const path = String.raw`D:\The stuff you'll need\report_v2_final.docx`;
    const source = `:codex-file-citation{path="${path}" purpose="output"}`;
    expect(codexFileCitationAt(source, 0)).toEqual({
      path, label: "report_v2_final.docx", end: source.length,
    });
  });

  test("leaves every incomplete streamed prefix unparsed", () => {
    const source = ':codex-file-citation[Report]{path="/tmp/report.pdf" purpose="output"}';
    for (let end = 0; end < source.length; end += 1) {
      expect(codexFileCitationAt(source.slice(0, end), 0)).toBeNull();
    }
    expect(codexFileCitationAt(source, 0)?.end).toBe(source.length);
  });

  test("rejects missing, blank, duplicate, unquoted, or malformed attributes", () => {
    for (const attributes of [
      '', 'purpose="output"', 'path=""', 'path=" "', 'path=/tmp/report.pdf',
      'path="/tmp/report.pdf" path="/tmp/other.pdf"',
      'path="/tmp/report.pdf"purpose="output"', 'path="/tmp/report.pdf" invalid',
      'path="/tmp/report\n.pdf"',
    ]) {
      expect(codexFileCitationAt(`:codex-file-citation{${attributes}}`, 0)).toBeNull();
    }
  });
});
