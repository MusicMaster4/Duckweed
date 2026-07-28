import { workspacePaths } from "./ipc";
import type { AgentImageAttachment } from "./agents/types";
import type { WorkspacePath } from "./types";

export const MAX_PROMPT_IMAGES = 10;
export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_THUMBNAIL_EDGE = 320;

const IMAGE_MIMES = new Set<AgentImageAttachment["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const PATH_INDEX_TTL_MS = 15_000;
const pathIndex = new Map<string, { loadedAt: number; pending: Promise<WorkspacePath[]> }>();

function attachmentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mimeFromFile(file: File): AgentImageAttachment["mimeType"] | null {
  const reported = file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();
  if (IMAGE_MIMES.has(reported as AgentImageAttachment["mimeType"])) {
    return reported as AgentImageAttachment["mimeType"];
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return null;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read this image."));
    reader.onerror = () => reject(new Error("Could not read this image."));
    reader.readAsDataURL(file);
  });
}

/**
 * Build a small display-only image without replacing the original payload.
 * Any decoding failure falls back to displaying the original data URL.
 */
async function createImageThumbnail(file: File): Promise<string | undefined> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return undefined;
  }
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(
      1,
      MAX_IMAGE_THUMBNAIL_EDGE / bitmap.width,
      MAX_IMAGE_THUMBNAIL_EDGE / bitmap.height,
    );
    if (scale >= 1) return undefined;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.82);
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}

/** Validate and turn a browser clipboard image into a durable in-memory attachment. */
export async function imageFileToAttachment(file: File): Promise<AgentImageAttachment> {
  const mimeType = mimeFromFile(file);
  if (!mimeType) {
    throw new Error("Only PNG, JPEG, GIF, and WebP images are supported.");
  }
  if (file.size > MAX_PROMPT_IMAGE_BYTES) {
    throw new Error("Images must be 5 MB or smaller.");
  }
  const [dataUrl, thumbnailDataUrl] = await Promise.all([
    readDataUrl(file),
    createImageThumbnail(file),
  ]);
  return {
    id: attachmentId(),
    name: file.name || `pasted-image.${mimeType.split("/")[1]}`,
    mimeType,
    dataUrl,
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
    size: file.size,
  };
}

/** Read image blobs through the async clipboard API, used by Alt+V. */
export async function clipboardImageFiles(): Promise<File[]> {
  if (!navigator.clipboard?.read) {
    throw new Error("Image clipboard access is unavailable. Use Ctrl+V instead.");
  }
  const items = await navigator.clipboard.read();
  const files: File[] = [];
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1] || "png";
    files.push(new File([blob], `pasted-image.${extension}`, { type }));
  }
  return files;
}

export interface FileMention {
  /** Index of the `@` that begins the live token. */
  start: number;
  /** Caret position, used as the replacement end. */
  end: number;
  query: string;
}

/** Find the `@query` token immediately before the caret. */
export function activeFileMention(value: string, cursor: number): FileMention | null {
  const before = value.slice(0, cursor);
  const match = /(^|\s)@([^\s@"']*)$/.exec(before);
  if (!match) return null;
  const start = cursor - match[2].length - 1;
  return { start, end: cursor, query: match[2] };
}

function subsequenceScore(candidate: string, query: string): number | null {
  let at = 0;
  let gaps = 0;
  for (const char of query) {
    const found = candidate.indexOf(char, at);
    if (found < 0) return null;
    gaps += found - at;
    at = found + 1;
  }
  return gaps;
}

function fileScore(file: WorkspacePath, rawQuery: string): number | null {
  const query = rawQuery.trim().toLowerCase();
  const name = file.name.toLowerCase();
  const relative = file.relative.toLowerCase();
  if (!query) return relative.split("/").length * 2 + Math.min(relative.length, 80) / 80;
  if (name === query) return 0;
  if (name.replace(/\.[^.]+$/, "") === query) return 1;
  if (name.startsWith(query)) return 5 + (name.length - query.length) / 100;
  const nameAt = name.indexOf(query);
  if (nameAt >= 0) return 15 + nameAt;
  const relativeAt = relative.indexOf(query);
  if (relativeAt >= 0) return 35 + relativeAt / 10;
  const fuzzy = subsequenceScore(relative, query);
  return fuzzy === null ? null : 80 + fuzzy;
}

/** Rank paths the way coding CLIs do: file-name hits before deep path matches. */
export function searchWorkspaceIndex(
  files: WorkspacePath[],
  query: string,
  limit = 12,
): WorkspacePath[] {
  return files
    .map((file) => ({ file, score: fileScore(file, query) }))
    .filter((entry): entry is { file: WorkspacePath; score: number } => entry.score !== null)
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.file.relative.length - b.file.relative.length ||
        a.file.relative.localeCompare(b.file.relative),
    )
    .slice(0, limit)
    .map((entry) => entry.file);
}

/** Cache briefly per working directory so newly created files appear without re-indexing each key. */
export function loadWorkspaceIndex(cwd: string): Promise<WorkspacePath[]> {
  const now = Date.now();
  const cached = pathIndex.get(cwd);
  if (cached && now - cached.loadedAt < PATH_INDEX_TTL_MS) {
    return cached.pending;
  }
  const pending = workspacePaths(cwd).catch(() => []);
  pathIndex.set(cwd, { loadedAt: now, pending });
  return pending;
}

export function mentionText(relative: string): string {
  const normalized = relative.replace(/\\/g, "/");
  return /\s/.test(normalized)
    ? `@"${normalized.replace(/"/g, '\\"')}"`
    : `@${normalized}`;
}

export function replaceMention(
  value: string,
  mention: FileMention,
  relative: string,
): { value: string; cursor: number } {
  const inserted = `${mentionText(relative)} `;
  const next = value.slice(0, mention.start) + inserted + value.slice(mention.end);
  return { value: next, cursor: mention.start + inserted.length };
}

export function formatDroppedPaths(paths: string[]): string {
  return paths
    .map((path) => (/\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path))
    .join(" ");
}

/** Insert dropped paths or clipboard text without trampling the current selection. */
export function insertComposerText(
  value: string,
  start: number,
  end: number,
  inserted: string,
): { value: string; cursor: number } {
  const left = value.slice(0, start);
  const right = value.slice(end);
  const before = left && !/\s$/.test(left) ? " " : "";
  const after = right && !/^\s/.test(right) ? " " : "";
  const text = `${before}${inserted}${after}`;
  return {
    value: left + text + right,
    cursor: left.length + text.length - after.length,
  };
}
