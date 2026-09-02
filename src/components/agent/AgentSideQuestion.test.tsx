import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentSideQuestion as SideQuestion } from "../../lib/agents/types";
import { AgentSideQuestion } from "./AgentSideQuestion";

const base: SideQuestion = {
  id: "side-1",
  command: "/btw",
  question: "Will this affect the main task?",
  answer: "",
  status: "asking",
};

describe("agent side question", () => {
  test("shows a distinct busy surface while the answer is pending", () => {
    const html = renderToStaticMarkup(
      <AgentSideQuestion question={base} onDismiss={() => {}} />,
    );

    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Will this affect the main task?");
    expect(html).toContain("Answering beside the main conversation");
    expect(html).toContain('aria-label="Dismiss side question"');
  });

  test("renders a completed answer as safe Markdown", () => {
    const html = renderToStaticMarkup(
      <AgentSideQuestion
        question={{
          ...base,
          command: "/side",
          answer: "No. It stays **separate** from the main transcript.",
          status: "answered",
        }}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain('class="agent-side-question is-answered"');
    expect(html).toContain("<code>/side</code>");
    expect(html).toContain("<strong>separate</strong>");
    expect(html).not.toContain('aria-busy="true"');
  });

  test("shows images attached to the side question", () => {
    const html = renderToStaticMarkup(
      <AgentSideQuestion
        question={{
          ...base,
          command: "/side",
          images: [
            {
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              dataUrl: "data:image/png;base64,aGVsbG8=",
              size: 5,
            },
          ],
        }}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain('aria-label="1 attached image"');
    expect(html).toContain('alt="screenshot.png"');
  });

  test("uses an explicit fallback when the provider returns no error text", () => {
    const html = renderToStaticMarkup(
      <AgentSideQuestion question={{ ...base, status: "error" }} onDismiss={() => {}} />,
    );

    expect(html).toContain('class="agent-side-question is-error"');
    expect(html).toContain("The side question could not be answered.");
    expect(html).toContain('role="alert"');
  });
});
