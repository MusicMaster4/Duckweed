import { Image as TauriImage } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Copy plain text in browsers and embedded webviews.
 *
 * Some webviews expose the Clipboard API but reject writes, so keep the
 * selection-based fallback in one shared place for every agent copy action.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy selection path.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function imageDataUrlAsCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Image canvas is unavailable."));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("Could not load the image for copying."));
    image.src = dataUrl;
  });
}

async function imageDataUrlAsPng(dataUrl: string): Promise<Blob> {
  const canvas = await imageDataUrlAsCanvas(dataUrl);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not prepare the image for copying."));
    }, "image/png");
  });
}

/** Copy an image payload to the operating system clipboard as a PNG bitmap. */
export async function writeClipboardImage(dataUrl: string): Promise<boolean> {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const canvas = await imageDataUrlAsCanvas(dataUrl);
      const context = canvas.getContext("2d");
      if (!context) return false;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const image = await TauriImage.new(
        new Uint8Array(pixels.data),
        canvas.width,
        canvas.height,
      );
      try {
        await writeImage(image);
      } finally {
        await image.close();
      }
      return true;
    } catch {
      // Browser clipboard remains a useful fallback for development previews.
    }
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;

  try {
    // Start the clipboard write during the click gesture. ClipboardItem accepts
    // a pending Blob, so conversion does not consume the browser's user action.
    const item = new ClipboardItem({ "image/png": imageDataUrlAsPng(dataUrl) });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}
