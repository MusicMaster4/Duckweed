import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";

const BADGE_SIZE = 16;
const BADGE_RADIUS = 4.5;
const BADGE_OUTLINE_RADIUS = 6.25;
const BADGE_RED = [242, 104, 111] as const;
const BADGE_OUTLINE = [15, 18, 15] as const;

let requested = false;
let applied: boolean | null = null;
let overlayIcon: Promise<Image> | null = null;
let updateQueue = Promise.resolve();

/** A transparent Windows taskbar overlay containing one flat red circle. */
export function createCompletionBadgeRgba(size = BADGE_SIZE): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const scale = size / BADGE_SIZE;
  const center = (size - 1) / 2;
  const radius = BADGE_RADIUS * scale;
  const outlineRadius = BADGE_OUTLINE_RADIUS * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const outlineCoverage = Math.max(
        0,
        Math.min(1, outlineRadius + 0.5 - distance),
      );
      if (outlineCoverage === 0) continue;
      const redCoverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      const outlineContribution = outlineCoverage * (1 - redCoverage);
      const alpha = redCoverage + outlineContribution;
      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(
        (BADGE_RED[0] * redCoverage + BADGE_OUTLINE[0] * outlineContribution) /
          alpha,
      );
      rgba[offset + 1] = Math.round(
        (BADGE_RED[1] * redCoverage + BADGE_OUTLINE[1] * outlineContribution) /
          alpha,
      );
      rgba[offset + 2] = Math.round(
        (BADGE_RED[2] * redCoverage + BADGE_OUTLINE[2] * outlineContribution) /
          alpha,
      );
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }

  return rgba;
}

function isWindowsTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    navigator.userAgent.includes("Windows")
  );
}

function getOverlayIcon(): Promise<Image> {
  overlayIcon ??= Image.new(createCompletionBadgeRgba(), BADGE_SIZE, BADGE_SIZE);
  return overlayIcon;
}

async function applyRequestedBadge(): Promise<void> {
  if (applied === requested) return;
  const visible = requested;

  try {
    const win = getCurrentWindow();
    if (visible) {
      const icon = await getOverlayIcon();
      if (!requested) return;
      await win.setOverlayIcon(icon);
    } else {
      await win.setOverlayIcon();
    }
    applied = visible;
  } catch {
    // Browser previews and unsupported platforms do not have a taskbar overlay.
    applied = null;
  }
}

/**
 * Show or clear the completion marker on the Windows taskbar icon.
 * Calls are serialized so a slow first image allocation cannot restore a stale
 * badge after the app has regained focus.
 */
export function setCompletionTaskbarBadge(visible: boolean): void {
  if (!isWindowsTauri()) return;
  requested = visible;
  updateQueue = updateQueue.then(applyRequestedBadge);
}
