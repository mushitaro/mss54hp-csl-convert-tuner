import type { GraphNode } from "./types";
import { type FormatContext, type FormattedLine, formatStatement } from "./logic-format";
import { type RowLink, rowLinks } from "./diagram-model";
import { type GuardNode, branchCount, guardTree, maxNesting, rowsUnder } from "./guard-tree";
import { type Token, outToken, tokenize } from "./expr-tokens";
import { CHAR_W, cells, clipCells, textWidth } from "./metrics";
import { displayName } from "./names";

/**
 * Inside one function.
 *
 * The picture next door draws the network BETWEEN functions, which is the thing
 * Ghidra has no view of. This is the other half, and it is the half Ghidra does
 * have: its Function Graph shows one function as connected basic blocks.
 *
 * We cannot draw that graph. A recovered statement carries `out`, `expr`,
 * `guards`, `reads`, `calls` and `interp` — no branch targets, no addresses, no
 * back edges. So there is no control-flow graph to recover, and drawing boxes
 * with arrows between them and calling it one would be the most convincing lie
 * this tool could tell.
 *
 * What there IS, in two readings, and the reader picks which:
 *
 * `flow` — the DATA flow. Each statement is a box; a line runs from the row
 *   that computes a quantity to every row that reads it. This is `rowLinks`,
 *   the same relation the picture squeezes into a 5px gutter beside a formula,
 *   given a whole canvas. Columns are dependency depth, laid out right to left
 *   so it reads the same direction as everything else here. Measured over the
 *   artifact: median 6 statements / 1 link / 2 levels, p90 23 / 21 / 6, worst
 *   `tog_calc` at 189 / 997 / 32.
 *
 * `branches` — the CONTROL shape, as far as it is recoverable: `guardTree`'s
 *   nesting, drawn as frames, top to bottom. 6,204 branch groups over 1,384
 *   blocks, median 2 per function, deepest 9. 396 of the 1,384 have no branch at
 *   all, and that is a fact about the function, said plainly, not a failure.
 *
 * Neither mode invents anything the other denies: both are built from the same
 * `formatStatement` lines, the same `guardTree`, and the same `rowLinks` the
 * picture and the listing use.
 */
export type InsideMode = "flow" | "branches";

/** One statement, as a box. */
export interface InsideRow {
  /** Index of the statement in the block: the number the listing shows too. */
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Baseline of the formula, in box-local pixels. */
  formulaY: number;
  /** Baseline of the reading under it, when there is one. */
  glossY: number | null;
  gloss?: string;
  glossFull?: string;
  out: Token;
  /** Where the expression starts, in monospace cells from the box's text edge. */
  exprStart: number;
  tokens: Token[];
  /** The decompiler's own wording, for checking the rewrite against. */
  raw: string;
  /**
   * The conditions governing this row, outermost first.
   *
   * Drawn on the box in `flow`, where a branch's rows are scattered across
   * columns by their dependencies and no frame could enclose them without
   * enclosing half the function as well. In `branches` they are the frames, and
   * repeating them on the box would be the same words twice.
   */
  guards: { text: string; raw: string }[];
  /** Dependency depth in `flow`; nesting depth in `branches`. */
  level: number;
}

/** A condition, as a frame around what it governs. `branches` only. */
export interface InsideFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  raw: string;
  depth: number;
  /** Statements inside it, so a frame can say how much it holds. */
  rows: number;
}

/** One row handing a value to another. */
export interface InsideEdge {
  d: string;
  name: string;
  kind: RowLink["kind"];
  from: number;
  to: number;
}

export interface Inside {
  mode: InsideMode;
  block: {
    id: string;
    label: string;
    bank?: string;
    addr?: number;
    statements: number;
  };
  rows: InsideRow[];
  frames: InsideFrame[];
  edges: InsideEdge[];
  width: number;
  height: number;
  /** Branch groups found, at every level, and how deep they nest. */
  branches: number;
  nesting: number;
  /** Statements folded away as plumbing, reported not dropped. */
  hiddenNoise: number;
}

const PAD = 9;
const LINE_H = 20;
const GLOSS_STEP = 17;
const GUARD_STEP = 15;
const COL_GAP = 46;
const ROW_GAP = 14;
const FRAME_PAD = 10;
const FRAME_HEAD = 19;
const MAX_CELLS = 68;

