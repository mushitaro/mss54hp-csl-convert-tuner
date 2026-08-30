import type { GraphNode, Statement } from "./types";
import type { Indexed } from "./graph";
import { type FormatContext, type FormattedLine, formatStatement } from "./logic-format";
import { displayName } from "./names";
import { CHAR_W, cells, clipCells, textWidth } from "./metrics";
import { type Token, isOperand, outToken, tokenize } from "./expr-tokens";

/**
 * Layout for the block diagram.
 *
 * The shape is the one the factory Strukturbilder use: quantities flow left to
 * right through boxes that compute something. Columns are assigned by role
 * rather than by a generic graph algorithm, because the roles are known and
 * fixed — a reader wants inputs on the left, the computation in the middle and
 * results on the right, every time, in the same place.
 *
 *   producers │ inputs │ BLOCK (formula) │ outputs │ consumers
 *
 * A block is rarely interesting alone: `tz_calc` reads N and RF, and the
 * question a tuner has next is always "and where does RF come from". So the
 * chain is followed outwards to a chosen depth. What makes that terminate is
 * that only *signals* have producers — a map, curve or constant is a leaf,
 * being a number in flash rather than something computed — so widening the
 * view adds blocks along the few RAM signals that carry state, not everything.
 *
 * Positions are computed here rather than by a layout library so the whole
 * viewer stays dependency-free and the result is deterministic: the same block
 * always draws the same way, which matters when two people compare screens.
 */

export type PortKind = "map" | "curve" | "constant" | "signal" | "block" | "unknown";

/**
 * One drawn row of a block, positioned once so the wires and the text agree.
 *
 * The renderer used to compute these y offsets itself while painting, which was
 * fine as long as nothing but the paint needed them. A wire that lands on the
 * line actually reading a variable needs them too, and two copies of the same
 * arithmetic in two files is how a formula ends up drawn 30px from the box it
 * was measured for — the failure `clipExpression` and `cellBudget` were each
 * written to fix. So the layout owns them and the renderer reads them.
 */
export interface DiagramRow {
  guardY: number | null;
  formulaY: number;
  glossY: number | null;
  /** The assigned-to name. The write wire leaves from here. */
  out: Token;
  /** Where the expression starts, in cells from the text origin. */
  exprStart: number;
  /** The expression, cut into drawable and addressable pieces. */
  tokens: Token[];
}

/** A short line from a block's border to the token the wire is really about. */
export interface DiagramLeader {
  d: string;
  /** The symbol it connects, so hovering that symbol can light it. */
  name: string;
}

/** A link between two rows of the SAME block: row i assigns what row j reads. */
export interface DiagramRail {
  d: string;
  name: string;
}

export interface DiagramNode {
  id: string;
  key: string;
  label: string;
  kind: PortKind;
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Formula lines. Full on the focused block, a relevant extract on others. */
  lines?: FormattedLine[];
  /** Whether each line's plain-language gloss is drawn (focus only). */
  showGloss?: boolean;
  /** Node id to select when clicked, when the thing exists in the graph. */
  target?: string;
  units?: string;
  detail?: string;
  /** True for the node the user selected. */
  highlight?: boolean;
  /** A neighbouring block shown in brief; it can be opened in place. */
  collapsed?: boolean;
  /** Statements not shown on a collapsed neighbour, reported not dropped. */
  moreLines?: number;
  /**
   * Blocks that carry on past this one, when the picture stopped at the depth
   * the reader chose. Absent means the chain genuinely ends here.
   */
  moreBlocks?: number;
  /** Distance from the focus in blocks: 0 is the focus itself. */
  depth?: number;
  /** Row geometry, for blocks. Same order as `lines`. */
  rows?: DiagramRow[];
  /** Left edge of the text, in node-local pixels; widened by a rail gutter. */
  textX?: number;
  /** Row-to-row links inside this block, in node-local coordinates. */
  rails?: DiagramRail[];
}

export interface DiagramEdge {
  from: string;
  to: string;
  d: string;
  kind: "read" | "write" | "call";
  /** Marks the wire as carrying one of several alternative tables. */
  alternative?: boolean;
  /** The wire came from measured cross-references, not from a formula. */
  inferred?: boolean;
  /** The symbol the wire carries, so hovering it can light the whole path. */
  signal?: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
  focus: string;
  /** Statements ranked out of the focused box, reported not dropped. */
  hiddenLines: number;
  /** Inputs/outputs beyond the port cap, likewise reported. */
  hiddenPorts: number;
  /** Neighbouring blocks beyond the per-column cap. */
  hiddenBlocks: number;
  /** Plumbing lines folded out of the focused block. */
  hiddenNoise: number;
  /** Set when the focus is a parameter rather than a block. */
  paramFocus?: string;
  /** Border-to-token connectors, in canvas coordinates. */
  leaders: DiagramLeader[];
}

