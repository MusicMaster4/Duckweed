import { saveDurably } from "./durableStorage";
import { uid } from "./layout";
import type { LayoutNode, LeafNode } from "./types";

const KEY = "duckweed:layouts:v1";
const MAX_LAYOUTS = 40;
export const MAX_LAYOUT_PANES = 16;

export interface LayoutTemplateLeaf {
  kind: "leaf";
  command: string;
}

export interface LayoutTemplateSplit {
  kind: "split";
  dir: "row" | "col";
  children: LayoutTemplateNode[];
  sizes: number[];
}

export type LayoutTemplateNode = LayoutTemplateLeaf | LayoutTemplateSplit;

export interface LayoutTemplate {
  id: string;
  name: string;
  root: LayoutTemplateNode;
  createdAt: number;
  updatedAt: number;
}

export interface LayoutDraft {
  name: string;
  root: LayoutTemplateNode;
}

const leaf = (command = ""): LayoutTemplateLeaf => ({ kind: "leaf", command });

function split(
  dir: "row" | "col",
  children: LayoutTemplateNode[],
): LayoutTemplateSplit {
  return {
    kind: "split",
    dir,
    children,
    sizes: children.map(() => 1 / children.length),
  };
}

/**
 * Build the compact grids used by the template creator. Wide rows keep agent
 * swarms readable on a desktop display, while the outer column gives 4, 6,
 * and 8 panes two balanced tiers.
 */
export function gridTemplate(commands: string[]): LayoutTemplateNode {
  const clean = commands.slice(0, MAX_LAYOUT_PANES);
  if (clean.length <= 1) return leaf(clean[0] ?? "");

  const columns =
    clean.length <= 3
      ? clean.length
      : clean.length <= 4
        ? 2
        : clean.length <= 6
          ? 3
          : clean.length <= 8
            ? 4
            : clean.length === 9
              ? 3
              : 4;
  const rows: LayoutTemplateNode[] = [];
  for (let index = 0; index < clean.length; index += columns) {
    const row = clean.slice(index, index + columns).map(leaf);
    rows.push(row.length === 1 ? row[0] : split("row", row));
  }
  return rows.length === 1 ? rows[0] : split("col", rows);
}

function paneCount(node: LayoutTemplateNode): number {
  if (node.kind === "leaf") return 1;
  return node.children.reduce((total, child) => total + paneCount(child), 0);
}

export function countTemplatePanes(node: LayoutTemplateNode): number {
  return paneCount(node);
}

export function templateCommands(node: LayoutTemplateNode): string[] {
  if (node.kind === "leaf") return [node.command];
  return node.children.flatMap(templateCommands);
}

export function withTemplateCommands(
  node: LayoutTemplateNode,
  commands: string[],
): LayoutTemplateNode {
  let index = 0;
  const walk = (entry: LayoutTemplateNode): LayoutTemplateNode => {
    if (entry.kind === "leaf") {
      const command = commands[index] ?? "";
      index += 1;
      return leaf(command);
    }
    return { ...entry, children: entry.children.map(walk), sizes: [...entry.sizes] };
  };
  return walk(node);
}

export function captureLayout(
  node: LayoutNode,
  commandFor: (term: string) => string,
): LayoutTemplateNode {
  if (node.kind === "leaf") return leaf(commandFor(node.term));
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child) => captureLayout(child, commandFor)),
    sizes: [...node.sizes],
  };
}

export function instantiateLayout(
  node: LayoutTemplateNode,
  createLeaf: (command: string) => LeafNode,
): LayoutNode {
  if (node.kind === "leaf") return createLeaf(node.command);
  return {
    kind: "split",
    id: uid("s"),
    dir: node.dir,
    children: node.children.map((child) => instantiateLayout(child, createLeaf)),
    sizes: [...node.sizes],
  };
}

function isNode(value: unknown, depth = 0): value is LayoutTemplateNode {
  if (!value || typeof value !== "object" || depth > MAX_LAYOUT_PANES) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") return typeof node.command === "string";
  if (node.kind !== "split" || (node.dir !== "row" && node.dir !== "col")) return false;
  if (!Array.isArray(node.children) || node.children.length < 2) return false;
  return node.children.every((child) => isNode(child, depth + 1));
}

