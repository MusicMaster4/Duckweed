import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Fullscreen has to round-trip through the OS window, so the state we read back
 * is the truth. Callers get the resulting state to update their own UI.
 */
export async function toggleFullscreen(): Promise<boolean> {
  const win = getCurrentWindow();
  const next = !(await win.isFullscreen());
  await win.setFullscreen(next);
  return win.isFullscreen();
}

export async function isFullscreen(): Promise<boolean> {
  return getCurrentWindow().isFullscreen();
}

export async function toggleMaximize(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}
