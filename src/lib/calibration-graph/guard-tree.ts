import type { GuardPart } from "./logic-format";

/**
 * The `if` nesting, reconstructed once.
 *
 * A recovered statement carries `guards` — a conjunction of conditions that
 * were true when it ran — and nothing about block structure. The nesting every
 * view draws is inferred from those, by grouping consecutive statements that
 * share a leading condition. Sharing the FIRST condition rather than the whole
 * list is what keeps a branch whole: `rf_soll_calc` guards four consecutive
 * statements on `AVAN1_SOLL_FAKTOR != 0` and one of the four carries a second
 * condition as well, so matching whole condition lists would break one branch
 * into three.
 *
 * This lived twice — in `placeLines` for the picture and in `emitBlock` for the
 * listing — in two copies that happened to agree. They cannot be allowed to
 * drift: the day they do, two views assert different shapes for the same code
 * and nothing catches it. So the inference is made here, once, and every view
 * walks the result.
 *
 * What it deliberately does NOT reconstruct: `else`, loops, and `goto`. Over
 * the 1,384 blocks this produces 8,553 top-level groups, and 956 of them carry a
 * condition containing `&&` or `||` — where flipping one comparator is not a
 * negation, so a group cannot be read as the `else` of the one before it. Two
 * `if`s say less than an `else` and nothing that is untrue.
 *
 * (The earlier form of this comment said "146 of 1,957", with 802 `&&` and 432
 * `||`. Those were measured on the raw guard STRINGS, not on this function's
 * top-level groups, and do not reproduce against it. Numbers in these comments
 * are load-bearing; a number that cannot be re-measured from the thing it
 * describes is worse than no number.)
 */
export type GuardNode =
  /** A statement, by its index in the list this tree was built from. */
  | { kind: "row"; row: number }
  /** A condition, and the rows it governs. */
  | { kind: "branch"; guard: GuardPart; depth: number; body: GuardNode[] };

/** All this needs of a line is its conditions, outermost first. */
export interface Guarded {
  guardParts?: GuardPart[];
}

export function guardTree(lines: readonly Guarded[]): GuardNode[] {
  const build = (lo: number, hi: number, depth: number): GuardNode[] => {
    const out: GuardNode[] = [];
    let i = lo;
    while (i < hi) {
      const parts = lines[i].guardParts ?? [];
      if (parts.length <= depth) {
        out.push({ kind: "row", row: i });
        i += 1;
        continue;
      }
      // Grouped on the RAW text, so the run survives the PLAIN toggle and
      // matches two statements that came out of the same `if`.
      const guard = parts[depth];
      let j = i + 1;
      while (j < hi) {
        const next = lines[j].guardParts ?? [];
        if (next.length <= depth || next[depth].raw !== guard.raw) break;
        j += 1;
      }
      out.push({ kind: "branch", guard, depth, body: build(i, j, depth + 1) });
      i = j;
    }
    return out;
  };
  return build(0, lines.length, 0);
}

/** How many branches the tree has, at every level. */
export function branchCount(tree: readonly GuardNode[]): number {
  let n = 0;
  for (const node of tree) {
    if (node.kind !== "branch") continue;
    n += 1 + branchCount(node.body);
  }
  return n;
}

/** How deep the nesting goes. Zero for a function with no branch at all. */
export function maxNesting(tree: readonly GuardNode[]): number {
  let d = 0;
  for (const node of tree) {
    if (node.kind !== "branch") continue;
    d = Math.max(d, 1 + maxNesting(node.body));
  }
  return d;
}

/** Every row under a node, in source order. */
export function rowsUnder(node: GuardNode): number[] {
  if (node.kind === "row") return [node.row];
  return node.body.flatMap(rowsUnder);
}