function normalizeNode(node: LayoutTemplateNode): LayoutTemplateNode {
  if (node.kind === "leaf") return leaf(node.command.slice(0, 1_000));
  const children = node.children.map(normalizeNode);
  const sizes =
    Array.isArray(node.sizes) &&
    node.sizes.length === children.length &&
    node.sizes.every((size) => typeof size === "number" && size > 0)
      ? [...node.sizes]
      : children.map(() => 1 / children.length);
  return { kind: "split", dir: node.dir, children, sizes };
}

function read(): { layouts: LayoutTemplate[]; defaultLayoutId: string | null } {
  if (typeof localStorage === "undefined") return { layouts: [], defaultLayoutId: null };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { layouts: [], defaultLayoutId: null };
    const parsed = JSON.parse(raw) as {
      version?: number;
      layouts?: unknown[];
      defaultLayoutId?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.layouts)) {
      return { layouts: [], defaultLayoutId: null };
    }
    const nextLayouts = parsed.layouts
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .filter(
        (entry) =>
          typeof entry.id === "string" &&
          typeof entry.name === "string" &&
          isNode(entry.root) &&
          paneCount(entry.root) <= MAX_LAYOUT_PANES,
      )
      .slice(0, MAX_LAYOUTS)
      .map((entry) => ({
        id: entry.id as string,
        name: (entry.name as string).slice(0, 60),
        root: normalizeNode(entry.root as LayoutTemplateNode),
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      }));
    const requestedDefault =
      typeof parsed.defaultLayoutId === "string" ? parsed.defaultLayoutId : null;
    return {
      layouts: nextLayouts,
      defaultLayoutId: nextLayouts.some((entry) => entry.id === requestedDefault)
        ? requestedDefault
        : null,
    };
  } catch {
    return { layouts: [], defaultLayoutId: null };
  }
}

const stored = read();
let layouts = stored.layouts;
let defaultLayoutId = stored.defaultLayoutId;
const listeners = new Set<() => void>();

function write(): void {
  const raw = JSON.stringify({ version: 1, layouts, defaultLayoutId });
  try {
    localStorage.setItem(KEY, raw);
    saveDurably(KEY, raw);
  } catch {
    // A saved layout is a convenience. Storage failures must not block a tab.
  }
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLayouts(): readonly LayoutTemplate[] {
  return layouts;
}

export function getDefaultLayoutId(): string | null {
  return defaultLayoutId;
}

export function getDefaultLayout(): LayoutTemplate | null {
  return layouts.find((entry) => entry.id === defaultLayoutId) ?? null;
}

export function setDefaultLayout(id: string | null): void {
  const next = id && layouts.some((entry) => entry.id === id) ? id : null;
  if (next === defaultLayoutId) return;
  defaultLayoutId = next;
  write();
}

function makeId(): string {
  return `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function saveLayout(draft: LayoutDraft, id?: string): LayoutTemplate | null {
  const name = draft.name.trim().slice(0, 60);
  if (!name || !isNode(draft.root) || paneCount(draft.root) > MAX_LAYOUT_PANES) return null;
  const timestamp = Date.now();
  const existing = id ? layouts.find((entry) => entry.id === id) : undefined;
  const saved: LayoutTemplate = {
    id: existing?.id ?? makeId(),
    name,
    root: normalizeNode(draft.root),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  layouts = existing
    ? layouts.map((entry) => (entry.id === existing.id ? saved : entry))
    : [saved, ...layouts].slice(0, MAX_LAYOUTS);
  write();
  return saved;
}

export function removeLayout(id: string): void {
  const next = layouts.filter((entry) => entry.id !== id);
  if (next.length === layouts.length) return;
  layouts = next;
  if (defaultLayoutId === id) defaultLayoutId = null;
  write();
}

export function resetLayoutsForTests(
  next: LayoutTemplate[] = [],
  nextDefaultLayoutId: string | null = null,
): void {
  layouts = next;
  defaultLayoutId = next.some((entry) => entry.id === nextDefaultLayoutId)
    ? nextDefaultLayoutId
    : null;
  for (const listener of listeners) listener();
}
