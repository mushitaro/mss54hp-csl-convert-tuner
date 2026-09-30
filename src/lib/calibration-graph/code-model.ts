import type { GraphNode, Statement } from "./types";
import type { Indexed } from "./graph";
import { type Diagram, blockChain, outName, rowLinks, usersOfName } from "./diagram-model";
import { type FormatContext, type FormattedLine, formatStatement } from "./logic-format";
import { type Token, outToken, tokenize } from "./expr-tokens";
import { type DecompCorpus, type SourceLine, type SourceToken, sourceLines } from "./decomp";
import { cells } from "./metrics";
import { type GuardNode, guardTree } from "./guard-tree";
import { displayName } from "./names";
import { type StringKey, t } from "./calib-i18n";

/**
 * The same recovered code, read as a listing instead of as a picture.
 *
 * Ghidra shows a function two ways and the community screenshots the second:
 * the Function Graph, which is one function's control flow as connected basic
 * blocks, and the Decompiler, which is C-like pseudocode running top to bottom.
 * The picture this repo draws is neither — it is DATA flow, across functions —
 * and it answers a question the Decompiler cannot. But a formula is easier to
 * read as a line of text than as a box, so this is the other half.
 *
 * ## What it is built from, and what that means it cannot say
 *
 * A recovered statement carries `out`, `expr`, `guards`, `reads`, `calls` and
 * `interp`. There is no address on it, no line number, and no control-flow
 * structure. So:
 *
 *   - no addresses, and therefore nothing to line up against a Listing window;
 *   - no loops and no gotos — `guards` is a conjunction of conditions attached
 *     to one statement, not a block structure;
 *   - the `if` nesting below is RECONSTRUCTED, by grouping consecutive
 *     statements that share a leading condition. That is an inference, and the
 *     same one the picture's guard bands make. Each condition keeps its raw
 *     text so the reading can be checked against the decompiler's own;
- no `else`. `guardTree` produces 8,553 top-level groups over the 1,384
 *     blocks, and 956 of them carry a condition containing `&&` or `||`, where
 *     flipping one comparator is not a negation — so a group cannot be read as
 *     the `else` of the one before it. Two `if`s say less than an `else` and
 *     nothing that is untrue;
 *   - no declarations, no `return`, and not the literal C: `raw` is this tool's
 *     reconstruction of the decompiler's wording, not the text it emitted.
 *
 * ## One row is one line
 *
 * Every entry below occupies exactly one rendered line. That is what lets the
 * view scroll a few thousand statements — `ds2_handler` at DEPTH 3 with SHOW
 * ALL reaches 610 blocks and 3,995 statements — by drawing only the rows that
 * are on screen. Variable-height rows would need measuring before they could
 * be skipped, which defeats the point.
 */