export interface DiagramOptions {
  /** Formatting context; the layout must measure the text that is drawn. */
  ctx: FormatContext;
  maxPorts?: number;
  showAllLines?: boolean;
  /** Include the pointer/register plumbing lines. */
  showNoise?: boolean;
  /** How many blocks outwards to follow, in each direction. */
  depth?: number;
  /** Neighbour block keys the reader has opened. */
  expanded?: ReadonlySet<string>;
  /**
   * Draw every relation and every formula, lifting the per-column and
   * per-block caps. The caps exist to keep a first glance readable; a reader
   * who has asked for the whole picture should get the whole picture.
   */
  showEverything?: boolean;
  /** Node id to mark as the reader's current selection. */
  highlight?: string;
  /**
   * A block to leave exactly where it was, and the y it was at.
   *
   * Columns are centred against the tallest one, so a block that grows pushes
   * half its growth UPWARDS into the rows above it — and the reader is looking
   * at the block they just opened. Scrolling can absorb that only when there is
   * room above to scroll into, and at the top of the canvas there is none,
   * which is where most reading starts. So the block that grew keeps its place
   * and its column moves around it.
   *
   * Set only by the act of opening or closing one block. Every other control
   * changes the whole picture, where a stale pin would be meaningless.
   */
  anchor?: { key: string; y: number };
}

const LINE_H = 17;
const PAD = 10;
const COL_GAP = 54;
const ROW_GAP = 12;
const PORT_H = 26;
const MIN_PORT_W = 120;
const MAX_PORT_W = 260;
const MAX_EXPR_CELLS = 78;
const MAX_LINES = 12;
const MAX_NEIGHBOUR_LINES = 2;
const MAX_BLOCKS_PER_COLUMN = 5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Split "{A | B | C}" into its alternatives; a plain name yields itself. */
export function alternatives(token: string): string[] {
  const m = token.match(/^\{(.+)\}$/);
  if (!m) return [token];
  return m[1].split("|").map((s) => s.trim());
}

export function classify(g: Indexed, name: string): { kind: PortKind; target?: string } {
  const id = g.raw.nameIndex[name] ?? g.raw.nameIndex[name.toLowerCase()];
  const node = id ? g.byId.get(id) : undefined;
  if (node?.t === "param") {
    return {
      kind: node.kind === "map" ? "map" : node.kind === "curve" ? "curve" : "constant",
      target: id,
    };
  }
  if (node?.t === "func") return { kind: "block", target: id };
  if (node?.t === "ram") return { kind: "signal", target: id };
  // Not in the graph: fall back to the naming scheme the factory uses.
  if (/^KF_/i.test(name)) return { kind: "map" };
  if (/^KL_/i.test(name)) return { kind: "curve" };
  if (/^K_/i.test(name)) return { kind: "constant" };
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return { kind: "signal" };
  return { kind: "unknown" };
}

/** Symbols that are literals, flags or decompiler noise rather than data. */
function isNoise(name: string): boolean {
  return (
    /^(0x[0-9a-fA-F]+|\d+)$/.test(name) ||
    /^(CONCAT\d+|SUB\d+|SCARRY\d+|ZEXT\d+|SEXT\d+|abs)$/.test(name) ||
    /^(DAT|UNK|PTR)_[0-9a-fA-F]{6,8}$/.test(name) ||
    /^param_\d+$/.test(name) ||
    name.length < 2
  );
}

/** The interpolation and filter helpers are the operation the block performs,
 *  already legible inside the formula.  Drawing them as inputs as well would
 *  put "kfs_wint" on the canvas three times and crowd out the actual data. */
export function isHelper(name: string): boolean {
  return (
    /^(kf|kl)[su]_[wb]int$/.test(name) ||
    /^(PT1|IIR)_Filter_\w+$/.test(name) ||
    /^mem(cpy|set|move)/.test(name) ||
    name === "tableLookup"
  );
}

/**
 * Clip a formula to the width the box is measured at.
 *
 * The box used to be sized on a clipped string but drawn with the full one, so
 * any formula past the limit ran out through the right-hand border. The clip
 * now happens once, here, and the untruncated text stays on the line for the
 * tooltip.
 */
function clipExpression(out: string, expr: string, budget = MAX_EXPR_CELLS): string {
  return clipCells(expr, Math.max(10, budget - cells(out) - 3));
}

function wrapExpression(out: string, expr: string, budget = MAX_EXPR_CELLS): string {
  return `${out} = ${clipExpression(out, expr, budget)}`;
}

/** Guards are drawn on their own line, so they get the whole width. */
function clipGuard(text: string, budget = MAX_EXPR_CELLS): string {
  return clipCells(text, budget);
}

/**
 * The gloss is indented under its formula, so it clears slightly less width.
 *
 * Descriptions are no longer dropped for being long, which is what put a
 * sentence here in the first place; the whole text stays on `glossFull` for
 * the tooltip, so nothing is lost by cutting the drawn copy.
 */
function clipGloss(text: string, budget = MAX_EXPR_CELLS): string {
  return clipCells(text, budget - 2);
}

/**
 * How much text actually fits inside a block of this width.
 *
 * The cap was one constant for every block, but a neighbour is drawn at 420px
 * and the focus at 620px. A guard cut to fit the focus ran 30px out through a
 * neighbour's right border — the same failure `clipExpression` was written to
 * fix, still live on the other two kinds of line. How much fits is a property
 * of the box, so it is measured from the box.
 */
function cellBudget(maxWidth: number): number {
  return Math.max(20, Math.min(MAX_EXPR_CELLS, Math.floor((maxWidth - PAD * 2) / CHAR_W)));
}

/** The name a statement assigns to, without any index or member suffix. */
function outName(st: Statement): string {
  return st.out.replace(/[[\].>-].*$/, "");
}

// --------------------------------------------------------------------------
// who writes a signal, who reads it
// --------------------------------------------------------------------------

export interface Chain {
  /** signal name -> ids of blocks that write it */
  writers: Map<string, string[]>;
  /** signal name -> ids of blocks that read it */
  readers: Map<string, string[]>;
  /** block id -> signals it writes */
  writtenBy: Map<string, string[]>;
  /** block id -> signals it reads */
  readBy: Map<string, string[]>;
}

