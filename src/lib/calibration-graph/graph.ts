import type { EdgeOrigin, Graph, GraphEdge, GraphNode } from "./types";

export interface Indexed {
  raw: Graph;
  byId: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  categoryMembers: Map<number, GraphNode[]>;
  params: GraphNode[];
}

export function index(raw: Graph): Indexed {
  const byId = new Map<string, GraphNode>();
  for (const n of raw.nodes) byId.set(n.id, n);

  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  const push = (map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge) => {
    const list = map.get(key);
    if (list) list.push(edge);
    else map.set(key, [edge]);
  };
  for (const e of raw.edges) {
    push(out, e.s, e);
    push(inc, e.d, e);
  }

  const params = raw.nodes.filter((n) => n.t === "param");
  const categoryMembers = new Map<number, GraphNode[]>();
  for (const p of params) {
    for (const c of p.cats ?? []) {
      const list = categoryMembers.get(c) ?? [];
      list.push(p);
      categoryMembers.set(c, list);
    }
  }
  for (const list of categoryMembers.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { raw, byId, out, in: inc, categoryMembers, params };
}

/**
 * Direction of the relation tree.
 *
 * `downstream` answers "if I change this, what else is affected": follow reads
 * of a parameter to the functions that consume it, then the RAM those
 * functions write, then the functions that read that RAM.
 *
 * `upstream` answers "what determines this value": follow writes backwards.
 *
 * Only Ghidra edges carry a direction.  Funktionsrahmen edges say that two
 * things are documented on the same page and nothing more, so they are
 * traversed both ways and labelled as such.
 */
export type Direction = "downstream" | "upstream";

export interface TreeNode {
  node: GraphNode;
  edge?: GraphEdge;
  /** The signal this block shares with its parent, in the block tree. */
  via?: string;
  depth: number;
  children: TreeNode[];
  repeated: boolean;
  truncated: boolean;
}

export interface ExpandOptions {
  direction: Direction;
  origins: Set<EdgeOrigin>;
  maxDepth: number;
  maxChildren: number;
  includeDensePages: boolean;
}

function step(
  g: Indexed,
  id: string,
  opts: ExpandOptions,
): { edge: GraphEdge; next: string }[] {
  const results: { edge: GraphEdge; next: string }[] = [];

  const consider = (edge: GraphEdge, next: string) => {
    if (!opts.origins.has(edge.o)) return;
    const target = g.byId.get(next);
    if (!target) return;
    if (target.t === "frpage" && target.dense && !opts.includeDensePages) return;
    results.push({ edge, next });
  };

  // Funktionsrahmen adjacency is undirected: a page groups names, it does not
  // order them.  Both stored directions are followed regardless of `direction`.
  for (const e of g.out.get(id) ?? []) {
    if (e.o === "fr") consider(e, e.d);
  }

  for (const e of g.out.get(id) ?? []) {
    if (e.o === "fr") continue;
    // Leaving a node forwards: reads/calls flow downstream, writes flow up.
    if (opts.direction === "downstream" ? e.k !== "write" : e.k === "write") {
      consider(e, e.d);
    }
  }
  for (const e of g.in.get(id) ?? []) {
    if (e.o === "fr") continue;
    // Arriving at a node: a function that reads it is downstream of it.
    if (opts.direction === "downstream" ? e.k === "read" : e.k !== "read") {
      consider(e, e.s);
    }
  }
  return results;
}

export function expand(g: Indexed, rootId: string, opts: ExpandOptions): TreeNode | null {
  const root = g.byId.get(rootId);
  if (!root) return null;

  // Expansion is breadth-first on purpose.  A node reachable by several paths
  // is only expanded once, and depth-first would hand that expansion to
  // whichever path happened to be walked first - often a deep one - leaving a
  // dead "(already shown)" stub in a shallower branch where the reader was
  // looking.  Breadth-first always expands at the shallowest occurrence.
  const seen = new Set<string>([rootId]);

  const make = (id: string, depth: number, edge?: GraphEdge, repeated = false): TreeNode => ({
    node: g.byId.get(id)!,
    edge,
    depth,
    children: [],
    repeated,
    truncated: false,
  });

  const rootNode = make(rootId, 0);
  const queue: TreeNode[] = [rootNode];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.repeated || current.depth >= opts.maxDepth) continue;

    const candidates = step(g, current.node.id, opts);
    // Stable, useful order: measured references first, then documentation.
    candidates.sort((a, b) => {
      const rank = (o: EdgeOrigin) => (o === "xref" ? 0 : o === "scan" ? 1 : 2);
      return rank(a.edge.o) - rank(b.edge.o) || a.next.localeCompare(b.next);
    });

    const emitted = new Set<string>();
    for (const c of candidates) {
      if (emitted.has(c.next)) continue;
      emitted.add(c.next);
      if (current.children.length >= opts.maxChildren) {
        current.truncated = true;
        break;
      }
      if (seen.has(c.next)) {
        current.children.push(make(c.next, current.depth + 1, c.edge, true));
        continue;
      }
      seen.add(c.next);
      const child = make(c.next, current.depth + 1, c.edge);
      current.children.push(child);
      queue.push(child);
    }
  }

  return rootNode;
}

/** Nodes joined to `id` by both a measured reference and the documentation. */
export function agreement(g: Indexed, id: string): Map<string, Set<EdgeOrigin>> {
  const origins = new Map<string, Set<EdgeOrigin>>();
  const note = (other: string, o: EdgeOrigin) => {
    const set = origins.get(other) ?? new Set<EdgeOrigin>();
    set.add(o);
    origins.set(other, set);
  };
  for (const e of g.out.get(id) ?? []) note(e.d, e.o);
  for (const e of g.in.get(id) ?? []) note(e.s, e.o);
  return origins;
}

export function searchNodes(g: Indexed, query: string, limit = 60): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: GraphNode[] = [];
  const prefix: GraphNode[] = [];
  const substr: GraphNode[] = [];
  for (const n of g.raw.nodes) {
    if (n.t === "frpage") continue;
    const name = n.name.toLowerCase();
    if (name === q) exact.push(n);
    else if (name.startsWith(q)) prefix.push(n);
    else if (name.includes(q)) substr.push(n);
    else if (n.desc?.en?.toLowerCase().includes(q) || n.desc?.ja?.includes(query)) {
      substr.push(n);
    }
    if (exact.length + prefix.length + substr.length > limit * 4) break;
  }
  const rank = (n: GraphNode) => (n.t === "param" ? 0 : n.t === "func" ? 1 : 2);
  return [...exact, ...prefix, ...substr]
    .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
    .slice(0, limit);
}
