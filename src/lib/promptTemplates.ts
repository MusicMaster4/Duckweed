import { saveDurably } from "./durableStorage";

export const PROMPT_TEMPLATES_KEY = "duckweed:prompt-templates:v1";
const MAX_TEMPLATES = 200;
const MAX_TITLE_LENGTH = 80;
const MAX_CONTENT_LENGTH = 20_000;

export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptTemplateDraft {
  title: string;
  content: string;
}

function normalize(entry: unknown): PromptTemplate | null {
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.content !== "string"
  ) {
    return null;
  }
  const title = row.title.trim().slice(0, MAX_TITLE_LENGTH);
  const content = row.content.trim().slice(0, MAX_CONTENT_LENGTH);
  if (!title || !content) return null;
  const now = Date.now();
  return {
    id: row.id,
    title,
    content,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : now,
  };
}

function read(): PromptTemplate[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PROMPT_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: number; templates?: unknown[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.templates)) return [];
    return parsed.templates
      .map(normalize)
      .filter((entry): entry is PromptTemplate => entry !== null)
      .slice(0, MAX_TEMPLATES);
  } catch {
    return [];
  }
}

let templates = read();
const listeners = new Set<() => void>();

function write(): void {
  const raw = JSON.stringify({ version: 1, templates });
  try {
    localStorage.setItem(PROMPT_TEMPLATES_KEY, raw);
    saveDurably(PROMPT_TEMPLATES_KEY, raw);
  } catch {
    // Templates remain available for this window if persistence is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPromptTemplates(): readonly PromptTemplate[] {
  return templates;
}

export function searchPromptTemplates(query: string): PromptTemplate[] {
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (!terms.length) return [...templates];
  return templates.filter((template) => {
    const haystack = `${template.title}\n${template.content}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function makeId(): string {
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function savePromptTemplate(
  draft: PromptTemplateDraft,
  id?: string,
): PromptTemplate | null {
  const title = draft.title.trim().slice(0, MAX_TITLE_LENGTH);
  const content = draft.content.trim().slice(0, MAX_CONTENT_LENGTH);
  if (!title || !content) return null;
  const now = Date.now();
  const existing = id ? templates.find((entry) => entry.id === id) : undefined;
  const saved: PromptTemplate = {
    id: existing?.id ?? makeId(),
    title,
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  templates = existing
    ? templates.map((entry) => (entry.id === existing.id ? saved : entry))
    : [saved, ...templates].slice(0, MAX_TEMPLATES);
  write();
  return saved;
}

export function removePromptTemplate(id: string): void {
  const next = templates.filter((entry) => entry.id !== id);
  if (next.length === templates.length) return;
  templates = next;
  write();
}

export function resetPromptTemplatesForTests(next: PromptTemplate[] = []): void {
  templates = next;
  for (const listener of listeners) listener();
}