const CHAIN_CACHE = new WeakMap<Indexed, Chain>();

/**
 * Index the signals that connect blocks to each other.
 *
 * The formulas are the better source — they say which quantity a block
 * actually assigns — so they are indexed first. Measured cross-references fill
 * in for the 110 blocks that have no recovered formula, which keeps the older
 * inferred wiring available without letting it outvote the formulas.
 */
export function blockChain(g: Indexed): Chain {
  const cached = CHAIN_CACHE.get(g);
  if (cached) return cached;

  const writers = new Map<string, string[]>();
  const readers = new Map<string, string[]>();
  const writtenBy = new Map<string, string[]>();
  const readBy = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, key: string, id: string) => {
    const list = m.get(key);
    if (!list) m.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  };

  for (const node of g.raw.nodes) {
    if (node.t !== "func") continue;
    if (node.stmts?.length) {
      for (const st of node.stmts) {
        const out = outName(st);
        if (!isNoise(out) && classify(g, out).kind === "signal") {
          add(writers, out, node.id);
          add(writtenBy, node.id, out);
        }
        for (const r of st.reads) {
          if (isNoise(r) || isHelper(r)) continue;
          if (classify(g, r).kind === "signal") {
            add(readers, r, node.id);
            add(readBy, node.id, r);
          }
        }
      }
      continue;
    }
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o === "fr") continue;
      const other = g.byId.get(e.d);
      if (other?.t !== "ram") continue;
      add(e.k === "write" ? writers : readers, other.name, node.id);
      add(e.k === "write" ? writtenBy : readBy, node.id, other.name);
    }
  }

  const chain: Chain = { writers, readers, writtenBy, readBy };
  CHAIN_CACHE.set(g, chain);
  return chain;
}

// --------------------------------------------------------------------------
// ports
// --------------------------------------------------------------------------

interface Port {
  name: string;
  kind: PortKind;
  target?: string;
  alternative: boolean;
}

const PORT_ORDER: Record<PortKind, number> = {
  map: 0, curve: 1, constant: 2, signal: 3, block: 4, unknown: 5,
};

function sortPorts(a: Port, b: Port): number {
  return PORT_ORDER[a.kind] - PORT_ORDER[b.kind] || a.name.localeCompare(b.name);
}

function collectPorts(g: Indexed, node: GraphNode): { inputs: Port[]; outputs: Port[] } {
  const inputs = new Map<string, Port>();
  const outputs = new Map<string, Port>();

  for (const st of node.stmts ?? []) {
    const alt = new Set<string>();
    for (const m of st.expr.matchAll(/\{([^{}]+)\}/g)) {
      for (const piece of m[1].split("|")) alt.add(piece.trim());
    }
    for (const raw of st.reads) {
      if (isNoise(raw) || isHelper(raw)) continue;
      if (!inputs.has(raw)) {
        inputs.set(raw, { name: raw, ...classify(g, raw), alternative: alt.has(raw) });
      }
    }
    for (const call of st.calls) {
      if (isNoise(call) || isHelper(call)) continue;
      const c = classify(g, call);
      if (c.kind === "block" && !inputs.has(call)) {
        inputs.set(call, { name: call, ...c, alternative: false });
      }
    }
    const out = outName(st);
    if (!isNoise(out) && !outputs.has(out)) {
      outputs.set(out, { name: out, ...classify(g, out), alternative: false });
    }
  }

  // A block with no recovered formula still has measured references, so the
  // wiring is drawn from those instead of leaving an empty diagram.
  if (inputs.size === 0 && outputs.size === 0) {
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o === "fr") continue;
      const other = g.byId.get(e.d);
      if (!other || other.t === "frpage") continue;
      const port: Port = {
        name: other.name,
        ...classify(g, other.name),
        alternative: e.o === "scan",
      };
      port.target = other.id;
      if (e.k === "write") outputs.set(other.name, port);
      else inputs.set(other.name, port);
    }
  }

  return {
    inputs: [...inputs.values()].sort(sortPorts),
    outputs: [...outputs.values()].sort(sortPorts),
  };
}

const GLYPH_GUTTER = 28; // glyph column before the label

function portNode(p: Port, layer: number, units?: string): DiagramNode {
  const label = displayName(p.name, p.kind === "block" ? "func" : undefined);
  // The label starts after the glyph, so the box has to clear the gutter too;
  // sizing on the text alone clipped names like KL_TZ_START_TMOT.
  const w = clamp(GLYPH_GUTTER + textWidth(label) + PAD, MIN_PORT_W, MAX_PORT_W);
  return {
    id: `L${layer}:${p.name}`,
    key: p.name,
    label,
    kind: p.kind,
    column: layer,
    x: 0,
    y: 0,
    w,
    h: PORT_H,
    target: p.target,
    units,
  };
}

/**
 * Rank statements by how much they tell a tuner.
 *
 * A large block such as md_limiter_calc has 32 assignments but only one that
 * interpolates a table; the rest are status bits and clamps. Showing all 32
 * turns the box into a wall, and taking the first twelve would hide the single
 * line that names a curve. So the lines that touch calibration data come
 * first, and the remainder is reported as a count rather than dropped quietly.
 */
