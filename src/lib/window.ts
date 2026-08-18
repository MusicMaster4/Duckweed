import { getCurrentWindow } from "@tauri-apps/api/window";
import { syncWebviewBounds, toggleWindowFullscreen } from "./ipc";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Fullscreen has to round-trip through the OS window, so the state we read back
 * is the truth. Callers get the resulting state to update their own UI.
 *
 * On Windows a frameless window's exclusive fullscreen covers the taskbar
 * but leaves WebView2 at the work-area size (the black strip under the
 * status bar). The Rust command stretches the HWND and the webview to the
 * monitor; a follow-up pass runs after the transition settles.
 *
 * Outside Tauri (vite in a browser) the document Fullscreen API is the
 * closest stand-in; a refused request leaves the window as it was.
 */
export async function toggleFullscreen(): Promise<boolean> {
  try {
    if (isTauri()) {
      const next = await toggleWindowFullscreen();
      window.setTimeout(() => {
        void syncWebviewBounds();
      }, 32);
      return next;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
      return true;
    }
  } catch {
    // The OS or the browser can refuse; leave the window as-is.
  }
  return false;
}

export async function isFullscreen(): Promise<boolean> {
  if (isTauri()) return getCurrentWindow().isFullscreen();
  return !!document.fullscreenElement;
}

export async function toggleMaximize(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}