/** A box's own size, once its text is known. */
function measure(l: FormattedLine, showGuards: boolean): { w: number; h: number; formulaY: number; glossY: number | null } {
  const guards = showGuards ? (l.guardParts?.length ?? 0) : 0;
  const formulaY = PAD + guards * GUARD_STEP + LINE_H - 5;
  const glossY = l.gloss ? formulaY + GLOSS_STEP : null;
  const widest = Math.max(
    textWidth(`${l.out} = ${l.shown ?? l.expr}`),
    l.gloss ? textWidth(l.gloss) : 0,
    ...(showGuards ? (l.guardParts ?? []).map((p) => textWidth(`if (${p.bare})`)) : [0]),
  );
  return { w: widest + PAD * 2, h: (glossY ?? formulaY) + PAD + 3, formulaY, glossY };
}

/** Clip every drawn string once, so the box is measured on what is drawn. */
function clip(l: FormattedLine): FormattedLine {
  const out = clipCells(l.out, Math.max(12, Math.floor(MAX_CELLS * 0.6)));
  return {
    ...l,
    out,
    shown: clipCells(l.expr, Math.max(10, MAX_CELLS - cells(out) - 3)),
    guardParts: l.guardParts?.map((p) => ({ ...p, bare: clipCells(p.bare, MAX_CELLS - 5) })),
    gloss: l.gloss ? clipCells(l.gloss, MAX_CELLS - 2) : undefined,
  };
}

function box(l: FormattedLine, row: number, level: number, showGuards: boolean): InsideRow {
  const { w, h, formulaY, glossY } = measure(l, showGuards);
  return {
    row,
    x: 0,
    y: 0,
    w,
    h,
    formulaY,
    glossY,
    gloss: l.gloss,
    glossFull: l.glossFull,
    out: outToken(l.out, l.notes),
    exprStart: cells(l.out) + 3,
    tokens: tokenize(l.shown ?? l.expr, l.notes),
    raw: l.raw,
    guards: showGuards ? (l.guardParts ?? []).map((p) => ({ text: p.bare, raw: p.raw })) : [],
    level,
  };
}

export function buildInside(
  node: GraphNode,
  ctx: FormatContext,
  opts: { mode: InsideMode; showNoise?: boolean },
): Inside {
  const all = (node.stmts ?? []).map((st, i) => ({ line: formatStatement(st, ctx), i }));
  // Plumbing folded by default, as everywhere else. Folding it changes which
  // statements exist, so the links are computed on what is left rather than
  // filtered afterwards — a rail to a row that is not drawn points at nothing.
  const usable = opts.showNoise ? all : all.filter((r) => !r.line.noise);
  // Two copies on purpose. The relations are found on the FULL text: a box here
  // is joined to a box, not to a word inside one, so a name the display had to
  // cut is still a hand-off that happened. Reading them off the clipped copy
  // lost 54 of them — the width of a box deciding what the code does.
  const full = usable.map((r) => r.line);
  const lines = usable.map((r) => clip(r.line));
  const tree = guardTree(full);

  const meta = {
    id: node.id,
    label: displayName(node.name, "func"),
    bank: node.bank,
    addr: node.addr,
    statements: (node.stmts ?? []).length,
  };
  const shell = {
    mode: opts.mode,
    block: meta,
    branches: branchCount(tree),
    nesting: maxNesting(tree),
    hiddenNoise: all.length - usable.length,
  };

  if (!lines.length) {
    return { ...shell, rows: [], frames: [], edges: [], width: 240, height: 60 };
  }

  return opts.mode === "flow"
    ? { ...shell, ...flow(lines, full, usable.map((r) => r.i)) }
    : { ...shell, ...branches(lines, usable.map((r) => r.i), tree) };
}

/**
 * The data flow: columns are dependency depth, right to left.
 *
 * A row's level is the longest chain of hand-offs that reaches it, so a row
 * sits to the left of everything it depends on and no line ever runs backwards.
 * Longest rather than shortest because a box has to clear ALL of its inputs;
 * with shortest, a row fed by both a level-0 and a level-5 statement would be
 * drawn at level 1, to the RIGHT of one of the two things it reads.
 */