function rankStatement(st: Statement): number {
  if (st.interp.length) return 0;
  if (/\b(KF_|KL_|K_)[A-Z0-9_]+/i.test(st.expr)) return 1;
  if (/^0x[0-9a-f]+$|^-?\d+$/.test(st.expr.trim())) return 3; // a bare constant
  return 2;
}

/** The best few lines for the focused block: calibration first, source order. */
function focusLines(
  node: GraphNode,
  showAll: boolean,
  ctx: FormatContext,
  showNoise: boolean,
): { lines: FormattedLine[]; hidden: number; noise: number } {
  const all = (node.stmts ?? []).map((st, i) => ({ line: formatStatement(st, ctx), st, i }));
  const usable = showNoise ? all : all.filter((r) => !r.line.noise);
  const ordered = usable.sort(
    (a, b) => rankStatement(a.st) - rankStatement(b.st) || a.i - b.i,
  );
  const kept = showAll ? ordered : ordered.slice(0, MAX_LINES);
  return {
    lines: [...kept].sort((a, b) => a.i - b.i).map((r) => r.line),
    // What the "show the rest" button will actually reveal. Counting the
    // folded plumbing here too would promise lines that button does not show;
    // those have their own toggle and their own count.
    hidden: usable.length - kept.length,
    noise: all.length - usable.length,
  };
}

/**
 * The lines of a neighbour that concern the signal it shares with the focus.
 *
 * A neighbour is on screen to answer one question — "where does RF come from"
 * — so it shows the assignment to RF, not its other thirty statements. Opening
 * it swaps in the full set without moving anything else.
 */
function neighbourLines(
  node: GraphNode,
  signal: string,
  expanded: boolean,
  ctx: FormatContext,
  showNoise: boolean,
  everything: boolean,
): { lines: FormattedLine[]; more: number } {
  const all = node.stmts ?? [];
  // Opening a block shows everything that block has.
  //
  // This used to share a branch with `everything`, which made the toggle a
  // no-op in the default view: the block was already open, still reported
  // "+4 more", and clicking did nothing because the condition was already
  // satisfied. Those remaining lines are the ones past the line cap and the
  // folded plumbing, and both diagram-level controls for them act on the
  // focus block — so on a neighbour there was no control anywhere that could
  // open them. Opening one is now the thing that opens them.
  if (expanded) {
    const { lines, hidden, noise } = focusLines(node, true, ctx, true);
    return { lines, more: hidden + noise };
  }
  if (everything) {
    const { lines, hidden, noise } = focusLines(node, false, ctx, showNoise);
    return { lines, more: hidden + noise };
  }
  const relevant = all.filter(
    (st) => outName(st) === signal || st.reads.includes(signal),
  );
  const pool = relevant.length ? relevant : all;
  const kept = everything ? pool : pool.slice(0, MAX_NEIGHBOUR_LINES);
  return {
    lines: kept.map((st) => formatStatement(st, ctx)),
    more: all.length - kept.length,
  };
}

/** Height of one rendered line; the renderer steps by exactly these. */
export const LINE_STEP = LINE_H;
export const GLOSS_STEP = 15;
export const FOOTER_STEP = 15;

function lineHeight(l: FormattedLine, showGloss: boolean): number {
  return (
    (l.guard ? LINE_STEP : 0) + LINE_STEP + (showGloss && l.gloss ? GLOSS_STEP : 0)
  );
}

function blockSize(
  label: string,
  lines: FormattedLine[],
  showGloss: boolean,
  footer: boolean,
  maxWidth: number,
  gutter = 0,
): { w: number; h: number } {
  const body = lines.reduce((a, l) => a + lineHeight(l, showGloss), 0);
  const widest = Math.max(
    textWidth(label, 7.6),
    // The drawn string, not a differently-clipped copy of it. This used to
    // measure `clipExpression(..., MAX_EXPR_CELLS)` while the renderer drew a
    // line clipped to the block's own narrower budget — the two agreed only by
    // luck, and where they disagreed the box was sized for the wrong text.
    ...lines.map((l) => textWidth(l.shown !== undefined ? `${l.out} = ${l.shown}` : wrapExpression(l.out, l.expr))),
    ...lines.map((l) => (l.guard ? textWidth(`when ${l.guardGloss ?? l.guard}`) : 0)),
    ...lines.map((l) => (showGloss && l.gloss ? textWidth(l.gloss) + 12 : 0)),
    200,
  );
  // A block with nothing recovered is just its name; padding it to two rows of
  // empty space makes it look like something failed to load.
  const h = lines.length
    ? Math.max(PORT_H * 2, 34 + body + (footer ? FOOTER_STEP : 0) + PAD)
    : 30 + (footer ? FOOTER_STEP : 0);
  return { w: clamp(widest + PAD * 2 + gutter, 220, maxWidth), h };
}

/** Gutter geometry for the rails: a lane every 5px, clear of the text. */
const RAIL_LANE = 5;
const RAIL_MARGIN = 4;

/**
 * Rows whose result a later row of the same block reads back.
 *
 * This is the block's own dataflow, and it is invisible in a list of formulas:
 * `md_limiter_calc` computes MD_BEGR_AUSS on one line and folds it into a clamp
 * six lines down, and nothing on screen said the two were the same quantity.
 * Pairs are found on the UNCLIPPED text, because the gutter they need has to be
 * known before the width is fixed — but a pair whose reader was clipped away is
 * dropped afterwards rather than drawn into empty space.
 */
