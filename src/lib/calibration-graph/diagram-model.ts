import type { GraphNode, Statement } from "./types";
import type { Indexed } from "./graph";
import {
  type FormatContext,
  type FormattedLine,
  formatStatement,
  isNoise as isPlumbing,
} from "./logic-format";
import { displayName } from "./names";
import { CHAR_W, cells, clipAround, clipCells, textWidth } from "./metrics";
import { type Token, isOperand, outToken, tokenize } from "./expr-tokens";
import { type GuardNode, guardTree, rowsUnder } from "./guard-tree";
import { type Lang, t } from "./calib-i18n";
// A cycle: `boundary` asks this module for `blockChain` and `signalOf`. Safe in
// ESM because neither side calls the other while the modules are evaluating —
// both uses are inside functions — and keeping the boundary list next to the
// memory map it is derived from is worth more than breaking it up would buy.
import { boundary } from "./boundary";

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
  /**
   * This row is about the thing the reader selected.
   *
   * A block can be a hundred rows tall, and one of them is the reason it is on
   * the picture at all. Bolding the symbol was not enough to find it: the row
   * gets a band, so the eye lands on it before it starts reading.
   */
  subject?: boolean;
  formulaY: number;
  glossY: number | null;
  /**
   * Left edge of this row's text, in node-local pixels.
   *
   * Not the block's `textX`: a row inside a guard band is indented under the
   * condition that governs it, and every offset measured from the wrong origin
   * — a wire's landing point, the width the box was sized to — is wrong by the
   * indent.
   */
  x: number;
  /**
   * The baseline of each condition governing this row, outermost first.
   *
   * A rail whose reader is a CONDITION has to land on the line that spells the
   * condition, not on the formula under it — the formula does not mention the
   * quantity, and a line pointing at it would be pointing at the wrong text.
   */
  guardYs: number[];
  /** The assigned-to name. The write wire leaves from here. */
  out: Token;
  /** Where the expression starts, in cells from the text origin. */
  exprStart: number;
  /** The expression, cut into drawable and addressable pieces. */
  tokens: Token[];
}

/**
 * A condition, drawn once above the run of rows it governs.
 *
 * It used to be drawn on every one of them. 57.7% of the recovered statements
 * carry a guard and 22.6% of adjacent pairs carry the SAME one, so four lines
 * that are one `if` body arrived as four lines each with its own condition
 * reprinted in full — which reads as four unrelated lines that happen to agree,
 * and is the opposite of what the repetition means.
 */
export interface DiagramGuard {
  y: number;
  x: number;
  text: string;
  /** The condition as decompiled, for checking the reading against. */
  raw: string;
  depth: number;
}

/** The bracket down the left of a band, drawn when it governs more than one row. */
export interface DiagramBand {
  d: string;
  depth: number;
}

/**
 * A mark where statements between two drawn rows were ranked out.
 *
 * The kept lines are re-sorted back into source order before they are drawn, so
 * two rows sit next to each other whether they were adjacent in the block or
 * eleven statements apart. Without this the picture asserts an adjacency the
 * code does not have — and adjacency is most of what a reader infers from a
 * list of formulas.
 */
export interface DiagramElision {
  y: number;
  x: number;
  /** How many statements were passed over here. */
  n: number;
  /** The drawn text, composed where it is measured. */
  text: string;
}

/**
 * A short line from a block's border to the token the wire is really about.
 *
 * Run BELOW the baseline, never through the glyphs. They used to be drawn at
 * `formulaY - 4`, which is the middle of the x-height: every leader crossed the
 * text it was trying to point at, and the one thing a reader needs from it —
 * which arrow belongs to which variable — was the one thing it could not say.
 *
 * An `in` leader ends with a short rise into the token it lands on, carrying
 * the arrowhead. An `out` leader leaves the result column for the border and
 * needs none: the wire outside the box already has one.
 */
export interface DiagramLeader {
  d: string;
  /** The symbol it connects, so picking that symbol can light it. */
  name: string;
  kind: "in" | "out";
}

/**
 * A link between rows of the SAME block, drawn in the left gutter.
 *
 * `feeds` is row i assigning what row j reads. `writes` is the other relation a
 * list of formulas hides completely: several rows that are successive values of
 * ONE quantity. `rf_soll_calc` builds RF_SOLL_NO_FILTER on three separate
 * lines, each adding a correction to what the last left there, and nothing on
 * screen said those three lines were one running total.
 */