export type CodeLine =
  /** A block's heading: where the listing for one function starts. */
  | {
      kind: "block";
      key: string;
      label: string;
      target: string;
      bank?: string;
      addr?: number;
      /** Statements in this block, whether or not any survived the filters. */
      statements: number;
      /** Distance from the focus, so the focus can be marked as such. */
      depth: number;
    }
  /** `if (…) {` — reconstructed from a condition shared by the rows under it. */
  | { kind: "guard"; depth: number; text: string; raw: string }
  /** `}` — where that shared condition stops applying. */
  | { kind: "close"; depth: number }
  /** `out = expr`, cut into the same tokens the picture colours. */
  | {
      kind: "formula";
      depth: number;
      /** Index of the statement in its block: the line number, and the id the
       *  gutter links are drawn between. */
      row: number;
      /**
       * Other blocks that touch what this line computes.
       *
       * Ghidra's Listing earns its place on this column: not "what does this
       * line say" but "who else cares". Read from what the line WRITES — who
       * else reads that — falling back to the calibration it reads, since
       * `rf_soll_temp = kfu_wint(kf_rf_soll, …)` assigns a local nobody else
       * sees while naming a map that `rf_sk_wdk_calc` also reads.
       */
      xrefs: CodeXref[];
      /** Xrefs past the few that are drawn, reported rather than dropped. */
      moreXrefs: number;
      out: Token;
      /** Where the expression starts, in monospace cells from the row origin. */
      exprStart: number;
      tokens: Token[];
      /** The decompiler's own wording, for checking the rewrite against. */
      raw: string;
    }
  /** The plain-language reading, when one could be built. */
  | { kind: "gloss"; depth: number; text: string }
  /** Something the listing has to say rather than draw. */
  | { kind: "note"; depth: number; text: string }
  /**
   * One line of the decompiler's own C, quoted.
   *
   * This is what a block with no recovered statements shows instead of a note
   * saying it has nothing — for the 110 functions where a text exists. It is
   * deliberately a different row kind rather than a `formula` with the raw
   * string in it: a formula row claims this tool read the statement and can
   * say what it writes, and none of that is true here. The listing is quoting.
   */
  | {
      kind: "source";
      /** Ghidra's own leading whitespace, in monospace cells. */
      indent: number;
      /**
       * Line number within the decompiled function — a real one.
       *
       * The `formula` rows carry an ordinal and say so, because a recovered
       * statement has no position. A quoted line does: it is line `row` of the
       * text, and it can be found in the decompiler at that line.
       */
      row: number;
      tokens: SourceToken[];
      /** A decompiler aside rather than code. */
      comment: boolean;
    }
  /**
   * Where one ring of the picture ends and the next begins.
   *
   * The listing is a walk outwards from the subject, and without these it is a
   * few thousand lines with no way to tell "the thing I picked" from "something
   * four steps away that happens to be on the same signal path".
   */
  | {
      kind: "ring";
      /** 0 is the subject, 1 one block away, and so on. */
      ring: number;
      side: "subject" | "upstream" | "downstream";
      /** Blocks in this ring, so the heading can say how much is under it. */
      blocks: number;
    };

export interface CodeXref {
  label: string;
  /** Node id, so pressing it can make that block the subject. */
  target: string;
}

/**
 * A row-to-row link, in LISTING line numbers.
 *
 * The relation is `linkPairs`/`writeChains` — the same call the picture's
 * gutter rails are drawn from, and the same `assignLanes` colouring, so the two
 * views cannot show different relations for one block. Only the coordinates
 * differ: the picture works in its own pixels, this in line indices.
 */
export interface CodeRail {
  /** Listing line the value leaves from. */
  from: number;
  /** Listing lines it lands on. */
  to: number[];
  lane: number;
  name: string;
  kind: "feeds" | "writes";
}

/** Where one block's listing starts, for the heading that follows the scroll. */
export interface CodeBlockSpan {
  /** Index of the block's heading line. */
  at: number;
  /** One past its last line. */
  end: number;
}

export interface CodeListing {
  lines: CodeLine[];
  /** Blocks listed, and statements in them — what the honesty line reports. */
  blocks: number;
  statements: number;
  rails: CodeRail[];
  /** Lanes the gutter actually needs, so the indent is not paid for nothing. */
  lanes: number;
  /** Blocks drawn as quoted C because no statement was recovered from them. */
  sourced: number;
  /** Links past the lane budget, across every block listed. */
  hiddenLinks: number;
  spans: CodeBlockSpan[];
}

/**
 * The blocks of a diagram, in the order a reader who picked one thing wants
 * them: **the subject first, then outwards**.
 *
 * This was ascending column index — the picture's own reading order, causes
 * before effects, which is right for a picture and wrong here. A listing is
 * arrived at by selecting something, and at DEPTH 3 the ascending order opened
 * on `tan_calc`: a block six columns upstream of what was picked, with the
 * thing that was picked two thousand lines down. The reader is not reading the
 * signal path from one end. They are reading about one thing.
 *
 * So: ring 0 is the subject, ring 1 is one block out, and within a ring what
 * BUILDS the subject comes before what uses it. Blocks sit on even columns —
 * 0, ±2, ±4, ±6 — with the odd ones holding the signals between them.
 *
 * The property the old order had, and which this keeps: raising DEPTH only ever
 * appends. New blocks land in new rings at the end, so what was already being
 * read stays where it was, contiguous, from the top.
 */
export interface Listed {
  target: string;
  depth: number;
  ring: number;
  side: "subject" | "upstream" | "downstream";
}