function linkPairs(lines: FormattedLine[]): { from: number; to: number; name: string }[] {
  const out: { from: number; to: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].out;
    if (!name || /^(?:RAM|FLASH) /.test(name)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      // Word boundaries only: `RF` must not match inside `RF_SOLL`.
      const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
      if (!re.test(lines[j].expr)) continue;
      out.push({ from: i, to: j, name });
      break; // the first reader is enough to show the hand-off
    }
  }
  return out;
}

/** Greedy interval colouring, so two rails that overlap never share a lane. */
function assignLanes(pairs: { from: number; to: number }[]): number[] {
  const lanes: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const used = new Set<number>();
    for (let j = 0; j < i; j++) {
      const a = pairs[i];
      const b = pairs[j];
      if (a.from <= b.to && b.from <= a.to) used.add(lanes[j]);
    }
    let lane = 0;
    while (used.has(lane)) lane++;
    lanes.push(lane);
  }
  return lanes;
}

function blockNode(
  node: GraphNode,
  layer: number,
  lines: FormattedLine[],
  opts: { collapsed?: boolean; more?: number; depth: number },
): DiagramNode {
  const label = displayName(node.name, "func");
  const showGloss = opts.depth === 0;
  // A neighbour is context; letting one grow to the focus block's width makes
  // the column ragged and the wires long for no gain in what it tells you.
  const maxWidth = opts.depth === 0 ? 620 : 420;

  // The rail gutter has to be settled before the text is clipped, because it
  // takes width away from the text — hence pairs first, on the unclipped lines.
  const pairs = linkPairs(lines);
  const lanes = assignLanes(pairs);
  const gutter = pairs.length ? RAIL_MARGIN + (Math.max(...lanes) + 1) * RAIL_LANE : 0;
  const textX = PAD + gutter;
  const budget = cellBudget(maxWidth - gutter);

  const shown = lines.map((l) => {
    // The assigned-to name gets a budget of its own. It never had one:
    // `clipExpression` divided what was left AFTER the name, and floored the
    // remainder at ten cells — so a statement assigning to
    // `p_saug_ad_ring_buffer.IOFlag[p_saug_ad_loop_counter]` (52 cells) ran out
    // through the right border before its expression began. Six tenths, so a
    // long name can dominate a line without erasing what it is set to.
    const drawnOut = clipCells(l.out, Math.max(12, Math.floor(budget * 0.6)));
    return {
      ...l,
      out: drawnOut,
      shown: clipExpression(drawnOut, l.expr, budget),
      guard: l.guard ? clipGuard(l.guardGloss ?? l.guard, budget) : undefined,
      guardGloss: l.guardGloss ? clipGuard(l.guardGloss, budget) : undefined,
      gloss: l.gloss ? clipGloss(l.gloss, budget) : undefined,
    };
  });
  const { w, h } = blockSize(label, shown, showGloss, (opts.more ?? 0) > 0, maxWidth, gutter);

  // Row geometry, stepped by exactly what the renderer draws with.
  const rows: DiagramRow[] = [];
  let y = 30;
  shown.forEach((l, i) => {
    const guardY = l.guard ? y + LINE_STEP : null;
    const formulaY = (guardY ?? y) + LINE_STEP;
    const glossY = l.gloss && showGloss ? formulaY + GLOSS_STEP : null;
    y = glossY ?? formulaY;
    rows.push({
      guardY,
      formulaY,
      glossY,
      // Drawn clipped, matched whole: a wire finds its row by the symbol, and
      // the symbol does not stop being itself because the box was too narrow.
      out: { ...outToken(l.out, l.notes), name: lines[i].out },
      // The drawn line is `out` + " = " + expr.
      exprStart: cells(l.out) + 3,
      tokens: tokenize(l.shown ?? l.expr, l.notes),
    });
  });

  const rails: DiagramRail[] = [];
  pairs.forEach((pair, i) => {
    const a = rows[pair.from];
    const b = rows[pair.to];
    // Clipping may have taken the reader away; a rail into text that is no
    // longer there would point at nothing.
    if (!a || !b || !b.tokens.some((t) => t.name === pair.name)) return;
    const x = PAD + RAIL_MARGIN / 2 + lanes[i] * RAIL_LANE;
    const y1 = a.formulaY - 4;
    const y2 = b.formulaY - 4;
    rails.push({ name: pair.name, d: `M ${textX - 2} ${y1} H ${x} V ${y2} H ${textX - 2}` });
  });

  return {
    id: `L${layer}:${node.name}`,
    key: node.name,
    label,
    kind: "block",
    column: layer,
    x: 0,
    y: 0,
    w,
    h,
    lines: shown,
    target: node.id,
    detail: node.bank,
    collapsed: opts.collapsed,
    moreLines: opts.more,
    depth: opts.depth,
    showGloss,
    rows,
    textX,
    rails,
  };
}

// --------------------------------------------------------------------------
// assembly
// --------------------------------------------------------------------------

interface Wire {
  from: string;
  to: string;
  kind: DiagramEdge["kind"];
  alternative?: boolean;
  inferred?: boolean;
}

