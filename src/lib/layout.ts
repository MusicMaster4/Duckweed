import type { Dir, DropZone, LayoutNode, LeafNode } from "./types";

let counter = 0;
export function uid(prefix = "n"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function leaf(term: string): LeafNode {
  return { kind: "leaf", id: uid("p"), term };
}

const MIN_SIZE = 0.06;

export function leaves(node: LayoutNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(node: LayoutNode, id: string): LeafNode | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  for (const child of node.children) {
    const hit = findLeaf(child, id);
    if (hit) return hit;
  }
  return null;
}

function dirFor(zone: Exclude<DropZone, "center">): Dir {
  return zone === "left" || zone === "right" ? "row" : "col";
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/**
 * Insert `incoming` next to the leaf `targetId` on the given side.
 * Returns a new tree, or the original one if the target was not found.
 */
export function insertBeside(
  root: LayoutNode,
  targetId: string,
  incoming: LayoutNode,
  zone: Exclude<DropZone, "center">,
): LayoutNode {
  const dir = dirFor(zone);
  const before = zone === "left" || zone === "top";

  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "leaf") {
      if (node.id !== targetId) return null;
      return {
        kind: "split",
        id: uid("s"),
        dir,
        children: before ? [incoming, node] : [node, incoming],
        sizes: [0.5, 0.5],
      };
    }

    // Add a sibling directly when the parent already uses this axis. A
    // retained one-child parent can safely adopt either axis, which preserves
    // the existing pane's component identity when a new split opens.
    const idx = node.children.findIndex((c) => c.id === targetId);
    if (idx >= 0 && (node.dir === dir || node.children.length === 1)) {
      const at = before ? idx : idx + 1;
      const children = [...node.children];
      children.splice(at, 0, incoming);
      // Siblings of one split stay evenly sized when a pane joins them — that is
      // what makes three panes read as clean thirds instead of 1/2 + 1/4 + 1/4.
      return {
        ...node,
        dir,
        children,
        sizes: children.map(() => 1 / children.length),
      };
    }

    for (let i = 0; i < node.children.length; i++) {
      const next = walk(node.children[i]);
      if (next) {
        const children = [...node.children];
        children[i] = next;
        return { ...node, children };
      }
    }
    return null;
  };

  return walk(root) ?? root;
}

/** Remove a leaf, collapsing splits that end up with a single child. */
export function removeLeaf(root: LayoutNode, leafId: string): LayoutNode | null {
  // `undefined` = not found here, `null` = this subtree disappeared.
  const walk = (node: LayoutNode): LayoutNode | null | undefined => {
    if (node.kind === "leaf") return node.id === leafId ? null : undefined;

    for (let i = 0; i < node.children.length; i++) {
      const next = walk(node.children[i]);
      if (next === undefined) continue;

      const children = [...node.children];
      const sizes = [...node.sizes];
      if (next === null) {
        children.splice(i, 1);
        sizes.splice(i, 1);
      } else {
        children[i] = next;
      }

      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { ...node, children, sizes: normalize(sizes) };
    }
    return undefined;
  };

  const result = walk(root);
  return result === undefined ? root : result;
}

/** Remove the cell containing a leaf from a specific split after its close animation. */
export function removeLeafFromSplit(
  root: LayoutNode,
  leafId: string,
  ownerSplitId: string,
): LayoutNode | null {
  if (root.kind === "leaf") return root.id === leafId ? null : root;
  if (root.id === ownerSplitId) {
    const index = root.children.findIndex((child) => findLeaf(child, leafId));
    if (index < 0) return root;
    const children = root.children.filter((_, childIndex) => childIndex !== index);
    if (children.length === 0) return null;
    // Retain the owner around a lone survivor. Collapsing it changes the
    // pane's React parent and remounts its welcome, composer, and xterm host.
    if (children.length === 1) return { ...root, children, sizes: [1] };
    const sizes = root.sizes.filter((_, childIndex) => childIndex !== index);
    return { ...root, children, sizes: normalize(sizes) };
  }
  for (let index = 0; index < root.children.length; index += 1) {
    if (!findLeaf(root.children[index], leafId)) continue;
    const child = removeLeafFromSplit(root.children[index], leafId, ownerSplitId);
    if (!child) return root;
    const children = [...root.children];
    children[index] = child;
    return { ...root, children };
  }
  return root;
}

