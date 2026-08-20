import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentImageAttachment } from "../../lib/agents/types";
import { AgentImageAttachments, fitLightboxImage } from "./AgentImageAttachments";

const image: AgentImageAttachment = {
  id: "image-1",
  name: "full-screenshot.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,ZnVsbC1yZXNvbHV0aW9u",
  thumbnailDataUrl: "data:image/webp;base64,dGh1bWJuYWls",
  size: 15,
};

describe("agent image attachments", () => {
  test("uses the derived thumbnail only for the small attachment tile", () => {
    const html = renderToStaticMarkup(<AgentImageAttachments images={[image]} />);

    expect(html).toContain(`src="${image.thumbnailDataUrl}"`);
    expect(html).not.toContain(`src="${image.dataUrl}"`);
    expect(html).toContain("View full-screenshot.png full size");
  });

  test("falls back to the original image when no thumbnail is available", () => {
    const html = renderToStaticMarkup(
      <AgentImageAttachments images={[{ ...image, thumbnailDataUrl: undefined }]} />,
    );

    expect(html).toContain(`src="${image.dataUrl}"`);
  });

  test("fits the lightbox image to the viewport and keeps small images native size", () => {
    const viewport = { width: 1600, height: 900 };
    expect(fitLightboxImage(400, 300, viewport)).toEqual({ width: 400, height: 300 });
    expect(fitLightboxImage(4000, 3000, viewport)).toEqual({ width: 1040, height: 780 });
    expect(fitLightboxImage(4000, 1000, viewport)).toEqual({ width: 1500, height: 375 });
  });
});