export function buildDiagram(
  g: Indexed,
  focusId: string,
  opts: DiagramOptions,
): Diagram | null {
  const focus = g.byId.get(focusId);
  if (!focus) return null;
  const everything = opts.showEverything ?? false;
  const maxPorts = everything ? Number.MAX_SAFE_INTEGER : (opts.maxPorts ?? 14);
  const blockCap = everything ? Number.MAX_SAFE_INTEGER : MAX_BLOCKS_PER_COLUMN;
  const depth = clamp(opts.depth ?? 1, 1, 3);
  const expanded = opts.expanded ?? new Set<string>();
  const ctx = opts.ctx;
  const showNoise = opts.showNoise ?? false;

  const layers = new Map<number, DiagramNode[]>();
  const wires: Wire[] = [];
  const push = (layer: number, node: DiagramNode) => {
    const list = layers.get(layer);
    if (list) list.push(node);
    else layers.set(layer, [node]);
    return node;
  };

  let hiddenPorts = 0;
  let hiddenBlocks = 0;
  let hiddenLines = 0;
  let hiddenNoise = 0;

  // A parameter is not a computation, so it anchors the left edge and the
  // blocks that use it fan out to the right. The previous behaviour was to
  // re-centre on one consumer, which showed the reader a block they had not
  // asked for and hid the others entirely.
  if (focus.t !== "func") {
    const consumers = new Set<string>();
    for (const e of g.in.get(focusId) ?? []) {
      if (e.o !== "fr" && g.byId.get(e.s)?.t === "func") consumers.add(e.s);
    }
    for (const e of g.out.get(focusId) ?? []) {
      if (e.o !== "fr" && g.byId.get(e.d)?.t === "func") consumers.add(e.d);
    }
    const users = [...consumers]
      .map((id) => g.byId.get(id)!)
      .sort((a, b) => (b.stmts?.length ?? 0) - (a.stmts?.length ?? 0));
    if (!users.length) return null;
    const shown = users.slice(0, everything ? users.length : MAX_BLOCKS_PER_COLUMN + 1);
    hiddenBlocks += users.length - shown.length;

    const anchor = push(
      -1,
      portNode(
        { name: focus.name, ...classify(g, focus.name), alternative: false },
        -1,
      ),
    );
    anchor.highlight = true;
    anchor.target = focus.id;

    for (const user of shown) {
      const isOpen = expanded.has(user.name);
      const { lines, more } = neighbourLines(user, focus.name, isOpen, ctx, showNoise, everything);
      const bn = push(0, blockNode(user, 0, lines, { collapsed: !isOpen && !everything, more, depth: 1 }));
      wires.push({ from: anchor.id, to: bn.id, kind: "read" });

      const outs = collectPorts(g, user).outputs.filter((p) => p.kind === "signal");
      for (const o of everything ? outs : outs.slice(0, 3)) {
        const existing = (layers.get(1) ?? []).find((n) => n.key === o.name);
        const on = existing ?? push(1, portNode(o, 1));
        wires.push({ from: bn.id, to: on.id, kind: "write" });
      }
    }
    const anchored = finish(g, layers, wires, {
      focus: focus.id,
      hiddenLines: 0,
      hiddenPorts,
      hiddenBlocks,
      hiddenNoise: 0,
      paramFocus: displayName(focus.name, focus.t),
      anchor: opts.anchor,
    });
    markSelection(anchored, opts.highlight ?? focus.id);
    return anchored;
  }

  // ---- the focused block -------------------------------------------------
  const { inputs, outputs } = collectPorts(g, focus);
  const shownInputs = inputs.slice(0, maxPorts);
  const shownOutputs = outputs.slice(0, maxPorts);
  hiddenPorts += inputs.length - shownInputs.length + (outputs.length - shownOutputs.length);

  const { lines, hidden, noise } = focusLines(
    focus,
    everything || (opts.showAllLines ?? false),
    ctx,
    showNoise,
  );
  hiddenLines = hidden;
  hiddenNoise = noise;
  const centre = push(0, blockNode(focus, 0, lines, { depth: 0 }));
  centre.highlight = true;

  // Called blocks belong on the upstream side: the focus depends on them.
  const inputPorts = shownInputs.filter((p) => p.kind !== "block");
  const calledBlocks = shownInputs.filter((p) => p.kind === "block");

  for (const p of inputPorts) {
    const n = push(-1, portNode(p, -1));
    wires.push({ from: n.id, to: centre.id, kind: "read", alternative: p.alternative });
  }
  for (const p of shownOutputs) {
    const n = push(1, portNode(p, 1));
    wires.push({ from: centre.id, to: n.id, kind: "write" });
  }

  const drawn = new Set<string>([focus.name]);

  /**
   * Follow the chain one block outwards from a column of signals.
   *
   * `sign` is -1 upstream and +1 downstream; everything else is symmetric, so
   * the two directions share this rather than being written twice and drifting.
   */
  const spread = (signalLayer: number, sign: -1 | 1, level: number) => {
    if (level > depth) return;
    const chain = blockChain(g);
    const blockLayer = signalLayer + sign;
    const signalNodes = (layers.get(signalLayer) ?? []).filter((n) => n.kind === "signal");
    const candidates: { node: GraphNode; signal: string }[] = [];

    // One block often writes several of the signals in the column — dpr_sync
    // writes both RF and TMOT. Collected once per signal it would be drawn
    // twice, and since a node's id is derived from its layer and name, the two
    // copies would share an id and the wires would attach to whichever the
    // lookup happened to find.
    const picked = new Set<string>();
    for (const sn of signalNodes) {
      const ids = (sign === -1 ? chain.writers : chain.readers).get(sn.key) ?? [];
      for (const id of ids) {
        const node = g.byId.get(id);
        if (!node || drawn.has(node.name) || picked.has(node.id)) continue;
        if (isHelper(node.name)) continue;
        picked.add(node.id);
        candidates.push({ node, signal: sn.key });
      }
    }
    // Blocks that touch calibration data are the ones worth the space.
    candidates.sort((a, b) => score(b.node) - score(a.node));
    const shown = candidates.slice(0, blockCap);
    hiddenBlocks += candidates.length - shown.length;

    for (const { node, signal } of shown) {
      if (drawn.has(node.name)) continue;
      drawn.add(node.name);
      const isOpen = expanded.has(node.name);
      const { lines: nl, more } = neighbourLines(node, signal, isOpen, ctx, showNoise, everything);
      const bn = push(
        blockLayer,
        blockNode(node, blockLayer, nl, { collapsed: !isOpen && !everything, more, depth: level }),
      );
      const sn = (layers.get(signalLayer) ?? []).find((n) => n.key === signal)!;
      const inferred = !node.stmts?.length;
      if (sign === -1) wires.push({ from: bn.id, to: sn.id, kind: "write", inferred });
      else wires.push({ from: sn.id, to: bn.id, kind: "read", inferred });
    }

    if (level >= depth) {
      // The picture stops here because the reader asked for this many levels,
      // not because the signal path does — and those two facts used to be
      // drawn identically. A block at the edge with nothing after it reads as
      // the end of the chain, which for `rf_calc` is the opposite of true: RF
      // is read in 33 places. Count what is out there and say so.
      for (const bn of layers.get(blockLayer) ?? []) {
        const node = g.byId.get(bn.target!);
        if (!node) continue;
        const ports = collectPorts(g, node);
        const onwards = new Set<string>();
        for (const p of ports[sign === -1 ? "inputs" : "outputs"]) {
          if (p.kind !== "signal") continue;
          for (const id of (sign === -1 ? chain.writers : chain.readers).get(p.name) ?? []) {
            const next = g.byId.get(id);
            if (next && !isHelper(next.name) && !drawn.has(next.name)) onwards.add(next.name);
          }
        }
        // Positions are assigned after both spreads run, so growing the box
        // for the extra row here is still ahead of layout.
        if (onwards.size) {
          bn.moreBlocks = onwards.size;
          bn.h += FOOTER_STEP;
        }
      }
      return;
    }
    // The next signal column out: what those blocks read (or write) in turn.
    const nextSignalLayer = blockLayer + sign;
    for (const bn of layers.get(blockLayer) ?? []) {
      const node = g.byId.get(bn.target!);
      if (!node) continue;
      const ports = collectPorts(g, node);
      const list = (sign === -1 ? ports.inputs : ports.outputs).filter(
        (p) => p.kind === "signal" && !drawn.has(p.name),
      );
      for (const p of everything ? list : list.slice(0, 3)) {
        const existing = (layers.get(nextSignalLayer) ?? []).find((n) => n.key === p.name);
        const pn = existing ?? push(nextSignalLayer, portNode(p, nextSignalLayer));
        if (sign === -1) wires.push({ from: pn.id, to: bn.id, kind: "read" });
        else wires.push({ from: bn.id, to: pn.id, kind: "write" });
      }
    }
    spread(nextSignalLayer, sign, level + 1);
  };

  // Callees sit in the first upstream block column, next to the signal writers.
  for (const p of calledBlocks) {
    const node = p.target ? g.byId.get(p.target) : undefined;
    if (!node) continue;
    drawn.add(node.name);
    const isOpen = expanded.has(node.name);
    const { lines: nl, more } = neighbourLines(node, "", isOpen, ctx, showNoise, everything);
    const bn = push(-2, blockNode(node, -2, nl, { collapsed: !isOpen && !everything, more, depth: 1 }));
    wires.push({ from: bn.id, to: centre.id, kind: "call" });
  }

  spread(-1, -1, 1);
  spread(1, 1, 1);

  const built = finish(g, layers, wires, {
    focus: focus.id,
    hiddenLines,
    hiddenPorts,
    hiddenBlocks,
    hiddenNoise,
    anchor: opts.anchor,
  });
  markSelection(built, opts.highlight);
  return built;
}