/** Exchange the terminals of two leaves — a "move pane here" gesture. */
export function swapLeaves(root: LayoutNode, aId: string, bId: string): LayoutNode {
  const a = findLeaf(root, aId);
  const b = findLeaf(root, bId);
  if (!a || !b || aId === bId) return root;

  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.id === aId) return { ...node, term: b.term };
      if (node.id === bId) return { ...node, term: a.term };
      return node;
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

/** Apply new fractions to the split that owns `splitId`. */
export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) return { ...node, sizes: normalize(sizes) };
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

/**
 * Move divider `index` (between children index and index+1) by `deltaFraction`,
 * keeping both neighbours above the minimum size.
 */
export function resizeSplit(base: number[], index: number, deltaFraction: number): number[] {
  const sizes = [...base];
  const a = sizes[index];
  const b = sizes[index + 1];
  const max = b - MIN_SIZE;
  const min = MIN_SIZE - a;
  const delta = Math.max(min, Math.min(max, deltaFraction));
  sizes[index] = a + delta;
  sizes[index + 1] = b - delta;
  return sizes;
}

/** Reset every split so all its children are the same size. */
export function balance(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  return {
    ...node,
    children: node.children.map(balance),
    sizes: node.children.map(() => 1 / node.children.length),
  };
}

/**
 * Which sides of a pane sit on the outer frame, as a bitmask so the value stays
 * a primitive and never breaks a memo. Panes on the frame have to round the
 * corners of their completion outline: a square 2px border gets clipped by the
 * rounded workspace and the corner reads as broken.
 */
export const EDGE_TOP = 1;
export const EDGE_RIGHT = 2;
export const EDGE_BOTTOM = 4;
export const EDGE_LEFT = 8;
export const ALL_EDGES = EDGE_TOP | EDGE_RIGHT | EDGE_BOTTOM | EDGE_LEFT;

/** Edges a split child keeps: those across the split axis, plus its outer end. */
export function edgesForChild(edges: number, dir: "row" | "col", index: number, count: number): number {
  const [across, first, last] =
    dir === "row"
      ? [EDGE_TOP | EDGE_BOTTOM, EDGE_LEFT, EDGE_RIGHT]
      : [EDGE_LEFT | EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM];
  let kept = edges & across;
  if (index === 0) kept |= edges & first;
  if (index === count - 1) kept |= edges & last;
  return kept;
}

/**
 * `border-radius` shorthand for an overlay that has to hug the rounded frame:
 * a corner is rounded only when both of its sides are on the outer frame.
 */
export function edgeRadius(edges: number): string {
  const r = (a: number, b: number) => ((edges & a) && (edges & b) ? "var(--pane-edge-radius)" : "0px");
  return [
    r(EDGE_TOP, EDGE_LEFT),
    r(EDGE_TOP, EDGE_RIGHT),
    r(EDGE_BOTTOM, EDGE_RIGHT),
    r(EDGE_BOTTOM, EDGE_LEFT),
  ].join(" ");
}

/** Depth-first leaf order, used for tab-order pane cycling. */
export function nextLeaf(root: LayoutNode, currentId: string, step: 1 | -1): string | null {
  const all = leaves(root);
  if (all.length === 0) return null;
  const idx = all.findIndex((l) => l.id === currentId);
  if (idx < 0) return all[0].id;
  const next = (idx + step + all.length) % all.length;
  return all[next].id;
}

/**
 * Pick a surviving leaf after a close or move. Prefer `preferred` in order
 * (most-recent first); fall back to depth-first order when none remain.
 */
export function preferredLeaf(root: LayoutNode, preferred: readonly string[]): string | null {
  const all = leaves(root);
  if (all.length === 0) return null;
  for (const id of preferred) {
    if (all.some((leaf) => leaf.id === id)) return id;
  }
  return all[0].id;
}

/**
 * Record a pane focus change as most-recent-first, keeping only leaves that
 * still exist in `root`. Seeds the previous active leaf when history was empty.
 */
export function touchPaneMru(
  history: readonly string[],
  nextActive: string,
  root: LayoutNode,
  previousActive?: string,
): string[] {
  const live = new Set(leaves(root).map((leaf) => leaf.id));
  let base = history.filter((id) => live.has(id) || id === nextActive);
  if (
    previousActive &&
    previousActive !== nextActive &&
    live.has(previousActive) &&
    !base.includes(previousActive)
  ) {
    base = [...base, previousActive];
  }
  return [nextActive, ...base.filter((id) => id !== nextActive)];
}