function listed(d: Diagram): Listed[] {
  return d.nodes
    .filter((n) => n.kind === "block" && n.target)
    .slice()
    .sort(
      (a, b) =>
        Math.abs(a.column) - Math.abs(b.column) ||
        Math.sign(a.column) - Math.sign(b.column) ||
        a.y - b.y,
    )
    .map((n) => ({
      target: n.target!,
      depth: n.depth ?? 0,
      ring: Math.abs(n.column) >> 1,
      side: n.column === 0 ? "subject" : n.column < 0 ? "upstream" : "downstream",
    }));
}

/** Cross-references drawn beside a row before the rest become a count. */
const MAX_XREFS = 3;

/**
 * Emit one block's statements, with their conditions grouped into `if`s, and
 * report where its own rows hand values to each other.
 *
 * The grouping is `guardTree`'s and the relations are `rowLinks`' — the same
 * two calls the picture uses, so neither view can claim a shape or a relation
 * the other denies. What differs is only the coordinate system: the picture
 * works in pixels inside a box, this in listing line numbers.
 */
function emitBlock(
  out: CodeLine[],
  block: GraphNode,
  lines: FormattedLine[],
  showGloss: boolean,
  xref: (st: Statement, blockId: string) => { xrefs: CodeXref[]; more: number },
  stmts: Statement[],
  lang: FormatContext["lang"],
  source?: SourceLine[],
): { rails: CodeRail[]; lanes: number; hidden: number; sourced: boolean } {
  if (!lines.length) {
    // Nothing was parsed out of this function. There are three reasons for
    // that and they are not interchangeable, so the listing distinguishes
    // them rather than printing one sentence over all 713 empty boxes:
    //
    //   the decompiler's text is here      quote it — this is the 321
    //   it was never asked for             say so — nobody is, any more
    //   the block has no code at all       say that instead
    //
    // The middle case is empty now that the exporter has stopped filtering by
    // name. It is kept because a rebuild could lose bodies again, and a blank
    // box with no reason given is what this whole branch exists to prevent.
    //
    // Quoting is not a fallback for the first case, it is the answer: the
    // reader wanted the function's body and the body is what arrives.
    if (source?.length) {
      for (let i = 0; i < source.length; i++) {
        const line = source[i];
        out.push({
          kind: "source",
          indent: line.indent,
          row: i + 1,
          tokens: line.tokens,
          comment: line.comment,
        });
      }
      return { rails: [], lanes: 0, hidden: 0, sourced: true };
    }
    // The SAME three sentences the box uses, from the same keys. They were two
    // English literals here — "no formula recovered" and "no code" — which put
    // the listing and the box beside it on different stories, and said "no
    // code" about a function the binary certainly holds code for. What 0xE66
    // has no code in is Ghidra's output, not the ECU.
    const why: StringKey = stmts.length
      ? "blockAllPlumbing"
      : block.hasCode
        ? "blockSourceMissing"
        : "blockNoFormula";
    out.push({ kind: "note", depth: 0, text: t(lang, why) });
    return { rails: [], lanes: 0, hidden: 0, sourced: false };
  }

  /** Statement index -> the listing line it was drawn on. */
  const at = new Map<number, number>();
  const walk = (nodes: readonly GuardNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.kind === "row") {
        const l = lines[node.row];
        const st = stmts[node.row];
        const { xrefs, more } = st ? xref(st, block.id) : { xrefs: [], more: 0 };
        at.set(node.row, out.length);
        out.push({
          kind: "formula",
          depth,
          row: node.row,
          out: outToken(l.out, l.notes),
          exprStart: cells(l.out) + 3,
          tokens: tokenize(l.expr, l.notes),
          raw: l.raw,
          xrefs,
          moreXrefs: more,
        });
        if (showGloss && l.gloss) out.push({ kind: "gloss", depth, text: l.gloss });
        continue;
      }
      out.push({ kind: "guard", depth, text: node.guard.bare, raw: node.guard.raw });
      walk(node.body, depth + 1);
      out.push({ kind: "close", depth });
    }
  };
  walk(guardTree(lines), 0);

  const { links, lanes, hidden } = rowLinks(lines);
  const rails: CodeRail[] = [];
  for (const link of links) {
    const from = at.get(link.from);
    // A row can be missing from `at` only if it was never drawn, which cannot
    // happen here — the listing draws every statement. Checked anyway: a rail
    // to a line that is not there would point into another block.
    if (from === undefined) continue;
    const to = link.targets.map((t) => at.get(t.row)).filter((v): v is number => v !== undefined);
    if (!to.length) continue;
    rails.push({ from, to, lane: link.lane, name: link.name, kind: link.kind });
  }
  return { rails, lanes, hidden, sourced: false };
}