function flow(lines: FormattedLine[], full: FormattedLine[], srcOf: number[]) {
  // Every link, not the ten lanes a gutter can afford: here the links ARE the
  // view, and a budget meant for a 5px column beside a formula would silently
  // delete the thing the reader opened this to see.
  const { links } = rowLinks(full, Infinity);

  const level = new Array(lines.length).fill(0);
  // In ascending order of SOURCE row, which `rowLinks` does not return them in
  // — it emits every write chain and then every fan-out. A link whose source
  // had not been levelled yet contributed `0 + 1`, so a row could end up at the
  // same level as something it reads and be drawn beside it instead of to its
  // left. Every link runs forwards in source order, so once they are sorted one
  // pass settles it: whatever feeds row j is final before j is reached.
  for (const l of [...links].sort((a, b) => a.from - b.from)) {
    for (const t of l.targets) {
      if (level[t.row] < level[l.from] + 1) level[t.row] = level[l.from] + 1;
    }
  }

  const rows = lines.map((l, i) => box(l, srcOf[i], level[i], true));

  // Columns: the deepest level is leftmost, so values arrive from the right.
  const byLevel = new Map<number, InsideRow[]>();
  for (const r of rows) {
    const list = byLevel.get(r.level);
    if (list) list.push(r);
    else byLevel.set(r.level, [r]);
  }
  const levels = [...byLevel.keys()].sort((a, b) => b - a);
  const colW = new Map<number, number>();
  const colH = new Map<number, number>();
  for (const L of levels) {
    const list = byLevel.get(L)!;
    colW.set(L, Math.max(...list.map((r) => r.w)));
    colH.set(L, list.reduce((a, r) => a + r.h, 0) + (list.length - 1) * ROW_GAP);
  }
  const height = Math.max(...colH.values()) + PAD * 2;

  let x = PAD;
  for (const L of levels) {
    const list = byLevel.get(L)!;
    let y = (height - colH.get(L)!) / 2;
    for (const r of list) {
      // Aligned to the RIGHT of the column: every box's incoming edge meets its
      // right border, so aligning that border puts the arrivals on one line.
      r.x = x + colW.get(L)! - r.w;
      r.y = y;
      y += r.h + ROW_GAP;
    }
    x += colW.get(L)! + COL_GAP;
  }
  const width = x - COL_GAP + PAD;

  const at = new Map(rows.map((r, i) => [i, r]));
  const edges: InsideEdge[] = [];
  for (const l of links) {
    const a = at.get(l.from);
    if (!a) continue;
    for (const t of l.targets) {
      const b = at.get(t.row);
      if (!b) continue;
      // Out of the producer's left border, across, into the consumer's right.
      const x1 = a.x;
      const y1 = a.y + a.h / 2;
      const x2 = b.x + b.w;
      const y2 = b.y + b.h / 2;
      const mid = x1 + (x2 - x1) / 2;
      edges.push({
        d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
        name: l.name,
        kind: l.kind,
        from: a.row,
        to: b.row,
      });
    }
  }

  return { rows, frames: [] as InsideFrame[], edges, width, height };
}

/**
 * The control shape: `guardTree`'s nesting, as frames, top to bottom.
 *
 * No edges. There is nothing honest to draw between two consecutive frames —
 * whether the second runs when the first did not is exactly the `else` the
 * recovered guards cannot tell us — so the reading is the containment and
 * nothing more.
 */
function branches(lines: FormattedLine[], srcOf: number[], tree: readonly GuardNode[]) {
  const rows: InsideRow[] = [];
  const frames: InsideFrame[] = [];
  let widest = 0;
  let y = PAD;

  const walk = (nodes: readonly GuardNode[], depth: number, x: number): void => {
    for (const node of nodes) {
      if (node.kind === "row") {
        // The conditions are the frames around this box; printing them on it
        // as well would be the same words twice on one screen.
        const r = box(lines[node.row], srcOf[node.row], depth, false);
        r.x = x;
        r.y = y;
        rows.push(r);
        widest = Math.max(widest, x + r.w);
        y += r.h + ROW_GAP;
        continue;
      }
      const top = y;
      y += FRAME_HEAD;
      walk(node.body, depth + 1, x + FRAME_PAD);
      const frame: InsideFrame = {
        x,
        y: top,
        w: 0,
        h: y - top - ROW_GAP + FRAME_PAD,
        text: node.guard.bare,
        raw: node.guard.raw,
        depth,
        rows: rowsUnder(node).length,
      };
      frames.push(frame);
      widest = Math.max(widest, x + textWidth(`if (${node.guard.bare})`) + FRAME_PAD * 2);
      y = top + frame.h + ROW_GAP;
    }
  };
  walk(tree, 0, PAD);

  // Every frame runs to the same right edge: a stack of boxes of different
  // widths inside ragged frames reads as nesting that is not there.
  const width = widest + PAD;
  for (const f of frames) f.w = width - PAD - f.x;

  return { rows, frames, edges: [] as InsideEdge[], width, height: y - ROW_GAP + PAD };
}

/** Where an operand sits inside a box, for lighting the symbol a line carries. */
export function operandX(row: InsideRow, token: Token): number {
  return PAD + (row.exprStart + token.cell) * CHAR_W;
}

/** The box's own text margin, so the renderer and the layout agree on one. */
export const INSIDE_PAD = PAD;
export const INSIDE_GUARD_STEP = GUARD_STEP;
