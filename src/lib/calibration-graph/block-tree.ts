import type { GraphNode } from "./types";
import type { Indexed, TreeNode } from "./graph";
import { blockChain } from "./diagram-model";

/**
 * The blocks as a tree, alongside the parameter tree.
 *
 * A parameter tree answers "what touches this number". It cannot answer "what
 * does the ignition path actually do, in order", because a parameter is a leaf
 * of that path rather than a step in it. So the blocks get their own tree, over
 * the two relations that mean something between blocks:
 *
 *   signal  - this block writes a quantity that block reads (the data flow,
 *             the same relation the diagram draws)
 *   call    - this block calls that one (the control flow)
 *
 * Both are built into the same `TreeNode` shape the parameter tree renders, so
 * one component draws all three tabs and they behave identically.
 */

export type BlockTreeKind = "signal" | "call";

export interface BlockTreeOptions {
  kind: BlockTreeKind;
  direction: "downstream" | "upstream";
  maxDepth: number;
  maxChildren: number;
}

/** The blocks one step from `id`, with the signal that connects them. */
function neighbours(
  g: Indexed,
  id: string,
  opts: BlockTreeOptions,
): { node: GraphNode; via?: string }[] {
  const node = g.byId.get(id);
  if (!node) return [];
  const out: { node: GraphNode; via?: string }[] = [];
  const seen = new Set<string>();

  if (opts.kind === "call") {
    const edges = opts.direction === "downstream" ? g.out.get(id) : g.in.get(id);
    for (const e of edges ?? []) {
      if (e.k !== "call" || e.o === "fr") continue;
      const other = g.byId.get(opts.direction === "downstream" ? e.d : e.s);
      if (other?.t !== "func" || seen.has(other.id)) continue;
      seen.add(other.id);
      out.push({ node: other });
    }
    return out;
  }

  // Signal flow: downstream is "who reads what I write", upstream the mirror.
  const chain = blockChain(g);
  const mine = opts.direction === "downstream" ? chain.writtenBy : chain.readBy;
  const theirs = opts.direction === "downstream" ? chain.readers : chain.writers;
  for (const signal of mine.get(id) ?? []) {
    for (const otherId of theirs.get(signal) ?? []) {
      if (otherId === id || seen.has(otherId)) continue;
      const other = g.byId.get(otherId);
      if (!other) continue;
      seen.add(otherId);
      out.push({ node: other, via: signal });
    }
  }
  return out;
}

/**
 * Expand the block graph breadth-first into a tree.
 *
 * Breadth-first for the same reason the parameter tree is: a block reachable by
 * several paths is expanded at its shallowest occurrence, so the branch the
 * reader is looking at is the one that carries the detail.
 */
export function expandBlocks(
  g: Indexed,
  rootId: string,
  opts: BlockTreeOptions,
): TreeNode | null {
  const root = g.byId.get(rootId);
  if (!root || root.t !== "func") return null;

  const seen = new Set<string>([rootId]);
  const make = (node: GraphNode, depth: number, repeated = false): TreeNode => ({
    node,
    depth,
    children: [],
    repeated,
    truncated: false,
  });

  const rootNode = make(root, 0);
  let frontier: { tree: TreeNode; id: string }[] = [{ tree: rootNode, id: rootId }];

  for (let depth = 1; depth <= opts.maxDepth && frontier.length; depth++) {
    const next: { tree: TreeNode; id: string }[] = [];
    for (const { tree, id } of frontier) {
      const found = neighbours(g, id, opts);
      // Blocks that compute with calibration first: they are the ones a tuner
      // is looking for, and a long list of stubs would bury them.
      found.sort((a, b) => score(b.node) - score(a.node));
      const shown = found.slice(0, opts.maxChildren);
      tree.truncated = found.length > shown.length;
      for (const { node, via } of shown) {
        const repeated = seen.has(node.id);
        const child = make(node, depth, repeated);
        if (via) child.via = via;
        tree.children.push(child);
        if (!repeated) {
          seen.add(node.id);
          next.push({ tree: child, id: node.id });
        }
      }
    }
    frontier = next;
  }
  return rootNode;
}

function score(node: GraphNode): number {
  const stmts = node.stmts ?? [];
  let s = node.named ? 3 : 0;
  for (const st of stmts) {
    if (st.interp.length) s += 10;
    else if (/\b(KF_|KL_|K_)[A-Z0-9_]+/i.test(st.expr)) s += 4;
  }
  return s + Math.min(stmts.length, 5);
}

/** The block a parameter or signal belongs to, for opening the block tree. */
export function owningBlock(g: Indexed, node: GraphNode): GraphNode | null {
  if (node.t === "func") return node;
  const candidates = new Set<string>();
  for (const e of g.in.get(node.id) ?? []) {
    if (e.o !== "fr" && g.byId.get(e.s)?.t === "func") candidates.add(e.s);
  }
  for (const e of g.out.get(node.id) ?? []) {
    if (e.o !== "fr" && g.byId.get(e.d)?.t === "func") candidates.add(e.d);
  }
  const best = [...candidates]
    .map((id) => g.byId.get(id)!)
    .sort((a, b) => score(b) - score(a))[0];
  return best ?? null;
}