/**
 * Build the listing for everything the picture is currently showing.
 *
 * Every statement of every block, not the extract the boxes draw: the picture
 * ranks and truncates because a box has a size, and this does not.
 */
export function buildCode(
  g: Indexed,
  d: Diagram,
  ctx: FormatContext,
  opts: { showGloss?: boolean; corpus?: DecompCorpus | null } = {},
): CodeListing {
  const lines: CodeLine[] = [];
  const rails: CodeRail[] = [];
  const spans: CodeBlockSpan[] = [];
  let statements = 0;
  let lanes = 0;
  let hiddenLinks = 0;
  let sourced = 0;
  const seen = new Set<string>();
  let blocks = 0;

  /**
   * Who else touches what a row computes.
   *
   * From what the line WRITES — who else reads that — and from the calibration
   * it reads, because a great many rows assign a decompiler temporary that
   * nobody outside the block has ever heard of while naming a map that several
   * blocks share. `rf_soll_temp = kfu_wint(kf_rf_soll, …)` is exactly that
   * shape, and `kf_rf_soll` is the half of it worth cross-referencing.
   */
  const chain = blockChain(g);
  const xref = (st: Statement, blockId: string): { xrefs: CodeXref[]; more: number } => {
    const ids: string[] = [];
    const add = (id: string) => {
      if (id !== blockId && !ids.includes(id)) ids.push(id);
    };
    for (const id of chain.readers.get(outName(st)) ?? []) add(id);
    for (const r of st.reads) {
      for (const u of usersOfName(g, r)) add(u.id);
    }
    const xrefs = ids.slice(0, MAX_XREFS).map((id) => ({
      label: displayName(g.byId.get(id)!.name, "func"),
      target: id,
    }));
    return { xrefs, more: ids.length - xrefs.length };
  };

  // A block can be drawn twice in one picture — once as a neighbour of two
  // different signals — and listing it twice would be two copies of one
  // function, not two functions. Deduped BEFORE the rings are counted, so a
  // heading never promises a block the listing then skips.
  const order = listed(d).filter((e) => {
    if (seen.has(e.target) || !g.byId.has(e.target)) return false;
    seen.add(e.target);
    return true;
  });
  const ringSize = new Map<string, number>();
  for (const e of order) {
    const key = `${e.ring}:${e.side}`;
    ringSize.set(key, (ringSize.get(key) ?? 0) + 1);
  }

  let openRing = "";
  for (const { target, depth, ring, side } of order) {
    const key = `${ring}:${side}`;
    if (key !== openRing) {
      openRing = key;
      lines.push({ kind: "ring", ring, side, blocks: ringSize.get(key) ?? 0 });
    }
    const node = g.byId.get(target)!;
    blocks += 1;
    const stmts = node.stmts ?? [];
    statements += stmts.length;
    lines.push({
      kind: "block",
      key: node.name,
      label: displayName(node.name, "func"),
      target,
      bank: node.bank,
      addr: node.addr,
      statements: stmts.length,
      depth,
    });
    const at = lines.length - 1;
    // Parsed only for the blocks that need it — a listing at DEPTH 3 reaches
    // 610 blocks, and tokenizing every one of their texts to then draw the
    // statements instead would be the corpus's whole cost paid for nothing.
    const text = stmts.length ? undefined : opts.corpus?.texts[target];
    const built = emitBlock(
      lines,
      node,
      stmts.map((st) => formatStatement(st, ctx)),
      opts.showGloss ?? true,
      xref,
      stmts,
      ctx.lang,
      text ? sourceLines(g, node.bank ?? "master", text) : undefined,
    );
    rails.push(...built.rails);
    lanes = Math.max(lanes, built.lanes);
    hiddenLinks += built.hidden;
    if (built.sourced) sourced += 1;
    spans.push({ at, end: lines.length });
  }

  return { lines, blocks, statements, rails, lanes, hiddenLinks, spans, sourced };
}
