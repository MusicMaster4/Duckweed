import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  AgentSideConversation,
  AgentSideQuestion as SideQuestion,
} from "../../lib/agents/types";
import { AgentSideChat } from "./AgentSideQuestion";

const base: SideQuestion = {
  id: "side-1",
  conversationId: "chat-1",
  command: "/btw",
  question: "Will this affect the main task?",
  answer: "",
  status: "asking",
};

function chat(turns: SideQuestion[], command: "/btw" | "/side" = "/btw"): AgentSideConversation {
  return { id: "chat-1", command, turns };
}

function render(conversation: AgentSideConversation): string {
  return renderToStaticMarkup(
    <AgentSideChat
      conversation={conversation}
      onDismiss={() => {}}
      onSubmit={() => true}
      autoFocus={false}
    />,
  );
}

describe("agent side chat", () => {
  test("shows a distinct busy surface while the answer is pending", () => {
    const html = render(chat([base]));

    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Will this affect the main task?");
    expect(html).toContain("Answering beside the main conversation");
    expect(html).toContain('aria-label="Close side conversation"');
    expect(html).toContain('aria-label="Side conversation message"');
  });

  test("renders every exchange of the thread in order with Markdown answers", () => {
    const html = render(
      chat(
        [
          { ...base, answer: "No. It stays **separate**.", status: "answered" },
          { ...base, id: "side-2", question: "And the tests?", answer: "They pass.", status: "answered" },
        ],
        "/side",
      ),
    );

    expect(html).toContain("<code>/side</code>");
    expect(html).toContain("<strong>separate</strong>");
    expect(html.indexOf("Will this affect the main task?")).toBeLessThan(html.indexOf("And the tests?"));
    expect(html).toContain("They pass.");
    expect(html).not.toContain('aria-busy="true"');
  });

  test("opens empty with a hint when started without a question", () => {
    const html = render(chat([]));

    expect(html).toContain("agent-side-chat is-empty");
    expect(html).toContain("Follow-ups stay in this");
  });

  test("shows images attached to a side question", () => {
    const html = render(
      chat([
        {
          ...base,
          images: [
            {
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              dataUrl: "data:image/png;base64,aGVsbG8=",
              size: 5,
            },
          ],
        },
      ]),
    );

    expect(html).toContain('aria-label="1 attached image"');
    expect(html).toContain('alt="screenshot.png"');
  });

  test("uses an explicit fallback when the provider returns no error text", () => {
    const html = render(chat([{ ...base, status: "error" }]));

    expect(html).toContain("agent-side-chat is-error");
    expect(html).toContain("The side question could not be answered.");
    expect(html).toContain('role="alert"');
  });
});