export interface DiagramRail {
  /** The spine, and the stub it leaves its source row by. No arrowhead. */
  d: string;
  /** The stubs that land on a row. Drawn separately so each can carry one. */
  heads: string[];
  name: string;
  kind: "feeds" | "writes";
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
  /**
   * This box is where the ECU meets the engine.
   *
   * `in` is a register only the hardware can set — a sensor. `out` is one the
   * code drives — an injector, a VANOS valve, the fuel pump. Marked because
   * the picture is otherwise a chain with no visible beginning or end, which
   * was the first thing said about it: no driver input, no output, so the loop
   * could not be read as a loop. See `boundary.ts` for how the list is made.
   */
  boundary?: "in" | "out";
  /**
   * A location both processors can see — the dual-port RAM.
   *
   * Worth marking because it is the only place a value crosses between them
   * without a copy, and therefore the only cross-CPU wire that is one hop.
   */
  shared?: boolean;
  units?: string;
  detail?: string;
  /** True for the node the user selected. */
  highlight?: boolean;
  /** A neighbouring block shown in brief; it can be opened in place. */
  collapsed?: boolean;
  /**
   * Shut. Its name and its size, and nothing else until it is opened.
   *
   * Different from `empty`, which means there is nothing inside to show. A
   * shut box has contents and is not showing them, so it says how many rows
   * are waiting — that is what makes it obvious it opens.
   */
  closed?: boolean;
  /** Statements inside a shut box, so it can say what opening it costs. */
  inside?: number;
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
  /** Conditions, each drawn once over the rows it governs. */
  guards?: DiagramGuard[];
  /** The brackets those conditions are drawn with. */
  bands?: DiagramBand[];
  /** Where statements were passed over between two drawn rows. */
  elisions?: DiagramElision[];
  /** Left edge of the text at depth 0, in node-local pixels; widened by a rail gutter. */
  textX?: number;
  /**
   * Why this box has no formulas in it, when it has none.
   *
   * 713 of the 1,705 functions draw an empty box, and the picture used to say
   * nothing at all about why — the listing said "no formula recovered" while
   * the box beside it was simply blank, which reads as a tool that failed
   * rather than as a fact about the binary. There are three reasons and they
   * want different things from the reader:
   *
   *   `sourceOnly`  321 have no statements but DO have the decompiler's text,
   *                 which ships with the app. CODE quotes it. This used to be
   *                 folded into `noFormula` and told the reader nothing was
   *                 there while the body sat in the artifact.
   `noFormula`   0 have neither, and the state is kept for the day that
   *                 stops being true. It described 1,061 while the exporter
   *                 dropped every function whose name still began `FUN_`; it
   *                 now describes none, and says so.
   *   `allPlumbing` 392 have statements, every one of them machine detail, so
   *                 the default view folds all of them away. PLUMBING draws them.
   */
  empty?: "noFormula" | "sourceOnly" | "allPlumbing";
  /** Row-to-row links inside this block, in node-local coordinates. */
  rails?: DiagramRail[];
  /** Links this block has that the gutter had no lane left for. */
  hiddenLinks?: number;
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
  /** The symbol the wire carries, so picking it can light the whole path. */
  signal?: string;
  /**
   * The wire reaches a specific line inside the box, and the leader there
   * carries the arrowhead. Two heads on one path is one more than the reader
   * has to follow.
   */
  landed?: boolean;
  /**
   * The return half of a loop, routed BELOW the columns.
   *
   * Engine control is feedback: the throttle moves the air, the air is
   * measured, and the measurement moves the throttle. The picture is laid out
   * in columns that run one way, so the wire that closes the circle has to run
   * the other way — and through the middle it would cross every column between
   * its ends, where a crossing reads as a connection. Underneath, it reads as
   * what it is.
   */
  back?: boolean;
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
  /** Row-to-row links past the gutter's lane budget, across every block drawn. */
  hiddenLinks: number;
  /** Return wires past the lane budget under the columns. */
  hiddenLoops: number;
  /** Loops whose last link is one step outside the view. See `loopsBeyond`. */
  loopsBeyond: number;
  /**
   * The two ends of the ECU, as "how many are on this picture, of how many
   * there are". The denominators are fixed lists, so the shape never changes.
   */
  ends: { inShown: number; inTotal: number; outShown: number; outTotal: number };
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
  /**
   * Draw the contents of every box, without opening any of them.
   *
   * Distinct from `expanded`, which also widens how many lines a box may show,
   * and from `showEverything`, which lifts the per-column caps. This one asks
   * only "un-shut them", which is what a check about how a formula is DRAWN
   * needs, and what the reader would mean by a control that opened all.
   */
  openBlocks?: boolean;
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

/**
 * Line pitch.
 *
 * Seventeen for an 11.5px formula left no room between one line and the next,
 * which is why the connectors were drawn THROUGH the text: there was nowhere
 * else to put them. They now run in the gap, so the gap has to exist.
 */
const LINE_H = 22;
const PAD = 10;
const COL_GAP = 54;
const ROW_GAP = 12;
const PORT_H = 26;
const MIN_PORT_W = 120;
const MAX_PORT_W = 260;
const MAX_EXPR_CELLS = 78;
const MAX_LINES = 12;
const MAX_NEIGHBOUR_LINES = 2;
/**
 * How far out the picture will walk.
 *
 * Three, until the boxes were shut by default. Open, one more level was
 * another wall of formulas; shut, it is another row of names — DEPTH 3 now
 * draws a smaller canvas than DEPTH 1 used to. Measured over 134 pictures:
 * each level adds about a thousand pixels of width, four blocks and two
 * milliseconds, and what the extra reach is FOR saturates here — the count of
 * pictures that manage to contain a sensor or an actuator goes 34, 39, 41, 42
 * across depths three to six.
 */
const MAX_DEPTH = 5;

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

/**
 * The dual-port RAM: 0xff8000-0xff83ff, the one window both processors see.
 *
 * Measured, not assumed. All 94 nodes whose name contains DPR live inside it
 * and not one lives outside, and 247 of the 340 names that appear in both banks
 * are at the same address in there. Those 247 are ONE location. The other 93
 * are two: 29 sit at different addresses (`N` is 0xffedce on the master and
 * 0xffe844 on the slave) and 64 sit at the same address in each processor's own
 * memory, which is the same number naming two different things.
 */
const DPR_LO = 0xff8000;
const DPR_HI = 0xff8400;

/** One place in memory, and the name a formula spells it by. */
export interface Signal {
  /** Identity. Two blocks share a signal only when they share this. */
  key: string;
  /** True when both processors genuinely see this one location. */
  shared: boolean;
  /** The node it resolves to, for that bank. */
  target?: string;
  bank?: string;
}

const SIGNAL_CACHE = new WeakMap<Indexed, Map<string, Signal>>();
const TWIN_CACHE = new WeakMap<Indexed, Map<string, GraphNode[]>>();

/** Every node sharing a name, keyed `t\u0000name`. Built once per graph. */
function twinsOf(g: Indexed, node: GraphNode): GraphNode[] {
  let index = TWIN_CACHE.get(g);
  if (!index) {
    index = new Map();
    for (const n of g.raw.nodes) {
      const k = `${n.t}\u0000${n.name}`;
      const list = index.get(k);
      if (list) list.push(n);
      else index.set(k, [n]);
    }
    TWIN_CACHE.set(g, index);
  }
  return index.get(`${node.t}\u0000${node.name}`) ?? [node];
}

/**
 * Which memory location a name means, to a block on a given bank.
 *
 * `blockChain` used to key signals by NAME, and 340 RAM names exist in both
 * banks — so a master block writing `N` and a slave block reading `N` were
 * joined by an edge, and 1,053 such edges were between two different locations
 * that merely share a spelling. Meanwhile the master and slave are separate
 * processors with, measurably, zero edges between them in the whole graph.
 *
 * Identity is therefore the ADDRESS, not the name: shared window means one
 * signal, anything else means one per bank. What that costs is the shortcut;
 * what it buys is that the real route appears — master writes its own copy,
 * `dpr_sync` posts it into the window, the slave's `dpr_sync` takes it out.
 */
/**
 * A name that is only an address: `Ram00fff454`, `DAT_00ffe4fc`, `_DAT_...`.
 *
 * The decompiler writes these where it has no symbol, and `parse_logic` keeps
 * that spelling in the statement. The graph may still hold a RAM node at the
 * very same address under a real name — 0xFFF454 is `CTM4_DASM10B` — and the
 * two spellings then denote one location while comparing unequal.
 */
const ADDRESS_NAME = /^_?(?:Ram|DAT|PTR|UNK|LAB)_?0*([0-9a-fA-F]{4,8})$/;

/** RAM nodes by bank and address, memoised per graph. Exact hits only. */
const ADDR_NODES = new WeakMap<Indexed, Map<string, GraphNode>>();

function ramAt(g: Indexed, addr: number, bank?: string): GraphNode | undefined {
  let ix = ADDR_NODES.get(g);
  if (!ix) {
    ix = new Map();
    for (const n of g.raw.nodes) {
      if (n.t !== "ram" || n.addr === undefined) continue;
      const k = `${n.bank ?? "-"}:${n.addr}`;
      if (!ix.has(k)) ix.set(k, n);
    }
    ADDR_NODES.set(g, ix);
  }
  // The asked-for bank ONLY. Falling through to the other one welded the two
  // processors back together — 36 cross-processor hand-offs joining two
  // different addresses that merely share a location number, which is the
  // exact failure `signalOf` keys by location to prevent. A reference this
  // bank has no node for is a reference this tool cannot resolve, and saying
  // so is the correct answer.
  if (bank) return ix.get(`${bank}:${addr}`);
  return ix.get(`master:${addr}`) ?? ix.get(`slave:${addr}`) ?? ix.get(`-:${addr}`);
}

export function signalOf(g: Indexed, name: string, bank?: string): Signal {
  let cache = SIGNAL_CACHE.get(g);
  if (!cache) {
    cache = new Map();
    SIGNAL_CACHE.set(g, cache);
  }
  const memo = `${bank ?? "-"}\u0000${name}`;
  const held = cache.get(memo);
  if (held) return held;

  const id = g.raw.nameIndex[name] ?? g.raw.nameIndex[name.toLowerCase()];
  let found = id ? g.byId.get(id) : undefined;
  if (!found) {
    // The same location under the decompiler's spelling. This is the rule the
    // rest of this file already runs on — two ports are the same port when
    // their locations match, not when their names do — applied to the one
    // place a location can arrive wearing a different name.
    //
    // It matters because a function GAINING statements can otherwise lose a
    // relation. Before the exporter stopped filtering, FUN_00020b7e had no
    // statements and its write reached here as an xref edge, correctly keyed
    // to CTM4_DASM10B at 0xFFF454. With statements it arrives as a write to
    // Ram00fff454, matches nothing, and three actuator outputs disappeared
    // off the OUT rail — more recovered code producing a smaller picture.
    //
    // Exact address, no offset and no region: this decides identity, and a
    // near-miss here would weld two signals that are merely adjacent.
    const m = ADDRESS_NAME.exec(name);
    if (m) found = ramAt(g, parseInt(m[1], 16), bank);
  }
  let answer: Signal = { key: `?:${name}`, shared: false };
  if (found) {
    // Every node carrying this name. The index holds one of them; the twin on
    // the other bank has to be looked up by name.
    const twins = twinsOf(g, found);
    const m = twins.find((n) => n.bank === "master");
    const sl = twins.find((n) => n.bank === "slave");
    const oneLocation =
      m !== undefined &&
      sl !== undefined &&
      m.addr !== undefined &&
      m.addr === sl.addr &&
      m.addr >= DPR_LO &&
      m.addr < DPR_HI;
    if (oneLocation) {
      answer = { key: `shared:${found.name}`, shared: true, target: m.id, bank: undefined };
    } else {
      const own = twins.find((n) => n.bank === bank) ?? found;
      answer = { key: `${own.bank ?? "-"}:${own.name}`, shared: false, target: own.id, bank: own.bank };
    }
  }
  cache.set(memo, answer);
  return answer;
}

export function classify(
  g: Indexed,
  name: string,
  /** The bank of the block doing the reading or writing; decides which twin. */
  bank?: string,
): { kind: PortKind; target?: string } {
  const resolved = signalOf(g, name, bank);
  const node = resolved.target ? g.byId.get(resolved.target) : undefined;
  if (node?.t === "param") {
    return {
      kind: node.kind === "map" ? "map" : node.kind === "curve" ? "curve" : "constant",
      target: node.id,
    };
  }
  if (node?.t === "func") return { kind: "block", target: node.id };
  if (node?.t === "ram") return { kind: "signal", target: node.id };
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
function clipExpression(
  out: string,
  expr: string,
  budget = MAX_EXPR_CELLS,
  /** The selected symbol, which the clip must not be allowed to cut away. */
  keep?: string,
): string {
  return clipAround(expr, Math.max(10, budget - cells(out) - 3), keep);
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

/**
 * The name a statement assigns to, without any index, member suffix, or the
 * decompiler's leading underscore.
 *
 * The underscore is how this artifact renders a write through a pointer, and
 * dropping it was not cosmetic: `classify("_N_DPR")` returned "unknown", so 118
 * writes across the artifact were registered as nothing at all — including all
 * 17 of `dpr_sync[master]`'s, which is every value the master hands to the
 * slave. The one block that bridges the two processors looked like a leaf.
 */
export function outName(st: Statement): string {
  return st.out.replace(/[[\].>-].*$/, "").replace(/^_+/, "");
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

  // Keyed by LOCATION, not by name: see `signalOf`. Every lookup passes the
  // block's own bank, so a slave block reading `N` is joined to the slave's N.
  for (const node of g.raw.nodes) {
    if (node.t !== "func") continue;
    if (node.stmts?.length) {
      for (const st of node.stmts) {
        const out = outName(st);
        if (!isNoise(out) && classify(g, out, node.bank).kind === "signal") {
          const key = signalOf(g, out, node.bank).key;
          add(writers, key, node.id);
          add(writtenBy, node.id, key);
        }
        for (const r of st.reads) {
          if (isNoise(r) || isHelper(r)) continue;
          if (classify(g, r, node.bank).kind === "signal") {
            const key = signalOf(g, r, node.bank).key;
            add(readers, key, node.id);
            add(readBy, node.id, key);
          }
        }
      }
      // Statements INSTEAD OF xrefs, not as well as — and that exclusivity is
      // now worth a decision it did not need before.
      //
      // The two sources are not nested. A statement is what the formula says;
      // an xref is what Ghidra's reference analysis found, which includes
      // references no formula recovered. While 1,171 functions had no
      // statements the rule read as "prefer the semantic view, fall back to
      // the structural one", and that was right.
      //
      // Then the exporter stopped filtering and 834 functions gained
      // statements — and with them lost their xrefs. TPU_SEGM_PERIOD is the
      // visible casualty: f:slave:011770 writes 0xFFFF10 by xref, does not
      // write it in any recovered statement, and the register dropped off the
      // OUT rail even though strictly more had been recovered about the
      // function that drives it.
      //
      // Unioning the two was measured rather than argued: written signals
      // 2,189 -> 2,388, read 1,548 -> 2,162, writer/reader pairs 15,317 ->
      // 27,948. Applying the statement path's noise filter to the xref side
      // as well moves 4 of those pairs, so the two sources are not disagreeing
      // about noise — they are disagreeing about how much a picture should
      // hold.
      //
      // Nearly doubling every block's neighbours changes what the picture
      // MEANS: it would draw relations that appear in no formula, which is the
      // one thing the block diagram has always been. That is a decision about
      // the view, not a bug fix, so it is written down here rather than taken
      // in the middle of an artifact change.
      continue;
    }
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o === "fr") continue;
      const other = g.byId.get(e.d);
      if (other?.t !== "ram") continue;
      // An xref names the node outright, so its own bank is the answer.
      const key = signalOf(g, other.name, other.bank).key;
      add(e.k === "write" ? writers : readers, key, node.id);
      add(e.k === "write" ? writtenBy : readBy, node.id, key);
    }
  }

  const chain: Chain = { writers, readers, writtenBy, readBy };
  CHAIN_CACHE.set(g, chain);
  return chain;
}

const USERS_CACHE = new WeakMap<Indexed, Map<string, string[]>>();
const CODE_NAME_CACHE = new WeakMap<Indexed, Map<string, string>>();

/**
 * The spelling a FORMULA uses for a node.
 *
 * A catalog entry can carry a human suffix — the Alpha-N map is stored as
 * `kf_rf_soll (CSL Alpha-N)` — while every formula, port, wire and token in the
 * picture spells the bare symbol. Drawing the subject under the catalog's name
 * therefore gave one map two boxes: the subject as `kf_rf_soll (CSL Alpha-N)`
 * and, one row down, the same map again as `KF_RF_SOLL` because a user block
 * listed it among its inputs. Two boxes, two labels, and clicking the symbol in
 * a formula lit neither of them.
 */
export function codeName(g: Indexed, node: GraphNode): string {
  let map = CODE_NAME_CACHE.get(g);
  if (!map) {
    map = new Map<string, string>();
    // The shortest key that resolves to a node: the index holds the bare symbol
    // alongside any longer spelling, and the bare one is what a formula writes.
    for (const [name, id] of Object.entries(g.raw.nameIndex)) {
      const held = map.get(id);
      if (held === undefined || name.length < held.length) map.set(id, name);
    }
    CODE_NAME_CACHE.set(g, map);
  }
  return map.get(node.id) ?? node.name;
}

/**
 * Which blocks touch each parameter and each signal — one pass, cached.
 *
 * Two sources, because neither alone is complete. For 1,377 parameters the
 * measured cross-references name a user the formulas do not, and for 143 the
 * formulas name a user the references missed. So the answer is the union.
 *
 * Indexed rather than searched because the listing asks this per ROW. Asking it
 * by scanning every block's statements would be the artifact walked once for
 * each of 349,873 lines.
 */
function userIndex(g: Indexed): Map<string, string[]> {
  const cached = USERS_CACHE.get(g);
  if (cached) return cached;

  const found = new Map<string, Set<string>>();
  const add = (thing: string, fn: string) => {
    const list = found.get(thing);
    if (list) list.add(fn);
    else found.set(thing, new Set([fn]));
  };

  for (const e of g.raw.edges) {
    if (e.o === "fr") continue;
    const s = g.byId.get(e.s);
    const d = g.byId.get(e.d);
    if (!s || !d) continue;
    if (s.t === "func" && (d.t === "param" || d.t === "ram")) add(d.id, s.id);
    else if (d.t === "func" && (s.t === "param" || s.t === "ram")) add(s.id, d.id);
  }

  // Resolved through the name index rather than compared as text: a node's
  // `name` can carry a human suffix — the map is `kf_rf_soll (CSL Alpha-N)` —
  // while a formula spells the bare symbol. This is the resolution `classify`
  // does, so a name that reaches one reaches the other.
  // Resolved for the READING block's bank, so a slave block does not register
  // as a user of the master's copy of a name they happen to share.
  const resolve = (name: string, bank?: string): GraphNode | undefined => {
    const target = signalOf(g, name, bank).target;
    return target ? g.byId.get(target) : undefined;
  };
  for (const n of g.raw.nodes) {
    if (n.t !== "func" || !n.stmts?.length) continue;
    for (const st of n.stmts) {
      // Writing something is using it too — for a RAM signal that is how the
      // producer gets into the list, which is half of what a reader wants.
      const w = resolve(outName(st), n.bank);
      if (w && (w.t === "param" || w.t === "ram")) add(w.id, n.id);
      for (const r of st.reads) {
        const t = resolve(r, n.bank);
        if (t && (t.t === "param" || t.t === "ram")) add(t.id, n.id);
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [thing, fns] of found) out.set(thing, [...fns]);
  USERS_CACHE.set(g, out);
  return out;
}

/**
 * Every block that uses a parameter or a signal, best first.
 *
 * What this replaces is `owningBlock`, which ranked the same candidates and
 * returned the FIRST. One user is the right answer for 1,853 parameters and the
 * wrong one for the other 383: `kf_rf_soll` is read by `rf_soll_calc` and by
 * `rf_sk_wdk_calc`, and a reader who selects the map is asking about both.
 */
export function usersOf(g: Indexed, node: GraphNode): GraphNode[] {
  return (userIndex(g).get(node.id) ?? [])
    .map((id) => g.byId.get(id))
    .filter((n): n is GraphNode => n?.t === "func")
    // Blocks that compute with calibration first — the same ranking the
    // neighbour columns use, so one column does not order itself differently
    // from the next.
    .sort((a, b) => score(b) - score(a));
}

/** The same list, by name as a formula spells it. */
export function usersOfName(g: Indexed, name: string): GraphNode[] {
  const id = g.raw.nameIndex[name] ?? g.raw.nameIndex[name.toLowerCase()];
  const node = id ? g.byId.get(id) : undefined;
  return node ? usersOf(g, node) : [];
}

// --------------------------------------------------------------------------
// ports
// --------------------------------------------------------------------------

interface Port {
  /** The spelling a formula uses. What is drawn, and what a wire is matched by. */
  name: string;
  /**
   * The location it means. Two ports are the same port only when these match.
   *
   * Deduping on `name` welded the two processors together: `N` exists on both
   * banks at two different addresses, and one box stood for both.
   */
  signal: string;
  /** True when both processors really do see this one location. */
  shared: boolean;
  /** Which processor's memory it is, when it is not shared. */
  bank?: string;
  kind: PortKind;
  target?: string;
  alternative: boolean;
}

/** Resolve a name for one block, carrying its identity along with its kind. */
function portOf(g: Indexed, name: string, node: GraphNode, alternative: boolean): Port {
  const sig = signalOf(g, name, node.bank);
  return {
    name,
    signal: sig.key,
    shared: sig.shared,
    bank: sig.bank,
    ...classify(g, name, node.bank),
    alternative,
  };
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
      const port = portOf(g, raw, node, alt.has(raw));
      if (!inputs.has(port.signal)) inputs.set(port.signal, port);
    }
    for (const call of st.calls) {
      if (isNoise(call) || isHelper(call)) continue;
      const port = portOf(g, call, node, false);
      if (port.kind === "block" && !inputs.has(port.signal)) inputs.set(port.signal, port);
    }
    const out = outName(st);
    if (!isNoise(out)) {
      const port = portOf(g, out, node, false);
      if (!outputs.has(port.signal)) outputs.set(port.signal, port);
    }
  }

  // A block with no recovered formula still has measured references, so the
  // wiring is drawn from those instead of leaving an empty diagram.
  if (inputs.size === 0 && outputs.size === 0) {
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o === "fr") continue;
      const other = g.byId.get(e.d);
      if (!other || other.t === "frpage") continue;
      // The xref names the node outright, so its own bank settles it.
      const sig = signalOf(g, other.name, other.bank);
      const port: Port = {
        name: other.name,
        signal: sig.key,
        shared: sig.shared,
        bank: sig.bank,
        ...classify(g, other.name, other.bank),
        alternative: e.o === "scan",
        target: other.id,
      };
      if (e.k === "write") outputs.set(port.signal, port);
      else inputs.set(port.signal, port);
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
  // The LABEL stays the formula's spelling — wires and formula tokens are
  // matched by it, and renaming the box would break the match. Which of the two
  // copies this is gets said by the bank badge instead.
  // The label starts after the glyph, so the box has to clear the gutter too;
  // sizing on the text alone clipped names like KL_TZ_START_TMOT.
  const w = clamp(GLYPH_GUTTER + textWidth(label) + PAD, MIN_PORT_W, MAX_PORT_W);
  return {
    id: `L${layer}:${p.signal}`,
    key: p.signal,
    label,
    kind: p.kind,
    column: layer,
    x: 0,
    y: 0,
    w,
    h: PORT_H,
    target: p.target,
    units,
    shared: p.shared,
    detail: p.kind === "signal" && !p.shared ? p.bank : undefined,
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

/**
 * How far a rank travels along the block's own dataflow.
 *
 * `rankStatement` reads one statement at a time, and a statement is rarely
 * worth reading alone: the line that interpolates a map is built from the two
 * lines above it that prepared its axes, and is there for the line below it
 * that uses the result. Ranked separately, those neighbours score 2 and are cut
 * — which is how the twelve lines that survived could be twelve fragments with
 * the connections between them off screen.
 *
 * Both directions decay, and that is what stops the promotion swallowing the
 * ranking: an interpolation stays 0, its own inputs come next, theirs after
 * that, and by the third or fourth hop the line is back at the baseline it
 * would have had anyway. Upstream travels the further of the two — what a
 * quantity is BUILT from is nearer to the question than what it is later
 * spent on.
 */
const RANK_UPSTREAM = 0.25;
const RANK_DOWNSTREAM = 0.5;

function spreadRank(rows: { line: FormattedLine; st: Statement }[]): number[] {
  const rank = rows.map((r) => rankStatement(r.st));
  const pairs = linkPairs(rows.map((r) => r.line));
  if (!pairs.length) return rank;
  // Both rules only ever lower a rank, so this settles.
  for (let pass = 0; pass < rows.length; pass++) {
    let moved = false;
    for (const p of pairs) {
      const up = rank[p.to] + RANK_UPSTREAM;
      if (rank[p.from] > up) { rank[p.from] = up; moved = true; }
      const down = rank[p.from] + RANK_DOWNSTREAM;
      if (rank[p.to] > down) { rank[p.to] = down; moved = true; }
    }
    if (!moved) break;
  }
  return rank;
}

/**
 * A drawn line, and which statement of the block it came from.
 *
 * The index has to travel with the line: the kept lines are re-sorted into
 * source order and drawn contiguously, so the only way to know two rows were
 * not adjacent is to have kept what they were.
 */
export type PlacedLine = FormattedLine & { src: number };

/** The best few lines for the focused block: calibration first, source order. */
function focusLines(
  node: GraphNode,
  showAll: boolean,
  ctx: FormatContext,
  showNoise: boolean,
): { lines: PlacedLine[]; hidden: number; noise: number } {
  const all = (node.stmts ?? []).map((st, i) => ({ line: formatStatement(st, ctx), st, i }));
  const usable = showNoise ? all : all.filter((r) => !r.line.noise);
  const rank = spreadRank(usable);
  const ordered = usable
    .map((r, k) => ({ ...r, rank: rank[k] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const kept = showAll ? ordered : ordered.slice(0, MAX_LINES);
  return {
    lines: [...kept].sort((a, b) => a.i - b.i).map((r) => ({ ...r.line, src: r.i })),
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
  g: Indexed,
  node: GraphNode,
  /**
   * The LOCATION this neighbour is on screen for, as `signalOf` keys it.
   *
   * A key, not a name, and the statements have to be resolved to compare: the
   * master and the slave both have an `RF`, and picking "the lines that mention
   * RF" by spelling would pick the wrong block's lines half the time.
   */
  signal: string,
  expanded: boolean,
  ctx: FormatContext,
  showNoise: boolean,
  everything: boolean,
  /**
   * ...and how many rows it folded away as machine detail.
   *
   * Reported because the PLUMBING control is drawn from it. Only the focus
   * block used to report it, so for a parameter subject — where every block on
   * screen is a neighbour — the count was zero and the control never appeared.
   * The setting was still passed down and still changed 1,963 of the 2,236
   * parameter pictures: a control that was doing something with nowhere to
   * press it.
   */
): { lines: PlacedLine[]; more: number; noise: number } {
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
    return { lines, more: hidden + noise, noise };
  }
  if (everything) {
    const { lines, hidden, noise } = focusLines(node, false, ctx, showNoise);
    return { lines, more: hidden + noise, noise };
  }
  const indexed = all.map((st, i) => ({ st, i }));
  const here = (name: string) => signalOf(g, name, node.bank).key === signal;
  const relevant = indexed.filter(
    (r) => here(outName(r.st)) || r.st.reads.some(here),
  );
  const pool = relevant.length ? relevant : indexed;
  const kept = everything ? pool : pool.slice(0, MAX_NEIGHBOUR_LINES);
  return {
    lines: kept.map((r) => ({ ...formatStatement(r.st, ctx), src: r.i })),
    more: all.length - kept.length,
    // Counted on the statements rather than on formatted lines: it is the same
    // predicate `focusLines` filters by, and this branch never formats the rest.
    noise: showNoise ? 0 : all.filter((st) => isPlumbing(st, ctx)).length,
  };
}

/** Height of one rendered line; the renderer steps by exactly these. */
export const LINE_STEP = LINE_H;
/**
 * The gloss sits far enough under its formula for the connector lane between
 * them: the lane is six below the baseline and a 10.5px gloss reaches about
 * seven and a half above its own.
 */
export const GLOSS_STEP = 18;
/** Vertical spacing between the lanes the return wires run in, below the columns. */
const BACK_LANE = 11;
/**
 * Lanes a picture will spend on return wires before it starts reporting them
 * instead of drawing them.
 *
 * Set from the measurement, not from taste. At DEPTH 1 — the default, and what
 * someone meeting the picture for the first time is looking at — the deepest
 * stack over the 1,384 pictures reaches exactly this budget, and `hiddenLoops`
 * is 0 there: **at the default nothing is ever dropped**, every loop the tool
 * knows about is on screen.
 *
 * Deeper pictures do exceed it, and what does not fit is counted into HIDDEN
 * like everything else. How far they would go if uncapped is not written here
 * on purpose: measuring it means measuring what the layout DREW, which this
 * constant bounds, so any number taken that way is this constant read back.
 * The earlier form of this comment quoted 24 at DEPTH 2 and 41 at DEPTH 3, and
 * they cannot be reproduced without raising the cap first.
 */
const MAX_BACK_LANES = 14;

export const FOOTER_STEP = 15;

/** How far a condition indents the rows it governs. */
const GUARD_INDENT = 12;
/**
 * The two lanes a connector runs in, and where it stops against the symbol.
 *
 * A value LEAVES a row underneath its name and ARRIVES at a row over the
 * operand that reads it. Both ends used to run underneath, which put the line
 * that goes and the line that comes in the same place beneath two names, with
 * only the arrowhead to tell them apart. Above and below is the difference
 * being carried by the geometry instead.
 *
 * The numbers come from the line pitch. A formula baseline always sits 22px
 * under the previous drawn line — measured over all 32,634 drawn rows in the
 * artifact, that gap is uniform — and 11.5px text descends about 3 and rises
 * about 8. So the band above a row is a clear 11px, and 13 sits in the middle
 * of it. Below, the next line does not start for another 22, and 6 clears the
 * descenders.
 *
 * `DROP_TO` stops one pixel clear of the glyph tops, so the arrowhead lands
 * against the symbol rather than over it. The leaving side needs no such stop:
 * it starts at the name and runs straight out to the gutter.
 */
const RUN_BELOW = 6;
const RUN_ABOVE = 13;
const DROP_TO = 9;
/** Height of an elision mark. Shorter than a line: it is not one. */
const ELIDE_STEP = 13;
/** How far the bracket sits left of the text inside its band. */
const BAND_GAP = 5;

function blockSize(
  label: string,
  placed: Placed,
  lineCount: number,
  footer: boolean,
  maxWidth: number,
  gutter = 0,
  /** The box carries a line saying why it is empty, and has to have room for it. */
  reason = false,
  /** Shut: a name, not a formula, so it is sized like one. */
  shut = false,
): { w: number; h: number } {
  // The widths come from `placeLines`, which measured the string it positioned
  // — including its indent. Measuring here from the lines alone is how the box
  // used to be sized for text drawn at a different width, three times over.
  // A shut box is a name and a count, so it is as wide as its name. The 200
  // floor and the 220 clamp below exist to keep a column of FORMULAS from
  // being ragged; applied to names they made a network of fifteen boxes 2,154
  // pixels wide, which FIT then showed at 43% — unreadable, which is the whole
  // complaint about this view.
  const widest = shut
    ? textWidth(label, 7.6) + 34
    : Math.max(textWidth(label, 7.6), placed.widest, 200);
  // A block with nothing recovered is its name and one line saying so. It used
  // to be the name alone, which is indistinguishable from a box that failed to
  // load — and 68% of the block boxes this file draws are in that state.
  const h = lineCount
    ? Math.max(PORT_H * 2, 34 + placed.bodyH + (footer ? FOOTER_STEP : 0) + PAD)
    : 30 + (reason ? FOOTER_STEP : 0) + (footer ? FOOTER_STEP : 0);
  return { w: clamp(widest + PAD * 2 + gutter, shut ? 96 : 220, maxWidth), h };
}

/** Gutter geometry for the rails: a lane every 5px, clear of the text. */
const RAIL_LANE = 5;
const RAIL_MARGIN = 4;
/**
 * How wide the gutter is allowed to get, in lanes.
 *
 * Every lane is width the formulas do not get, so this is a real trade and not
 * a tidiness rule. Ten covers every block in the default twelve-line view and
 * 97% of them with SHOW ALL on; what does not fit is counted and reported
 * rather than dropped quietly. It is affordable only because a fan-out shares
 * one lane — before that, ten lanes covered 90% of the default view and the
 * worst block wanted 799.
 */
export const MAX_RAIL_LANES = 10;

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
/** Whole-word containment. `RF` must not match inside `RF_SOLL`. */
function mentions(text: string, name: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
  return re.test(text);
}

interface LinkPair {
  from: number;
  to: number;
  name: string;
  /** Set when the read is in a CONDITION rather than in the expression. */
  viaGuard?: number;
}

/**
 * True when a write at `writer` definitely replaces the value written at `def`.
 *
 * A write inside a branch the definition is not in replaces nothing: if the
 * branch does not run, the old value is still there for whatever reads next.
 * `rf_soll_calc` turns on this — RF_SOLL_NO_FILTER is set unconditionally, then
 * overwritten under `AVAN1_SOLL_FAKTOR != 0`, then added to under a different
 * condition again. Treating the guarded write as a kill would cut the first
 * line off from the two lines that can still read it.
 */
function replaces(lines: FormattedLine[], def: number, writer: number): boolean {
  const a = lines[def].guardParts ?? [];
  const b = lines[writer].guardParts ?? [];
  if (b.length > a.length) return false;
  return b.every((p, k) => p.raw === a[k]?.raw);
}

/**
 * Every row that reads what a row assigned, until something replaces it.
 *
 * This used to stop at the first reader — "the first reader is enough to show
 * the hand-off". It is not: over the whole artifact the block-internal
 * dataflow is 4,129 hand-offs and first-reader-only drew 646 of them, so five
 * out of six of the relations inside a block were simply absent. `tog_calc`
 * has 684 and drew none.
 *
 * Walking to the next write rather than to the end of the block is what keeps
 * the extra lines honest. A name holds one value at a time, and the reader six
 * rows down is reading whatever was written most recently — not this row.
 * Conditions are read as well as expressions: `rf_soll_calc` picks its filter
 * time constant by testing the running total against the previous cycle, and
 * that test was the one relation in the block with nothing on screen at all.
 */
export function linkPairs(lines: FormattedLine[]): LinkPair[] {
  const out: LinkPair[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].out;
    if (!name || /^(?:RAM|FLASH) /.test(name)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const guardHit = (lines[j].guardParts ?? []).findIndex((p) => mentions(p.text, name));
      if (guardHit >= 0) out.push({ from: i, to: j, name, viaGuard: guardHit });
      if (mentions(lines[j].expr, name)) out.push({ from: i, to: j, name });
      // Tested after the reads, because `x = x + 1` does both.
      if (lines[j].out === name && replaces(lines, i, j)) break;
    }
  }
  return out;
}

/**
 * Runs of rows that are successive values of one quantity.
 *
 * A row joins the previous write of the same name when its OWN expression reads
 * that name — `x = f(x, …)`, which is what an update is. Nothing weaker will
 * do. The decompiler recycles its temporaries, and `rf_soll_calc` writes
 * `rf_soll_kath_temp` five times: three of them are the catalyst-heating delta
 * being refined, and the other two are an unrelated PT correction reusing the
 * name. Chaining every write of a name would draw one line down the block
 * asserting those five were one quantity. The read-back test splits them where
 * the recycle happens, because the fresh use does not read what was there.
 *
 * A plain overwrite — `x = 3` after `x = 2` — is deliberately NOT a link: the
 * old value was discarded, and saying otherwise would be the same lie.
 */
export function writeChains(lines: FormattedLine[]): { name: string; rows: number[] }[] {
  const open = new Map<string, number[]>();
  const done: { name: string; rows: number[] }[] = [];
  const close = (name: string) => {
    const rows = open.get(name);
    if (rows && rows.length > 1) done.push({ name, rows });
    open.delete(name);
  };
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].out;
    if (!name || /^(?:RAM|FLASH) /.test(name)) continue;
    const chain = open.get(name);
    if (chain && mentions(lines[i].expr, name)) {
      chain.push(i);
      continue;
    }
    close(name);
    open.set(name, [i]);
  }
  for (const name of [...open.keys()]) close(name);
  return done.sort((a, b) => a.rows[0] - b.rows[0]);
}

/**
 * One relation between rows of a block, with the gutter lane it runs in.
 *
 * `feeds` is one row assigning what later rows read. `writes` is the other
 * relation a list of formulas hides completely: several rows that are
 * successive values of ONE quantity.
 *
 * One producer, one lane, however many rows read it. Drawing a fan-out as
 * separate rails is what made the gutter unaffordable: `rf_soll_temp` feeds
 * three rows of `rf_soll_calc` and took three lanes to say so.
 */
export interface RowLink {
  kind: "feeds" | "writes";
  name: string;
  /** The row the value leaves. */
  from: number;
  /** The rows it lands on, and which condition of each reads it, if any. */
  targets: { row: number; viaGuard?: number }[];
  lane: number;
}

function linkSpan(l: { from: number; targets: { row: number }[] }): { from: number; to: number } {
  return { from: l.from, to: Math.max(l.from, ...l.targets.map((t) => t.row)) };
}

/**
 * Every row-to-row relation of one block, laned and budgeted.
 *
 * Called by the picture, which draws these in a box's gutter, and by the
 * listing, which draws them in its own. Both were going to want the same
 * answer, and two implementations of "what feeds what" is the drift this file
 * has already been bitten by once.
 */
export function rowLinks(
  lines: FormattedLine[],
  /**
   * Lanes the caller can afford. A gutter beside a formula can afford ten
   * before it is eating the formula; a view whose whole subject is these
   * relations can afford all of them, and passing Infinity is how it says so.
   */
  budget: number = MAX_RAIL_LANES,
): {
  links: RowLink[];
  /** Lanes the gutter has to be wide enough for. */
  lanes: number;
  /** Relations past the budget: reported, not dropped quietly. */
  hidden: number;
} {
  const chains = writeChains(lines);
  // A chain already draws the hand-off between its own consecutive members, so
  // a feeds rail over the same two rows would be a second line saying it. Only
  // the expression reads are covered: a read in a CONDITION lands on a
  // different line and is a different relation.
  const covered = new Set(
    chains.flatMap((c) => c.rows.slice(1).map((r, k) => `${c.name}:${c.rows[k]}>${r}`)),
  );
  const fans = new Map<string, RowLink>();
  for (const p of linkPairs(lines)) {
    if (p.viaGuard === undefined && covered.has(`${p.name}:${p.from}>${p.to}`)) continue;
    const key = `${p.name}:${p.from}`;
    const fan = fans.get(key) ?? { kind: "feeds" as const, name: p.name, from: p.from, targets: [], lane: 0 };
    fan.targets.push({ row: p.to, viaGuard: p.viaGuard });
    fans.set(key, fan);
  }
  const all: RowLink[] = [
    ...chains.map((c) => ({
      kind: "writes" as const,
      name: c.name,
      from: c.rows[0],
      targets: c.rows.slice(1).map((row) => ({ row })),
      lane: 0,
    })),
    ...fans.values(),
  ];
  const lanes = assignLanes(all.map(linkSpan));
  const links = all.map((l, i) => ({ ...l, lane: lanes[i] })).filter((l) => l.lane < budget);
  return {
    links,
    lanes: links.length ? Math.max(...links.map((l) => l.lane)) + 1 : 0,
    hidden: all.length - links.length,
  };
}

/** Greedy interval colouring, so two rails that overlap never share a lane. */
export function assignLanes(pairs: { from: number; to: number }[]): number[] {
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

interface Placed {
  rows: DiagramRow[];
  guards: DiagramGuard[];
  bands: DiagramBand[];
  elisions: DiagramElision[];
  /** Height of the drawn body, from the first line to the last. */
  bodyH: number;
  /** The widest drawn string, indent included, relative to the depth-0 origin. */
  widest: number;
}

/**
 * Position every row, and bracket the runs of rows that share a condition.
 *
 * WHICH rows share one is `guardTree`'s answer, not this function's: the
 * listing asks the same question of the same lines, and the day the two
 * disagree is the day two views assert different shapes for one block. What is
 * decided here is only where that answer gets drawn.
 *
 * A row's indent is therefore exactly its number of conditions, and everything
 * measured from a row — the box width, a wire's landing point — is measured
 * from `row.x` rather than from the block's own left margin.
 */
function placeLines(
  shown: PlacedLine[],
  names: string[],
  showGloss: boolean,
  textX: number,
  elidedText: (n: number) => string,
): Placed {
  const rows: DiagramRow[] = [];
  const guards: DiagramGuard[] = [];
  const bands: DiagramBand[] = [];
  const elisions: DiagramElision[] = [];
  let widest = 0;
  let y = 30;

  /**
   * Mark the statements passed over between the last drawn row and this one.
   *
   * Called both from `emitRow` and from the condition above a band, so the mark
   * lands ABOVE the condition when the skipped lines came before the branch —
   * putting it under the condition would read as "skipped inside this branch",
   * which is a different and usually false claim. `marked` is what keeps the
   * two calls from drawing it twice.
   */
  let lastSrc: number | null = null;
  let lastDepth = 0;
  let marked = -1;
  const markGap = (src: number, depth: number) => {
    if (src === marked) return;
    marked = src;
    if (lastSrc === null || src - lastSrc <= 1) return;
    const n = src - lastSrc - 1;
    const x = textX + Math.min(lastDepth, depth) * GUARD_INDENT;
    y += ELIDE_STEP;
    const text = elidedText(n);
    widest = Math.max(widest, x - textX + textWidth(text));
    elisions.push({ y, x, n, text });
  };

  const emitRow = (i: number, depth: number, stack: number[]) => {
    const l = shown[i];
    markGap(l.src, depth);
    lastSrc = l.src;
    lastDepth = depth;
    const x = textX + depth * GUARD_INDENT;
    const indent = x - textX;
    const formulaY = y + LINE_STEP;
    const glossY = showGloss && l.gloss ? formulaY + GLOSS_STEP : null;
    y = glossY ?? formulaY;
    widest = Math.max(widest, indent + textWidth(`${l.out} = ${l.shown ?? l.expr}`));
    if (glossY !== null) widest = Math.max(widest, indent + 12 + textWidth(l.gloss ?? ""));
    rows[i] = {
      formulaY,
      glossY,
      x,
      guardYs: [...stack],
      // Drawn clipped, matched whole: a wire finds its row by the symbol, and
      // the symbol does not stop being itself because the box was too narrow.
      out: { ...outToken(l.out, l.notes), name: names[i] },
      // The drawn line is `out` + " = " + expr.
      exprStart: cells(l.out) + 3,
      tokens: tokenize(l.shown ?? l.expr, l.notes),
    };
  };

  const walk = (nodes: readonly GuardNode[], depth: number, stack: number[]) => {
    for (const node of nodes) {
      if (node.kind === "row") {
        emitRow(node.row, depth, stack);
        continue;
      }
      const rows = rowsUnder(node);
      // Measured to the FIRST row of the branch: statements passed over before
      // the condition were passed over before it, not inside it.
      markGap(shown[rows[0]].src, depth);
      const x = textX + depth * GUARD_INDENT;
      y += LINE_STEP;
      guards.push({ y, x, text: node.guard.text, raw: node.guard.raw, depth });
      widest = Math.max(widest, x - textX + textWidth(node.guard.text));
      const top = y;
      walk(node.body, depth + 1, [...stack, top]);
      // A bracket around one row is ink with nothing to bracket: the indent
      // under the condition already says which row it governs.
      if (rows.length > 1) bands.push({ d: `M ${x - BAND_GAP} ${top + 4} V ${y} h 3`, depth });
    }
  };

  walk(guardTree(shown), 0, []);
  return { rows, guards, bands, elisions, bodyH: y - 30, widest };
}

function blockNode(
  node: GraphNode,
  layer: number,
  lines: PlacedLine[],
  opts: {
    collapsed?: boolean;
    more?: number;
    depth: number;
    lang: Lang;
    closed?: boolean;
    inside?: number;
    /** The symbol the picture is drawn around, kept visible in every row. */
    keep?: string;
  },
): DiagramNode {
  const label = displayName(node.name, "func");
  const showGloss = opts.depth === 0;
  // A neighbour is context; letting one grow to the focus block's width makes
  // the column ragged and the wires long for no gain in what it tells you.
  const maxWidth = opts.depth === 0 ? 620 : 420;

  // The rail gutter has to be settled before the text is clipped, because it
  // takes width away from the text — hence the links first, on unclipped lines.
  const { links, lanes: laneCount, hidden: hiddenLinks } = rowLinks(lines);
  // The gutter is on the RIGHT now, beside the result column. Every link in it
  // starts at a result and every result is in that column, so the departures
  // are one short stub instead of a run back across the whole formula.
  // The gutter is on the LEFT, beside the assigned-to names: a row reads
  // `out = expr`, so every link in the gutter starts at a name that is already
  // at the left margin and lands on an operand further along the same line.
  const gutter = laneCount ? RAIL_MARGIN + laneCount * RAIL_LANE : 0;
  const textX = PAD + gutter;
  // The guard indent takes width away too, and it is known before the clip for
  // the same reason the gutter is: a row's depth is just its number of guards.
  const budgetAt = (depth: number) => cellBudget(maxWidth - gutter - depth * GUARD_INDENT);

  const shown = lines.map((l) => {
    const budget = budgetAt(l.guardParts?.length ?? 0);
    // The assigned-to name gets a budget of its own. It never had one:
    // `clipExpression` divided what was left AFTER the name, and floored the
    // remainder at ten cells — so a statement assigning to
    // `p_saug_ad_ring_buffer.IOFlag[p_saug_ad_loop_counter]` (52 cells) ran out
    // through the right border before its expression began. Six tenths, so a
    // long name can dominate a line without erasing what it is set to.
    const drawnOut = clipAround(l.out, Math.max(12, Math.floor(budget * 0.6)), opts.keep);
    return {
      ...l,
      out: drawnOut,
      shown: clipExpression(drawnOut, l.expr, budget, opts.keep),
      // A condition is clipped to the width at ITS depth, not at the depth of
      // the rows under it: the header sits one level out from what it governs.
      guardParts: l.guardParts?.map((p, d) => ({ ...p, text: clipGuard(p.text, budgetAt(d)) })),
      guard: l.guard ? clipGuard(l.guardGloss ?? l.guard, budget) : undefined,
      guardGloss: l.guardGloss ? clipGuard(l.guardGloss, budget) : undefined,
      gloss: l.gloss ? clipGloss(l.gloss, budget) : undefined,
    };
  });

  const placed = placeLines(
    shown,
    lines.map((l) => l.out),
    showGloss,
    textX,
    (n) => `⋯ ${n} ${t(opts.lang, "elidedUnit")}`,
  );
  // Three different silences, and the box has to tell them apart: the body is
  // in the app and CODE will quote it, the body was never produced, or
  // everything this block has is folded away and one control brings it back.
  // Measured over the artifact: 110, 1,061 and 83.
  const empty = lines.length || opts.closed
    ? undefined
    : node.stmts?.length
      ? ("allPlumbing" as const)
      : node.hasCode
        ? ("sourceOnly" as const)
        : ("noFormula" as const);
  const { w, h } = blockSize(
    label,
    placed,
    lines.length,
    (opts.more ?? 0) > 0,
    // A shut box is a name, so it is sized like one — the width cap that keeps
    // a neighbour from growing to the focus block's width does not apply.
    opts.closed ? 300 : maxWidth,
    gutter,
    Boolean(empty) && !opts.closed,
    Boolean(opts.closed),
  );
  // Which rows are about the selection. Marked after placement, on the DRAWN
  // text: a row whose mention of it was clipped away is not a row the reader
  // can act on, and `clipAround` is what stops that happening.
  if (opts.keep) {
    const wanted = opts.keep.toLowerCase();
    for (const row of placed.rows) {
      row.subject =
        row.out.name?.toLowerCase() === wanted ||
        (row.tokens ?? []).some((t) => t.name?.toLowerCase() === wanted);
    }
  }

  const laneX = (k: number) => PAD + RAIL_MARGIN / 2 + k * RAIL_LANE;
  /** Where a row's assigned-to name begins — the left end of the drawn line. */
  const outStart = (row: DiagramRow) => row.x;
  /** Where an operand begins, in the same row. */
  const operandX = (row: DiagramRow, token: Token) =>
    row.x + (row.exprStart + token.cell) * CHAR_W;

  const rails: DiagramRail[] = [];
  /** The lane a value leaves a row by: under the name it was written to. */
  const leaves = (baseline: number) => baseline + RUN_BELOW;
  /** The lane it arrives by: over the symbol that reads it. */
  const arrives = (baseline: number) => baseline - RUN_ABOVE;
  /** A stub that lands on something, ending in a short drop onto it. */
  const head = (lane: number, baseline: number, x: number) =>
    `M ${lane} ${arrives(baseline)} H ${x} V ${baseline - DROP_TO}`;

  links.forEach((link) => {
    const lane = laneX(link.lane);

    if (link.kind === "writes") {
      const rows = [link.from, ...link.targets.map((t) => t.row)].map((r) => placed.rows[r]);
      if (rows.some((r) => !r)) return;
      // One vertical past every row that writes the quantity, and an arrow into
      // each one after the first. The arrows are what make it read as one value
      // being carried forward rather than as three rows that happen to agree.
      const arrivals = rows.slice(1);
      rails.push({
        kind: "writes",
        name: link.name,
        d: `M ${outStart(rows[0])} ${leaves(rows[0].formulaY)} H ${lane} V ${arrives(
          arrivals[arrivals.length - 1].formulaY,
        )}`,
        heads: arrivals.map((r) => head(lane, r.formulaY, outStart(r))),
      });
      return;
    }

    const src = placed.rows[link.from];
    if (!src) return;
    // A read in a condition lands on the condition's own line, one indent out
    // from the rows under it. A read in an expression lands on the operand
    // itself — but clipping may have taken that text away, and a rail into text
    // that is no longer there would point at nothing.
    const points = link.targets.flatMap((t) => {
      const row = placed.rows[t.row];
      if (!row) return [];
      if (t.viaGuard !== undefined) {
        const gy = row.guardYs[t.viaGuard];
        return gy === undefined
          ? []
          : [{ baseline: gy, x: textX + t.viaGuard * GUARD_INDENT }];
      }
      // No operand test: `isOperand` is about what can cross the border as a
      // port, and a decompiler temporary cannot — but inside one block it is a
      // real quantity that one row hands to another.
      const token = row.tokens.find((tk) => tk.name === link.name);
      if (!token) return [];
      return [{ baseline: row.formulaY, x: operandX(row, token) }];
    });
    if (!points.length) return;
    // Out under the name the value was written to, along the gutter, and back
    // in OVER each operand that reads it. Every run sits in a gap between two
    // baselines; none of them crosses a glyph.
    const y0 = leaves(src.formulaY);
    rails.push({
      kind: "feeds",
      name: link.name,
      d: `M ${outStart(src)} ${y0} H ${lane} V ${Math.max(
        y0,
        ...points.map((p) => arrives(p.baseline)),
      )}`,
      heads: points.map((p) => head(lane, p.baseline, p.x)),
    });
  });

  return {
    // Keyed by node id, not by name. 128 function names exist on BOTH banks —
    // `dpr_sync` among them — so a name-keyed id gave the two processors' copies
    // the same identity, and the `drawn` set below then skipped the second one
    // outright. The block that carries every value between the two CPUs could
    // not appear twice in one picture, which is exactly what it has to do.
    id: `L${layer}:${node.id}`,
    key: node.id,
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
    closed: opts.closed,
    inside: opts.inside,
    moreLines: opts.more,
    depth: opts.depth,
    showGloss,
    hiddenLinks,
    rows: placed.rows,
    guards: placed.guards,
    bands: placed.bands,
    elisions: placed.elisions,
    textX,
    rails,
    empty,
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
  back?: boolean;
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
  const depth = clamp(opts.depth ?? 1, 1, MAX_DEPTH);
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
  /**
   * Loops that would close if the picture reached one step further.
   *
   * Measured, not guessed: at the edge of the walk we already look up what
   * comes next, and a "next" that is ALREADY on screen is a circle whose last
   * link is just outside the view. Worth counting because the picture cannot
   * draw it and, without being told, the reader reads an empty result as "this
   * is not in a loop". `kf_rf_soll` is exactly that case — the map the tuner
   * spends its time in shows no feedback at DEPTH 1 and twelve wires at 2.
   */
  let loopsBeyond = 0;

  // ---- what the picture is built around ----------------------------------
  //
  // A block is its own subject. A parameter is not a computation, so what it
  // makes sense to draw around it is every block that uses it — ALL of them.
  // Picking the best one is what used to happen on the way in, and picking is
  // exactly how `rf_sk_wdk_calc` stayed off every picture of KF_RF_SOLL.
  /**
   * Shut by default, opened one at a time.
   *
   * The picture used to draw every block's formulas at once. Nine boxes of
   * twelve lines each is a hundred lines of recovered C on one canvas, and the
   * answer to "what talks to what" — which is the only question this view is
   * for — was buried under the answer to "what does each one compute", which
   * is what the other two views are for.
   *
   * Shut, a box is its name and its size. The network reads as a network, the
   * canvas is small enough that DEPTH 3 fits where DEPTH 1 used to, and the
   * two things built on top of reaching further — the return wires and the
   * sensors and actuators at the ends — start appearing in the picture instead
   * of only in the numbers underneath it.
   *
   * Including the block that was asked about. It was the one exception, on the
   * reasoning that it is the box you came for — but it is also the largest, so
   * it filled the pane and the network was pushed off the edges, which is the
   * same complaint one box smaller. What is inside a function is what the
   * FUNCTION and CODE views are; this one answers what connects to what.
   *
   * Deliberately NOT tied to ALL. ALL means "stop capping how many neighbours
   * and ports fit" and it is ON by default, so hanging the boxes off it opened
   * every one of them on a fresh load — which is the state the reader reported,
   * and the state every measurement in this file's pins had been taken in.
   * They are two different acts and they are two different controls now; the
   * text of every block at once is what the CODE view is.
   */
  const openBlocks = opts.openBlocks ?? false;

  const paramFocus = focus.t !== "func";
  /**
   * The spelling of the subject as a FORMULA writes it.
   *
   * Passed to every box so a clip cannot cut it away — the one row that is
   * about the reader's selection is the last row a box should be allowed to
   * truncate. `codeName`, not the display label: the label can carry a suffix
   * the code never uses.
   */
  const keep = paramFocus ? codeName(g, focus) : undefined;
  /** The location the subject is, when the subject is a quantity. */
  const subjectSignal = paramFocus ? signalOf(g, codeName(g, focus), focus.bank).key : "";
  const subjects = paramFocus ? usersOf(g, focus) : [focus];
  if (!subjects.length) return null;

  const drawn = new Set<string>(subjects.map((n) => n.id));
  /**
   * The box each block already has.
   *
   * `drawn` alone could only answer "is it here", and the answer was used to
   * skip the block AND the wire — which is why the pictures had no feedback in
   * them. A block that is both upstream and downstream of the subject was
   * drawn once, on whichever side the spread reached first, and the wire that
   * would have closed the loop was never made. Holding the box makes the
   * second wire reachable while the box still happens once.
   */
  const boxOf = new Map<string, DiagramNode>();
  /** Callees, with the box that calls them: the wire needs both ends. */
  const calledBlocks: { p: Port; into: DiagramNode }[] = [];

  /** Wires already made, so a loop is not drawn twice as the same line. */
  const wireKeys = new Set<string>();
  const wire = (w: Wire): void => {
    const key = `${w.from} ${w.to} ${w.back ? 1 : 0}`;
    if (wireKeys.has(key)) return;
    wireKeys.add(key);
    wires.push(w);
  };

  /**
   * A port, reused when that quantity is already in that column.
   *
   * With one subject block this never fired. With several it fires constantly
   * and is the point: `rf_soll_calc` and `rf_sk_wdk_calc` both read N and
   * `aq_rel_rf`, and one box with two wires out of it says they share an input.
   * Two boxes with the same name would also have shared an id, and the wires
   * would have attached to whichever the lookup found first.
   */
  const port = (layer: number, p: Port): DiagramNode => {
    // Matched on the LOCATION, not the spelling. Two banks' copies of `N` are
    // two boxes in the same column, and welding them was the whole defect.
    const existing = (layers.get(layer) ?? []).find((n) => n.key === p.signal);
    return existing ?? push(layer, portNode(p, layer));
  };

  // The parameter itself, one column out from the blocks that read it — on the
  // side a value comes FROM, since the picture runs right to left.
  let anchor: DiagramNode | null = null;
  if (paramFocus) {
    const name = codeName(g, focus);
    const sig = signalOf(g, name, focus.bank);
    anchor = push(
      -1,
      portNode(
        {
          name,
          signal: sig.key,
          shared: sig.shared,
          bank: sig.bank,
          ...classify(g, name, focus.bank),
          alternative: false,
        },
        -1,
      ),
    );
    anchor.target = focus.id;
    // The subject, whatever kind it is, is what depth is measured from.
    anchor.depth = 0;
    anchor.highlight = true;
  }

  const shownSubjects = everything || !paramFocus
    ? subjects
    : subjects.slice(0, MAX_BLOCKS_PER_COLUMN + 1);
  hiddenBlocks += subjects.length - shownSubjects.length;

  // A subject block shows everything it computes; a block that is here because
  // it uses the subject shows the lines that use it. Full formulas for six
  // blocks at once is a wall, and only one of the six is what was asked about.
  const perBlockPorts = paramFocus && !everything ? 4 : maxPorts;

  for (const node of shownSubjects) {
    const isOpen = expanded.has(node.id);
    let lines: PlacedLine[];
    let more: number | undefined;
    const shut = !isOpen && !openBlocks;
    if (shut) {
      lines = [];
      more = undefined;
    } else if (paramFocus) {
      const r = neighbourLines(g, node, subjectSignal, isOpen, ctx, showNoise, everything);
      lines = r.lines;
      more = r.more;
      // Accumulated, not assigned: with a parameter as the subject there are
      // several of these and the control has to know about all of them.
      hiddenNoise += r.noise;
    } else {
      const r = focusLines(node, everything || (opts.showAllLines ?? false), ctx, showNoise);
      lines = r.lines;
      hiddenLines = r.hidden;
      // `+=`, not `=`: the neighbours fold rows away too, and they are built
      // after this. Assigning here meant the last neighbour's count won.
      hiddenNoise += r.noise;
    }
    const bn = push(
      0,
      blockNode(node, 0, lines, {
        collapsed: paramFocus && !isOpen && !everything,
        closed: shut,
        inside: (node.stmts ?? []).length,
        more,
        depth: paramFocus ? 1 : 0,
        lang: ctx.lang,
        keep,
      }),
    );
    boxOf.set(node.id, bn);
    if (!paramFocus) bn.highlight = true;
    if (anchor) {
      // Dashed when the block has no recovered formula: the claim then rests on
      // a measured cross-reference, which is a weaker thing than an assignment.
      wire({ from: anchor.id, to: bn.id, kind: "read", inferred: !node.stmts?.length });
    }

    const { inputs, outputs } = collectPorts(g, node);
    // Ends first. A port cap that drops `pwg1_ad` to make room for a scratch
    // variable removes the only box on the picture that says where the chain
    // begins — and the cap is what made the boundary invisible at DEPTH 1.
    const shownInputs = endsFirst(g, inputs).slice(0, perBlockPorts);
    const shownOutputs = endsFirst(g, outputs).slice(0, perBlockPorts);
    hiddenPorts += inputs.length - shownInputs.length + (outputs.length - shownOutputs.length);

    for (const p of shownInputs) {
      // Called blocks belong on the upstream side: the subject depends on them.
      if (p.kind === "block") {
        if (!paramFocus) calledBlocks.push({ p, into: bn });
        continue;
      }
      // The subject is already drawn, as the subject. Tested on the node it
      // resolves to rather than on the spelling, so an alias cannot slip a
      // second copy of it into the same column.
      if (anchor && (p.target === focus.id || p.name === anchor.key)) continue;
      wire({ from: port(-1, p).id, to: bn.id, kind: "read", alternative: p.alternative });
    }
    for (const p of shownOutputs) {
      wire({ from: bn.id, to: port(1, p).id, kind: "write" });
    }
  }

  /**
   * A quantity a subject block both reads and writes, joined out-column back
   * to in-column.
   *
   * The layout puts columns by ROLE — what goes in on the right, what comes out
   * on the left — so such a quantity is drawn twice, and nothing on screen said
   * the two boxes were one address. That is the shape of the tightest feedback
   * in the ECU: `rf_calc` computes `RF` and reads `RF` back on the next
   * revolution, and the picture drew the two halves side by side with a gap.
   *
   * Nothing is inferred. Ports have been keyed by address since the processors
   * were separated, so equal keys ARE one address.
   *
   * Drawn here rather than left to `spread`, which reaches the same fact from
   * two directions at once — the subject as a writer of its own input, and as a
   * reader of its own output — and would draw it twice, each time one hop short
   * of the loop it is part of.
   */
  const selfLooped = new Set<string>();
  for (const out of layers.get(1) ?? []) {
    if (out.kind !== "signal") continue;
    const back = (layers.get(-1) ?? []).find((n) => n.kind === "signal" && n.key === out.key);
    if (!back) continue;
    selfLooped.add(out.key);
    wire({ from: out.id, to: back.id, kind: "write", back: true });
  }

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
        if (!node || isHelper(node.name)) continue;
        // Already on screen — so this is the SECOND time the chain reaches it,
        // from the other side. Skipping it here is what dropped the feedback:
        // the block is upstream of the subject and downstream of it too, and
        // only the first of those was ever drawn. The box stays single; the
        // wire is made against the box that exists.
        if (drawn.has(node.id)) {
          const box = boxOf.get(node.id);
          // Unless the loop is the subject's own, and already drawn as one:
          // `rf_calc` writes `ML` and reads it, so it is found here twice — as
          // a writer of its input and as a reader of its output — and both are
          // the wire `selfLooped` has already drawn, each missing a hop.
          const own = box?.column === 0 && Math.abs(sn.column) === 1 && selfLooped.has(sn.key);
          if (box && box.id !== sn.id && !own) {
            if (sign === -1) wire({ from: box.id, to: sn.id, kind: "write", back: true });
            else wire({ from: sn.id, to: box.id, kind: "read", back: true });
          }
          continue;
        }
        if (picked.has(node.id)) continue;
        picked.add(node.id);
        candidates.push({ node, signal: sn.key });
      }
    }
    // Blocks that touch calibration data are the ones worth the space — and
    // ahead of those, blocks that touch the edge of the ECU. The column cap
    // was dropping exactly the block that reads a sensor, which is the one box
    // that could tell the reader where the chain begins.
    const ends = boundary(g);
    const atEdge = (n: GraphNode) => {
        for (const e of g.out.get(n.id) ?? []) {
            const other = g.byId.get(e.d);
            if (other?.t === "ram" && ends.byKey.has(signalOf(g, other.name, other.bank).key)) return true;
        }
        return false;
    };
    candidates.sort(
        (a, b) => Number(atEdge(b.node)) - Number(atEdge(a.node)) || score(b.node) - score(a.node),
    );
    const shown = candidates.slice(0, blockCap);
    hiddenBlocks += candidates.length - shown.length;

    for (const { node, signal } of shown) {
      if (drawn.has(node.id)) continue;
      drawn.add(node.id);
      const isOpen = expanded.has(node.id);
      const shut = !isOpen && !openBlocks;
      const { lines: nl, more, noise } = shut
        ? { lines: [], more: undefined, noise: 0 }
        : neighbourLines(g, node, signal, isOpen, ctx, showNoise, everything);
      hiddenNoise += noise;
      const bn = push(
        blockLayer,
        blockNode(node, blockLayer, nl, {
          collapsed: !isOpen && !everything,
          closed: shut,
          inside: (node.stmts ?? []).length,
          more,
          depth: level,
          lang: ctx.lang,
          keep,
        }),
      );
      boxOf.set(node.id, bn);
      const sn = (layers.get(signalLayer) ?? []).find((n) => n.key === signal)!;
      const inferred = !node.stmts?.length;
      if (sign === -1) wire({ from: bn.id, to: sn.id, kind: "write", inferred });
      else wire({ from: sn.id, to: bn.id, kind: "read", inferred });
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
          for (const id of (sign === -1 ? chain.writers : chain.readers).get(p.signal) ?? []) {
            const next = g.byId.get(id);
            if (!next || isHelper(next.name)) continue;
            // Already drawn: the chain comes back to a box that is on screen,
            // one link past where the view stops.
            if (drawn.has(next.id)) loopsBeyond += 1;
            else onwards.add(next.id);
          }
        }
        // Positions are assigned after both spreads run, so growing the box
        // for the extra row here is still ahead of layout.
        if (onwards.size) {
          bn.moreBlocks = onwards.size;
          bn.h += FOOTER_STEP;
        }

        // The ends of the ECU are drawn even here, at the edge of the walk.
        //
        // This column gets no port column of its own — the walk stops before
        // building one — and that is where the sensors were. `pwg_calc` and
        // `tan_calc` were both ON the picture of `kf_rf_soll` at DEPTH 3 and
        // the pedal and the intake temperature they read were not, because
        // the boxes that would have carried them were never made. So the
        // boundary ports, and only those, are placed past the last block.
        const ends = boundary(g);
        for (const p of ports[sign === -1 ? "inputs" : "outputs"]) {
          if (p.kind !== "signal" || !ends.byKey.has(p.signal)) continue;
          const edgeLayer = blockLayer + sign;
          const existing = (layers.get(edgeLayer) ?? []).find((n) => n.key === p.signal);
          const pn = existing ?? push(edgeLayer, portNode(p, edgeLayer));
          if (sign === -1) wire({ from: pn.id, to: bn.id, kind: "read" });
          else wire({ from: bn.id, to: pn.id, kind: "write" });
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
      const list = endsFirst(
        g,
        (sign === -1 ? ports.inputs : ports.outputs).filter((p) => p.kind === "signal"),
      );
      for (const p of everything ? list : list.slice(0, 3)) {
        const existing = (layers.get(nextSignalLayer) ?? []).find((n) => n.key === p.signal);
        const pn = existing ?? push(nextSignalLayer, portNode(p, nextSignalLayer));
        if (sign === -1) wire({ from: pn.id, to: bn.id, kind: "read" });
        else wire({ from: bn.id, to: pn.id, kind: "write" });
      }
    }
    spread(nextSignalLayer, sign, level + 1);
  };

  // Callees sit in the first upstream block column, next to the signal writers.
  for (const { p, into } of calledBlocks) {
    const node = p.target ? g.byId.get(p.target) : undefined;
    if (!node || drawn.has(node.id)) continue;
    drawn.add(node.id);
    const isOpen = expanded.has(node.id);
    const shut = !isOpen && !openBlocks;
    const { lines: nl, more, noise } = shut
      ? { lines: [], more: undefined, noise: 0 }
      : neighbourLines(g, node, "", isOpen, ctx, showNoise, everything);
    hiddenNoise += noise;
    const bn = push(-2, blockNode(node, -2, nl, {
      collapsed: !isOpen && !everything,
      closed: shut,
      inside: (node.stmts ?? []).length,
      more,
      depth: 1,
      lang: ctx.lang,
      keep,
    }));
    boxOf.set(node.id, bn);
    wire({ from: bn.id, to: into.id, kind: "call" });
  }

  spread(-1, -1, 1);
  spread(1, 1, 1);

  // A quantity a block both reads and writes stands in two columns — the
  // layout is by role, so it is drawn once as an input and once as an output —
  // and joining those two boxes was the obvious way to say they are one
  // address. It is NOT drawn, because measuring it settled the question: of
  // the 638 such pairs across the 534 pictures, 637 already have a return wire
  // from the block that closes the loop, which says the same thing and also
  // says WHICH block closes it. The one that does not is a struct field the
  // chain does not carry as a signal, and papering over that with a second
  // kind of line is not the fix for it.

  const built = finish(g, layers, wires, {
    focus: focus.id,
    hiddenLines,
    hiddenPorts,
    hiddenBlocks,
    hiddenNoise,
    loopsBeyond,
    paramFocus: paramFocus ? displayName(focus.name, focus.t) : undefined,
    anchor: opts.anchor,
  });
  markSelection(built, opts.highlight);
  markBoundary(g, built);
  return built;
}

/**
 * Mark the boxes that are the edge of the ECU, and count them against the
 * whole list.
 *
 * Done here rather than in `portNode` because it is a fact about the LOCATION,
 * not about how the port was reached — the same register is the same sensor
 * whether it arrived through a formula, a cross-reference or a spread.
 */
function markBoundary(g: Indexed, d: Diagram): void {
  const b = boundary(g);
  const seen = new Set<string>();
  for (const n of d.nodes) {
    const port = b.byKey.get(n.key);
    if (!port) continue;
    n.boundary = port.side;
    seen.add(n.key);
  }
  let inShown = 0;
  for (const k of seen) if (b.byKey.get(k)!.side === "in") inShown += 1;
  d.ends = {
    inShown,
    inTotal: b.inputs.length,
    outShown: seen.size - inShown,
    outTotal: b.outputs.length,
  };
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

/**
 * The same ports, with the ends of the ECU at the front.
 *
 * Stable: equal ports keep the order they arrived in, so promoting a sensor
 * does not shuffle everything else and change the picture underneath a reader.
 */
function endsFirst(g: Indexed, ports: Port[]): Port[] {
  const b = boundary(g);
  if (!ports.some((p) => b.byKey.has(p.signal))) return ports;
  return [...ports].sort((x, y) => Number(b.byKey.has(y.signal)) - Number(b.byKey.has(x.signal)));
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
    loopsBeyond: number;
    paramFocus?: string;
    anchor?: { key: string; y: number };
  },
): Diagram {
  /**
   * Columns are laid out RIGHT to left: layer -1 is a block's inputs and layer
   * +1 its outputs, and a row reads `out = expr` — the value comes from the
   * expression on the right and lands on the name at the left. Drawing the
   * inputs on the left made the box read against its own contents: an output
   * had to cross its whole formula to reach the border it left by, and an input
   * had to cross the result to reach the operand it landed on.
   */
  const indices = [...layers.keys()].sort((a, b) => b - a);
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
      // parallel instead of fanning. Inputs are to the RIGHT of the focus now,
      // so they align left; outputs are to its left and align right.
      const offset = i < 0 ? 0 : i > 0 ? width - n.w : (width - n.w) / 2;
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

  /**
   * A lane under the columns for the return wires, one per BOX they leave.
   *
   * Not one per wire. A block that is on both sides of the subject is usually
   * on both sides for SEVERAL quantities at once — `dpr_sync` for seventeen of
   * them — and a lane each buried the picture under its own returns: measured
   * over the 287 pictures that have any, 1,159 of 2,679 fell past a six-lane
   * budget. Sharing one horizontal run and rising out of it into each port
   * costs one lane per box instead, which measures at most six per picture,
   * and draws the fan the same way the forward wires already draw theirs from
   * a shared mid-line.
   *
   * Lanes are then greedy interval colouring on each trunk's span, widest
   * first, so the long runs settle nearest the columns.
   */
  const backLane = new Map<string, number>();
  const laneEnds: number[] = [];
  let hiddenBack = 0;
  {
    const trunks = new Map<string, { lo: number; hi: number; wires: Wire[] }>();
    for (const w of wires) {
      if (!w.back) continue;
      const a = byId.get(w.from);
      const b = byId.get(w.to);
      if (!a || !b) continue;
      const x1 = a.x + a.w / 2;
      const x2 = b.x + b.w / 2;
      const at = trunks.get(w.from) ?? { lo: Infinity, hi: -Infinity, wires: [] };
      at.lo = Math.min(at.lo, x1, x2);
      at.hi = Math.max(at.hi, x1, x2);
      at.wires.push(w);
      trunks.set(w.from, at);
    }
    const order = [...trunks.entries()].sort((p, q) => q[1].hi - q[1].lo - (p[1].hi - p[1].lo));
    for (const [from, span] of order) {
      let lane = laneEnds.findIndex((end) => end <= span.lo);
      if (lane < 0) {
        if (laneEnds.length >= MAX_BACK_LANES) {
          // Reported rather than stacked: past this the returns are taller
          // than the picture they belong to and no longer separable by eye.
          hiddenBack += span.wires.length;
          continue;
        }
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = span.hi + COL_GAP / 2;
      backLane.set(from, lane);
    }
  }
  const backTop = Math.max(0, ...nodes.map((n) => n.y + n.h)) + PAD;
  if (laneEnds.length) {
    canvasHeight = Math.max(canvasHeight, backTop + laneEnds.length * BACK_LANE + PAD);
  }

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
    // A return wire leaves the BOTTOM of its box and comes back up into the
    // bottom of the other, around the outside. It carries no leader: a leader
    // points at the token inside a row, and this wire is not claiming to reach
    // one — it is saying the two boxes are two ends of one loop.
    const lane = w.back ? backLane.get(w.from) : undefined;
    if (lane !== undefined) {
      const laneY = backTop + (lane + 1) * BACK_LANE;
      const x1 = a.x + a.w / 2;
      const x2 = b.x + b.w / 2;
      edges.push({
        from: w.from,
        to: w.to,
        kind: w.kind,
        signal,
        back: true,
        d: `M ${x1} ${a.y + a.h} V ${laneY} H ${x2} V ${b.y + b.h}`,
      });
      continue;
    }
    // Past the lane budget. Dropping it silently would put the picture back
    // where it started — a loop the reader cannot see and is not told about.
    if (w.back) continue;

    const departure = attach(a, signal, "out");
    const arrival = attach(b, signal, "in");
    // Which border each end leaves and meets is read from where the two boxes
    // ACTUALLY are, not from their layer numbers: a wire can run either way
    // between two columns, and the one case that has always run against the
    // grain is a call, whose callee sits beyond the inputs.
    const leftward = b.x < a.x;
    const x1 = leftward ? a.x : a.x + a.w;
    const y1 = departure !== null ? a.y + departure.y : a.y + a.h / 2;
    const x2 = leftward ? b.x + b.w : b.x;
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
      landed: Boolean(signal && arrival),
      d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
    });

    if (signal && departure) {
      leaders.push({ name: signal, kind: "out", d: `M ${a.x + departure.x} ${y1} H ${x1}` });
    }
    if (signal && arrival) {
      // In under the row, then up into the operand. The rise is what puts the
      // arrowhead on the variable instead of on the border twenty characters
      // away from it.
      leaders.push({
        name: signal,
        kind: "in",
        d: `M ${x2} ${y2} H ${b.x + arrival.x} V ${y2 + RUN_ABOVE - DROP_TO}`,
      });
    }
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
    loopsBeyond: meta.loopsBeyond,
    // Filled by `markBoundary` once the nodes exist.
    ends: { inShown: 0, inTotal: 0, outShown: 0, outTotal: 0 },
    // Summed from the blocks rather than passed in: the lane budget is a
    // property of each box, settled while that box was being built.
    hiddenLinks: nodes.reduce((a, n) => a + (n.hiddenLinks ?? 0), 0),
    hiddenLoops: hiddenBack,
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
  for (const row of node.rows) {
    // Both points are one run BELOW the baseline — the only horizontal lane
    // inside a row with no text in it — and both stop at the NEAR edge of the
    // symbol, the side the wire is coming from. The picture runs right to left,
    // which is the direction `out = expr` already reads in: a result is written
    // on the left of its line and leaves by the left border, and an operand is
    // read on the right of it and is reached from the right border. Stopping at
    // the far edge would run the connector through the word it points at.
    if (side === "out") {
      if (row.out.name !== wanted) continue;
      return { x: row.x, y: row.formulaY + RUN_BELOW };
    }
    // An arrival runs OVER the row, the same way a rail inside the box does:
    // a line under a name means that name is sending, a line over it means it
    // is receiving, and the reader does not have to find the arrowhead first.
    // From the row's own origin: a row inside a guard band is indented, and a
    // point measured from the block's left margin lands that far to its left —
    // under the bracket rather than under the symbol.
    const token = row.tokens.find((t) => t.name === wanted && isOperand(t.role));
    if (!token) continue;
    const end = row.exprStart + token.cell + token.cells;
    return { x: row.x + end * CHAR_W, y: row.formulaY - RUN_ABOVE };
  }
  return null;
}