/**
 * Mark every node that is the reader's current selection.
 *
 * Selecting a parameter used to rebuild the diagram around one of its
 * consumers, which moved the picture out from under the reader and answered a
 * question they had not asked. The picture now stays where it is and the
 * parameter lights up in it.
 */
function markSelection(d: Diagram, id?: string): void {
  if (!id) return;
  for (const n of d.nodes) {
    if (n.target === id) n.highlight = true;
  }
}

/** How much a neighbouring block is likely to be worth showing. */
function score(node: GraphNode): number {
  const stmts = node.stmts ?? [];
  let s = 0;
  for (const st of stmts) {
    if (st.interp.length) s += 10;
    else if (/\b(KF_|KL_|K_)[A-Z0-9_]+/i.test(st.expr)) s += 4;
  }
  if (node.named) s += 2;
  return s + Math.min(stmts.length, 5);
}

/** Place the columns, route the wires, and measure the canvas. */
function finish(
  _g: Indexed,
  layers: Map<number, DiagramNode[]>,
  wires: Wire[],
  meta: {
    focus: string;
    hiddenLines: number;
    hiddenPorts: number;
    hiddenBlocks: number;
    hiddenNoise: number;
    paramFocus?: string;
    anchor?: { key: string; y: number };
  },
): Diagram {
  const indices = [...layers.keys()].sort((a, b) => a - b);
  const colW = new Map<number, number>();
  for (const i of indices) {
    colW.set(i, Math.max(MIN_PORT_W, ...layers.get(i)!.map((n) => n.w)));
  }

  const stackH = (nodes: DiagramNode[]) =>
    nodes.reduce((a, n) => a + n.h, 0) + Math.max(0, nodes.length - 1) * ROW_GAP;
  const height = Math.max(...indices.map((i) => stackH(layers.get(i)!))) + PAD * 2;

  let x = 0;
  const colX = new Map<number, number>();
  for (const i of indices) {
    colX.set(i, x);
    x += colW.get(i)! + COL_GAP;
  }
  const width = x - COL_GAP + 2;

  const nodes: DiagramNode[] = [];
  let canvasHeight = height;
  for (const i of indices) {
    const list = layers.get(i)!;
    const width = colW.get(i)!;
    let y = (height - stackH(list)) / 2;
    for (const n of list) {
      // Boxes in a column differ in width, and centring them scattered the
      // points the wires attach to. Aligning each column towards the focus
      // puts every departure point on one vertical line, so the wires run
      // parallel instead of fanning.
      const offset = i < 0 ? width - n.w : i > 0 ? 0 : (width - n.w) / 2;
      n.x = colX.get(i)! + offset;
      n.y = y;
      y += n.h + ROW_GAP;
      nodes.push(n);
    }
  }

  // Put the opened block back where the reader left it, and let its column
  // slide around it. Only that column moves; everything else stays centred.
  if (meta.anchor) {
    const pinned = nodes.find((n) => n.kind === "block" && n.key === meta.anchor!.key);
    if (pinned) {
      const column = layers.get(pinned.column) ?? [];
      const top = Math.min(...column.map((n) => n.y));
      // Never above the canvas: a column pulled off the top edge would be
      // unreachable, which is a worse kind of "it moved".
      const shift = Math.max(meta.anchor.y - pinned.y, -top);
      if (shift !== 0) for (const n of column) n.y += shift;
      canvasHeight = Math.max(canvasHeight, ...column.map((n) => n.y + n.h + PAD));
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: DiagramEdge[] = [];
  const leaders: DiagramLeader[] = [];
  for (const w of wires) {
    const a = byId.get(w.from);
    const b = byId.get(w.to);
    if (!a || !b) continue;

    // Which quantity this wire carries, spelled the way it is DRAWN. One end
    // of every wire except a call is a port, and a port's label is already the
    // display spelling — the same one the formula tokens and the port box use.
    // Carrying the raw key here instead meant `kf_rf_soll` on the wire and
    // `KF_RF_SOLL` in the box, so hovering one never lit the other.
    const signal = a.kind !== "block" ? a.label : b.kind !== "block" ? b.label : undefined;

    // Land on the line that actually reads it, and leave from the line that
    // actually assigns it. Every wire used to attach at the block's vertical
    // centre, so a box with nine formulas in it said which quantities went in
    // and out and nothing at all about which of the nine used them.
    const departure = attach(a, signal, "out");
    const arrival = attach(b, signal, "in");
    const x1 = a.x + a.w;
    const y1 = departure !== null ? a.y + departure.y : a.y + a.h / 2;
    const x2 = b.x;
    const y2 = arrival !== null ? b.y + arrival.y : b.y + b.h / 2;
    const mid = x1 + (x2 - x1) / 2;
    // Orthogonal routing: out, across, in. Reads as a wiring diagram rather
    // than a spline, which is what the factory drawings do too.
    edges.push({
      from: w.from,
      to: w.to,
      kind: w.kind,
      alternative: w.alternative,
      inferred: w.inferred,
      signal,
      d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
    });

    if (signal && departure) leaders.push({ name: signal, d: `M ${a.x + departure.x} ${y1} H ${x1}` });
    if (signal && arrival) leaders.push({ name: signal, d: `M ${x2} ${y2} H ${b.x + arrival.x}` });
  }

  return {
    nodes,
    edges,
    leaders,
    width,
    height: canvasHeight,
    focus: meta.focus,
    hiddenLines: meta.hiddenLines,
    hiddenPorts: meta.hiddenPorts,
    hiddenBlocks: meta.hiddenBlocks,
    hiddenNoise: meta.hiddenNoise,
    paramFocus: meta.paramFocus,
  };
}

/**
 * Where on a block a wire for `signal` should meet the border, and how far in
 * the token it is really about sits.
 *
 * Null for anything that is not a block with rows, or for a signal none of the
 * drawn rows mentions — a neighbour shows an extract, so the line using this
 * quantity may genuinely not be on screen. The wire then keeps its old
 * behaviour and meets the box at the middle, which claims nothing.
 */
function attach(
  node: DiagramNode,
  signal: string | undefined,
  side: "in" | "out",
): { x: number; y: number } | null {
  if (!signal || node.kind !== "block" || !node.rows) return null;
  // `signal` arrives already in its display spelling, and so are the row names
  // and tokens. Re-applying `displayName` here would shout a function name that
  // deliberately stays lower case.
  const wanted = signal;
  const textX = node.textX ?? PAD;
  for (const row of node.rows) {
    if (side === "out") {
      if (row.out.name !== wanted) continue;
      // Leaves from the right-hand end of the assigned-to name, not from the
      // left margin — a leader running the whole width under the formula reads
      // as a strike-through.
      return { x: textX + row.out.cells * CHAR_W, y: row.formulaY - 4 };
    }
    const token = row.tokens.find((t) => t.name === wanted && isOperand(t.role));
    if (!token) continue;
    return { x: textX + (row.exprStart + token.cell) * CHAR_W, y: row.formulaY - 4 };
  }
  return null;
}
