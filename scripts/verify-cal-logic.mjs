// Checks the logic diagram's formatting and layout against the whole artifact.
//
// The failure this exists to catch is specific and has happened three times in
// this code: the layout measures one string and the renderer draws a different
// one, so text runs out through a box border. `clipExpression` fixed it for the
// formula, `cellBudget` fixed it again for guards and glosses on narrow blocks,
// and clipping the assigned-to name fixed it a third time. Now that wires
// attach to a token INSIDE a box, a disagreement no longer just looks wrong —
// it points at the wrong variable. So the invariant is asserted here, over all
// 534 blocks, rather than left to be noticed.
//
// Counts are PINNED to the shipped artifact, like verify-cal-catalog: a re-sync
// that changes them should change this file in the same commit, deliberately.
//
// Runner: node --experimental-strip-types --import ./scripts/ts-resolve.mjs

import { readFileSync } from 'node:fs';
import { index } from '../src/lib/calibration-graph/graph.ts';
import { makeContext, formatStatement, glossFor } from '../src/lib/calibration-graph/logic-format.ts';
import {
    blockChain, buildDiagram, codeName, linkPairs, signalOf, usersOf, writeChains,
} from '../src/lib/calibration-graph/diagram-model.ts';
import { displayName } from '../src/lib/calibration-graph/names.ts';
import { buildCode } from '../src/lib/calibration-graph/code-model.ts';
import { buildInside } from '../src/lib/calibration-graph/inside-model.ts';
import { boundary, reach } from '../src/lib/calibration-graph/boundary.ts';
import { systemMap } from '../src/lib/calibration-graph/system-map.ts';
import { branchCount, guardTree, maxNesting } from '../src/lib/calibration-graph/guard-tree.ts';
import { tokenize } from '../src/lib/calibration-graph/expr-tokens.ts';
import { buildAddressIndex, resolveAddress } from '../src/lib/calibration-graph/address.ts';
import { CHAR_W, textWidth } from '../src/lib/calibration-graph/metrics.ts';

const PIN = {
    statements: 14524,
    guards: 16533,
    /** Guards read as a condition rather than left as C. */
    guardsPhrased: 13617,
    /** DAT_/UNK_/PTR_ occurrences, by which tier named them. */
    addrExact: 3691,
    addrInferred: 5488,
    addrRegion: 4555,
    blocks: 1384,
    /** Statements whose reading has to describe a filter rather than a lookup. */
    filterStatements: 86,
    /** The listing, over every block taken as the focus at default settings. */
    listedStatements: 230415,
    /** Three more than it was: the ring bands the listing now opens each
     *  stretch with — subject, then what builds it, then where it goes. */
    longestListing: 2110,
    /**
     * Guard grouping, summed over every block drawn as the focus.
     *
     * `conditionLines` under `guardedRows` is the whole point: that gap is the
     * repetition the picture no longer draws. If a change makes them equal, the
     * grouping has stopped grouping.
     */
    guardedRows: 44213,
    conditionLines: 40397,
    brackets: 14512,
    feeds: 19239,
    chains: 5584,
    chainedRows: 2783,
    elisions: 15149,
    /**
     * Links the gutter had no lane for, over every block drawn with SHOW ALL.
     *
     * Reported on screen rather than dropped quietly. Zero in the default
     * twelve-line view; this number is what the stress setting costs.
     */
    overLanes: 681,
    /**
     * The two processors, and what actually crosses between them.
     *
     * Every count above this line moved when signals stopped being keyed by
     * NAME: the master and the slave are separate CPUs with zero edges between
     * them in the graph, yet 340 RAM names exist on both banks and the tool
     * welded them, so 4,752 of 16,000 writer/reader pairs crossed processors
     * and 1,053 of those were between two different addresses that merely share
     * a spelling. Keying by location instead removes exactly those, and the
     * pictures lose the neighbours the false edges were dragging in — which is
     * why the drawn-row, rail and listing totals all fall together.
     */
    crossBankPairs: 951,
    /** Writes `dpr_sync[master]` registers. It registered NONE: every one of
     *  them assigns through a pointer, and the leading underscore that renders
     *  made `classify` answer "unknown". 118 writes were lost artifact-wide. */
    dprSyncWrites: 17,
    underscoreWrites: 261,
    /**
     * The default view is a NETWORK: names and wires, and nothing else.
     *
     * Every block box starts shut. Open, nine boxes of twelve lines each is a
     * hundred lines of recovered C on one canvas, and the answer to "what talks
     * to what" — the only question this view is for — was buried under the
     * answer to "what does each one compute", which is what the other two views
     * are for. The reader opens the one they want.
     *
     * With no exception, not even the block that was asked about — that one
     * was the largest box on the picture, so leaving it open filled the pane
     * and pushed the network off the edges. What is inside a function is what
     * the FUNCTION and CODE views are for.
     */
    shutBoxes: 7431,
    /**
     * Rows that mention the selection, and how many still lose it to the clip.
     *
     * The clip runs from the right, which is fine until what falls off the end
     * is the reason the box is on the picture. `KL_V_MAX_GANG` opened
     * `md_limiter_calc` to a row reading
     *
     *     MD_IND_VMAX = MD_IND_VMAX + (((K_MD_I_VMAX × ({…
     *
     * — stopping one character before the name. `clipAround` slides the window
     * instead of cutting the tail.
     *
     * The five that still lose it are names longer than a whole row of the box
     * (`k_ask_flap_driver_energised_cycles_threshold` is 44 characters), where
     * there is nothing to slide to. Pinned rather than rounded away: if it ever
     * grows, the window has stopped working rather than the names having got
     * longer.
     */
    subjectRows: 1695,
    subjectRowsKept: 1683,
    /**
     * The feedback, and the fact that it is all of it.
     *
     * Engine control is a loop — the throttle moves the air, the air is
     * measured, the measurement moves the throttle — and the picture drew none
     * of it. `spread` walked upstream and downstream through ONE `drawn` set,
     * so a block on both sides of the subject was drawn on whichever side the
     * walk reached first and the wire that closed the circle was never made.
     *
     * `loopsHidden` is the one that matters: at DEPTH 1, the default and what
     * someone meeting the picture is looking at, EVERY return wire is drawn.
     * The lane budget is set from the widest picture, not from taste.
     */
    loopWires: 3217,
    loopPictures: 663,
    loopsHidden: 0,
    /** Of those: a quantity a block reads and writes, against a longer circle. */
    loopSelf: 1306,
    loopThroughBlock: 1911,
    /** Boxes carrying a wire each way — one box, not the two it would have been. */
    loopBoxes: 4360,
    /** Deepest lane stack under a picture, against the budget of 14. */
    loopLanes: 14,
    /**
     * Boxes at the edge that say the chain goes on, and the blocks they count.
     *
     * Pinned because it silently stopped: keying signals by location left this
     * one lookup asking the chain about a NAME, which is never a key, so every
     * box answered "nothing further" — and a box with nothing after it reads as
     * the end of the chain rather than the edge of the view.
     */
    chainContinues: 4084,
    onwardBlocks: 37767,
    /**
     * The same thing from the side a reader actually starts on.
     *
     * Picking a MAP is the common way in, and 4,273 of the 4,787 pictures a
     * parameter can draw are inside a loop — so this is not a corner of the
     * artifact that the feedback was missing from, it is nearly all of it.
     * 207 of 22,318 fall past the lane budget and are reported in HIDDEN.
     */
    paramLoopPictures: 4284,
    paramLoopWires: 22644,
    paramLoopsHidden: 145,
    /**
     * The split that matters to a person, rather than to the artifact.
     *
     * Of the 2,236 CALIBRATION parameters, 1,758 show a loop at DEPTH 1 — but
     * `kf_rf_soll`, `kf_rf_soll_kath`, `KF_RG_M` and `K_KVA_NORM`, which is
     * where tuning actually happens, are all in the 276 that show none until
     * DEPTH 2. A picture that draws nothing and says nothing reads as "not part
     * of a loop", and for those maps that is false, so the view names the depth
     * that closes it.
     *
     * The hint is pinned in both directions. It is right 275 of the 276 times
     * it appears — the exception is `K_TI_GA`, where the deeper picture's block
     * cap drops the box that would have closed it — and there are ZERO cases
     * where a loop opens up at DEPTH 2 without having been announced.
     */
    /**
     * The two ends of the ECU, as a list.
     *
     * This is the one part of the tool not derived from decompiled text at all
     * — it is the processor's memory map — so it is a list rather than an
     * estimate, and a re-vendor that moves it has to say so here.
     *
     *   21  inputs   15 analogue (pedal, both throttles, both lambdas, the
     *                temperatures, the pressures, knock), 4 crank-angle,
     *                2 timer captures. None of them writable by the ECU.
     *   33  outputs  injection pulses, VANOS valves, fuel pump, PWM.
     *    2  suspect  `PSP1_HIGH_TIME` and `PSP1_END_ANGLE` on the MASTER, which
     *                the write-degree rule calls inputs while the slave's copy
     *                of the same register is written. An injector pulse is not
     *                something the engine tells the ECU, so the master's write
     *                is there and was not recovered. Reported, never counted.
     */
    boundaryIn: 21,
    boundaryOut: 37,
    boundarySuspect: 2,
    /**
     * Pictures that actually contain an end.
     *
     * 28 before the boxes were shut, and the jump to 127 is not the shutting —
     * it is the two caps the shutting exposed. A picture reached the block that
     * reads `pwg1_ad` and then dropped the pedal itself twice over: the
     * per-block port cap ranked it against scratch variables, and the outermost
     * block column was never given a port column at all, because the walk stops
     * before building one. Ends are ranked first now, and the boundary ports —
     * only those — are drawn past the last block.
     */
    picturesWithAnEnd: 230,
    /**
     * The map's own coverage, which is the first thing it has to say.
     *
     * 473 of 1,705 blocks can be tied to one of BMW's 39 Funktionsrahmen
     * sections, by the parameters and signals they touch. The other 1,232 are
     * the largest region on the map and are drawn at that size.
     */
    mapPlaced: 473,
    mapUnplaced: 1232,
    mapRegions: 34,
    paramsLoopAtOne: 1827,
    paramsLoopHintShown: 290,
    paramsLoopHintRight: 277,
    paramsLoopHintMissed: 0,
    /**
     * The `if` nesting, as `guardTree` reconstructs it over the whole artifact.
     *
     * Pinned here because this one inference is now shared by all three views.
     * It used to be implemented twice - once for the picture's bands, once for
     * the listing's braces - and two copies of an inference is two answers
     * waiting to differ. If this number moves, every view moved with it.
     */
    branchGroups: 6204,
    deepestNesting: 9,
    /** Parameters with more than one block using them: what `owningBlock` hid. */
    sharedParams: 481,
    /** The inside view, over every block, in both readings. */
    insideEdges: 24610,
    widestInside: 23518,
    /** Shared parameters whose picture actually grows with DEPTH; see below. */
    depthReaches: 451,
    /**
     * Parameter pictures that fold at least one machine-detail row away.
     *
     * This was 0 for every parameter — `hiddenNoise` was assigned in the block
     * branch only — so the PLUMBING control never rendered for any of them,
     * while the setting it controls still changed 1,963 of their pictures. A
     * control that does something with nowhere to press it.
     */
    paramsWithFoldedPlumbing: 2262,
    /**
     * Empty block boxes, by the reason they are empty.
     *
     * 1,254 of the 1,705 functions draw a box with no formulas in it, and the
     * picture used to say nothing at all about why — which reads as a tool that
     * failed rather than as a fact about the binary.
     *
     * THREE different facts, not two. `noFormula` was 1,171 and said the
     * decompiler's output "was never parsed" about all of them; for 110 that
     * was untrue, because the text exists and now ships. Those 110 are
     * `sourceOnly` and CODE quotes their body. verify:cal-decomp holds the
     * three populations and the copy that quotes them.
     */
    emptyNoFormula: 0,
    emptySourceOnly: 321,
    emptyAllPlumbing: 390,
    /** Functions whose recovered code has no branch in it at all. */
    flatFunctions: 396,
};

/** Does the graph know this name at all? */
const graphName = (n) => raw.nameIndex[n] ?? raw.nameIndex[n.toLowerCase()];

let fails = 0;
function check(label, ok, detail = '') {
    if (ok) { console.log(`  ok  ${label}`); return; }
    fails += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const raw = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));
const g = index(raw);

// --------------------------------------------------------------------------
// formatting, in both wordings
// --------------------------------------------------------------------------

for (const plain of [true, false]) {
    const label = plain ? 'PLAIN' : 'AS DECOMPILED';
    const ctx = makeContext(raw.nodes, raw.nameIndex, g.byId, raw.glossary, 'ja', plain);
    let statements = 0;
    let guards = 0;
    let phrased = 0;
    let roundTrip = 0;
    let threw = null;
    let inferredLeak = 0;

    for (const node of raw.nodes) {
        for (const st of node.stmts ?? []) {
            let line;
            try {
                line = formatStatement(st, ctx);
            } catch (err) {
                threw ??= `${node.name}: ${err.message}`;
                continue;
            }
            statements += 1;
            guards += st.guards.length;
            if (line.guardGloss) phrased += st.guards.length;
            const toks = tokenize(line.expr, line.notes);
            if (toks.map((t) => t.text).join('') !== line.expr) roundTrip += 1;
            if (!plain) {
                for (const note of Object.values(line.notes)) if (note.inferred) inferredLeak += 1;
            }
        }
    }

    check(`${label}: no statement throws`, threw === null, threw ?? '');
    check(`${label}: ${statements} statements formatted`, statements === PIN.statements, `pinned ${PIN.statements}`);
    check(`${label}: tokens rebuild the drawn expression exactly`, roundTrip === 0, `${roundTrip} mismatched`);
    check(`${label}: ${guards} guards seen`, guards === PIN.guards, `pinned ${PIN.guards}`);
    if (plain) {
        // A guard is either read back as a condition or kept verbatim. There is
        // no middle state, and `formatStatement` refuses to phrase a statement
        // where only some of its guards parsed — half a condition reads as a
        // whole one.
        check(`${label}: ${phrased} guards phrased`, phrased === PIN.guardsPhrased, `pinned ${PIN.guardsPhrased}`);
    } else {
        check(`${label}: no guard is rephrased`, phrased === 0, `${phrased} phrased`);
        check(`${label}: no inferred name reaches the reader`, inferredLeak === 0, `${inferredLeak} leaked`);
    }
}

// --------------------------------------------------------------------------
// the plain-language reading, where it is about something other than a table
// --------------------------------------------------------------------------

// A filter entry is not a lookup. `parse_logic` fills its `tables` with
// whatever it found inside the filter's INPUT and its `axes` with the state
// variable and the time constant, so reading it as "interpolate <tables[0]>
// over <axes>" named three things and gave every one of them the wrong part.
{
    const ctxJa = makeContext(raw.nodes, raw.nameIndex, g.byId, raw.glossary, 'ja', true);
    let withFilter = 0;
    let named = 0;
    let lookupLie = 0;
    for (const node of raw.nodes) {
        for (const st of node.stmts ?? []) {
            const filters = (st.interp ?? []).filter((i) => i.shape === 'filter');
            if (!filters.length) continue;
            withFilter += 1;
            const gloss = glossFor(st, ctxJa) ?? '';
            if (/一次遅れフィルタ|IIR フィルタ/.test(gloss)) named += 1;
            // The exact sentence the bug produced: the filter's two arguments
            // joined as if they were a pair of axes.
            for (const f of filters) {
                if (f.axes.length && gloss.includes(f.axes.join('×'))) lookupLie += 1;
            }
        }
    }
    check(`${withFilter} statements filter something, and say so`,
        withFilter === PIN.filterStatements && named === withFilter,
        `pinned ${PIN.filterStatements}, ${named} named`);
    check('no filter is read back as a table lookup', lookupLie === 0, `${lookupLie} misread`);
}

// --------------------------------------------------------------------------
// addresses
// --------------------------------------------------------------------------

const ix = buildAddressIndex(raw.nodes);
const tiers = { exact: 0, inferred: 0, region: 0 };
for (const node of raw.nodes) {
    for (const st of node.stmts ?? []) {
        const text = `${st.out} = ${st.expr}\n${st.guards.join('\n')}`;
        for (const m of text.matchAll(/\b(?:DAT|UNK|PTR)_([0-9a-fA-F]{6,8})\b/g)) {
            const addr = parseInt(m[1], 16);
            const r = resolveAddress(addr, ix, 'ja');
            if (r.inferred) tiers.inferred += 1;
            else if (/^(?:RAM|FLASH) /.test(r.text)) tiers.region += 1;
            else tiers.exact += 1;
        }
    }
}
check(`addresses named outright: ${tiers.exact}`, tiers.exact === PIN.addrExact, `pinned ${PIN.addrExact}`);
check(`addresses named by inference: ${tiers.inferred}`, tiers.inferred === PIN.addrInferred, `pinned ${PIN.addrInferred}`);
check(`addresses given a region: ${tiers.region}`, tiers.region === PIN.addrRegion, `pinned ${PIN.addrRegion}`);

// Every inferred name has to say so, or the reader cannot tell it apart from a
// symbol read straight off the binary.
let unmarked = 0;
for (const addr of [...ix.byAddr.keys()].slice(0, 400)) {
    for (const probe of [addr + 1, addr + 2, addr + 6]) {
        const r = resolveAddress(probe, ix, 'ja');
        if (r.inferred && !r.title) unmarked += 1;
    }
}
check('every inferred name carries its reason', unmarked === 0, `${unmarked} unmarked`);

// A flash address must never be called RAM — the old fallback said RAM for all
// of them, including the ~100 that are not.
const flash = resolveAddress(0x0003d944, ix, 'ja');
check('an address below the RAM base reads as flash', /^FLASH /.test(flash.text), flash.text);

// --------------------------------------------------------------------------
// layout: what is measured is what is drawn, and the wires land inside the box
// --------------------------------------------------------------------------

const ctx = makeContext(raw.nodes, raw.nameIndex, g.byId, raw.glossary, 'ja', true);
const opts = { ctx, maxPorts: 14, showEverything: true, depth: 1, expanded: new Set() };

/**
 * The same picture with every box OPEN.
 *
 * The boxes are shut by default now, so a check about how a FORMULA is drawn —
 * brackets, elisions, the row-to-row gutter, a wire landing on the token it is
 * about — has nothing to look at unless it un-shuts them.
 *
 * `openBlocks`, not `expanded`: expanding a box also widens how many lines it
 * may show, which is a second change and moved every one of these counts.
 *
 * Not `showEverything`. That lifts the per-column caps, which is a different
 * act, and conflating the two is exactly the bug this is here because of: ALL
 * is lit at startup, so hanging the boxes off it opened every one of them on a
 * fresh load and every measurement in this file was taken in a state the app
 * never actually shows.
 */
const wideOpen = (id, extra = {}) => buildDiagram(g, id, { ...opts, ...extra, openBlocks: true });
const blocks = raw.nodes.filter((n) => n.t === 'func' && n.stmts?.length);

let built = 0;
let overflow = 0;
let strayLeader = 0;
let railOutside = 0;
let unroutedSignal = 0;
let worst = '';
/** Guard grouping: rows under a condition, against conditions actually drawn. */
let guardedRows = 0;
let conditionLines = 0;
let brackets = 0;
let wrongIndent = 0;
let shortBand = 0;
/** Gutter links, by what they claim. */
let chains = 0;
let feeds = 0;
/** A connector on the wrong side of the symbol it belongs to. */
let wrongLane = 0;
let overLanes = 0;
/** The picture runs right to left; a column on the wrong side of the focus. */
let wrongSide = 0;
/** Elisions: a mark wherever two drawn rows are not adjacent in the block. */
let elisions = 0;
let missingElision = 0;
let falseElision = 0;

for (const f of blocks) {
    const d = wideOpen(f.id);
    if (!d) continue;
    built += 1;

    // Right to left, because `out = expr` reads that way: what a block READS is
    // drawn to its right, what it WRITES to its left. Get this backwards and
    // every wire crosses the formula it belongs to.
    const centre = d.nodes.find((n) => n.depth === 0 && n.kind === 'block');
    if (centre) {
        for (const n of d.nodes) {
            if (n === centre || n.column === undefined) continue;
            if (n.column < 0 && n.x + n.w <= centre.x) wrongSide += 1;
            if (n.column > 0 && n.x >= centre.x + centre.w) wrongSide += 1;
        }
    }

    for (const n of d.nodes) {
        if (n.kind !== 'block' || !n.rows) continue;
        const textX = n.textX ?? 10;
        for (const row of n.rows) {
            // From the ROW's own origin. A row inside a guard band is indented,
            // so measuring the overflow from the block's left margin would give
            // every indented row a free ride of one indent per level.
            const drawn = row.exprStart + row.tokens.reduce((a, t) => a + t.cells, 0);
            const end = row.x + drawn * CHAR_W;
            if (end > n.w - 3.5) {
                overflow += 1;
                if (!worst) worst = `${f.name} / ${n.label}: ends at ${Math.round(end)} in a ${n.w} box`;
            }
        }
        // A condition is drawn one indent OUT from the rows under it, and is
        // clipped to its own depth's budget — so it gets the same test.
        for (const gd of n.guards ?? []) {
            const end = gd.x + textWidth(gd.text);
            if (end > n.w - 3.5) {
                overflow += 1;
                if (!worst) worst = `${f.name} / ${n.label}: guard ends at ${Math.round(end)} in a ${n.w} box`;
            }
        }
        // A rail's LANE — the x its vertical runs down — lives in the gutter
        // BEYOND the result column, which is where every one of its sources
        // now is. Its stubs reach back to the rows they join, so they are
        // allowed anywhere inside the box. A link has several stubs and several
        // M commands, so this walks the path rather than indexing into it.
        const walk = (path) => {
            const xs = [];
            const verticals = [];
            let x = 0;
            for (const m of path.matchAll(/([MHV]) ([-\d.]+)/g)) {
                if (m[1] === 'V') { verticals.push(x); continue; }
                x = +m[2];
                xs.push(x);
            }
            return { xs, verticals };
        };
        for (const rail of n.rails ?? []) {
            const spine = walk(rail.d);
            // The spine's vertical runs down the gutter, left of the text.
            if (!spine.verticals.length || spine.verticals.some((l) => l > textX || l < 0)) railOutside += 1;
            else if (spine.xs.some((v) => v < 0 || v > n.w)) railOutside += 1;
            // A head reaches back to the row it lands on — anywhere in the box —
            // and ends with the rise that carries its arrowhead. A head with no
            // rise is a line that stops near the symbol rather than on it.
            else if (rail.heads.some((h) => !/ V [-\d.]+$/.test(h) || walk(h).xs.some((v) => v < 0 || v > n.w))) {
                railOutside += 1;
            }
        }

        // A row's indent IS its number of conditions. That is the whole claim
        // the grouping makes — this row is inside these branches — and it is
        // the offset every wire into the box is measured from, so a row drawn
        // at the wrong depth points every one of them at the wrong column.
        (n.lines ?? []).forEach((l, i) => {
            const depth = l.guardParts?.length ?? 0;
            if (depth > 0) guardedRows += 1;
            const row = n.rows?.[i];
            if (row && Math.abs(row.x - textX - depth * 12) > 0.01) wrongIndent += 1;
        });
        conditionLines += (n.guards ?? []).length;
        brackets += (n.bands ?? []).length;

        // A gap in the source indices needs a mark, and a mark needs a gap.
        // Both halves matter: a missing mark asserts an adjacency the block
        // does not have, and a spurious one denies an adjacency it does.
        const src = (n.lines ?? []).map((l) => l.src);
        const wanted = new Map();
        for (let i = 1; i < src.length; i += 1) {
            if (src[i] - src[i - 1] > 1) wanted.set(src[i], src[i] - src[i - 1] - 1);
        }
        const marks = n.elisions ?? [];
        elisions += marks.length;
        if (marks.length !== wanted.size) {
            if (marks.length < wanted.size) missingElision += wanted.size - marks.length;
            else falseElision += marks.length - wanted.size;
        }
        // Same counts, in the same order the rows are drawn in.
        const wantN = [...wanted.values()];
        marks.forEach((m, i) => {
            if (m.n !== wantN[i] || m.n < 1) falseElision += 1;
        });
        // The marks step down the box with the rows they sit between.
        for (let i = 1; i < marks.length; i += 1) {
            if (marks[i].y <= marks[i - 1].y) falseElision += 1;
        }

        // A `writes` link claims its rows are successive values of ONE
        // quantity. Both halves of that have to hold: every row it touches
        // assigns the name, and every row after the first reads it back — which
        // is what keeps a recycled temporary from being drawn as one variable.
        // A value LEAVES a row underneath the name it was written to, and
        // ARRIVES over the symbol that reads it. Both ran underneath once, and
        // the only thing separating the line that goes from the line that comes
        // was the arrowhead on one end of it.
        const baselines = new Set([
            ...n.rows.map((r) => r.formulaY),
            ...(n.guards ?? []).map((gd) => gd.y),
        ]);
        for (const rail of n.rails ?? []) {
            if (rail.kind === 'writes') chains += 1;
            else feeds += 1;
            // The spine starts under the name it leaves.
            const start = /^M [-\d.]+ ([-\d.]+)/.exec(rail.d);
            if (!start || !baselines.has(+start[1] - 6)) wrongLane += 1;
            for (const h of rail.heads) {
                // ... and every landing runs over its own line and drops onto it.
                const m = /^M [-\d.]+ ([-\d.]+) H [-\d.]+ V ([-\d.]+)$/.exec(h);
                if (!m) { wrongLane += 1; continue; }
                const [over, onto] = [+m[1], +m[2]];
                if (!baselines.has(over + 13) || onto - over !== 4) wrongLane += 1;
            }
        }
        overLanes += n.hiddenLinks ?? 0;
        // A bracket is only drawn around a run of two or more, so its span has
        // to clear one row's worth of height.
        for (const band of n.bands ?? []) {
            const m = /^M [-\d.]+ ([-\d.]+) V ([-\d.]+)/.exec(band.d);
            if (!m || +m[2] - +m[1] < 17) shortBand += 1;
        }
    }

    for (const l of d.leaders) {
        // An arrival ends with a rise into the operand; a departure does not.
        const m = /^M ([-\d.]+) ([-\d.]+) H ([-\d.]+)(?: V ([-\d.]+))?$/.exec(l.d);
        if (!m) { strayLeader += 1; continue; }
        if ((l.kind === 'in') !== (m[4] !== undefined)) { strayLeader += 1; continue; }
        const [x1, y, x2] = [+m[1], +m[2], +m[3]];
        const host = d.nodes.find(
            (n) => n.kind === 'block'
                && y >= n.y && y <= n.y + n.h
                && Math.min(x1, x2) >= n.x - 1
                && Math.max(x1, x2) <= n.x + n.w + 1,
        );
        if (!host) strayLeader += 1;
    }

    // A wire between two blocks carries no single symbol, and two of them are
    // not calls: a block with no recovered formula wires itself to its measured
    // references, and one of those can be another block. Those meet at the box
    // centre, which is the honest place for a wire that names nothing.
    for (const e of d.edges) {
        if (e.signal || e.kind === 'call') continue;
        const ends = [e.from, e.to].map((id) => d.nodes.find((n) => n.id === id));
        if (ends.every((n) => n?.kind === 'block')) continue;
        unroutedSignal += 1;
    }
}

check(`${built} block diagrams build`, built === PIN.blocks, `pinned ${PIN.blocks}`);
check('no row of text runs past its box', overflow === 0, worst);
check('every leader ends inside the block it belongs to', strayLeader === 0, `${strayLeader} stray`);
check('every rail stays in the gutter', railOutside === 0, `${railOutside} over the text`);
check('every non-call wire knows what it carries', unroutedSignal === 0, `${unroutedSignal} unnamed`);
check('every row is indented by its own number of conditions', wrongIndent === 0, `${wrongIndent} misplaced`);
check('no bracket is drawn around a single row', shortBand === 0, `${shortBand} too short`);
check(
    `${conditionLines} conditions drawn over ${guardedRows} guarded rows`,
    conditionLines === PIN.conditionLines && guardedRows === PIN.guardedRows,
    `pinned ${PIN.conditionLines} over ${PIN.guardedRows}`,
);
check(`${brackets} brackets drawn`, brackets === PIN.brackets, `pinned ${PIN.brackets}`);
check('every gap between drawn rows is marked', missingElision === 0, `${missingElision} unmarked`);
check('every mark stands for a real gap', falseElision === 0, `${falseElision} spurious`);
check(`${elisions} elision marks drawn`, elisions === PIN.elisions, `pinned ${PIN.elisions}`);

// --------------------------------------------------------------------------
// gutter links: what a line down the left of a block is allowed to claim
// --------------------------------------------------------------------------

check('what a block reads is drawn to its right, what it writes to its left',
    wrongSide === 0, `${wrongSide} on the wrong side`);
check(`${overLanes} links past the lane budget`, overLanes === PIN.overLanes, `pinned ${PIN.overLanes}`);
check('a value leaves a row from under it and arrives over it',
    wrongLane === 0, `${wrongLane} on the wrong side`);
check(`${feeds} feeds rails and ${chains} write chains drawn`,
    feeds === PIN.feeds && chains === PIN.chains, `pinned ${PIN.feeds} and ${PIN.chains}`);

// A `writes` chain says its rows are successive values of ONE quantity, so
// every row has to assign that name and every row after the first has to read
// it back. Asserted on the rule itself rather than on the drawing: this is the
// claim, and the drawing is downstream of it.
let looseChain = 0;
let chainedRows = 0;
const word = (text, name) =>
    new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(text);
for (const f of blocks) {
    const lines = f.stmts.map((st) => formatStatement(st, ctx));
    for (const c of writeChains(lines)) {
        chainedRows += c.rows.length;
        if (c.rows.length < 2) looseChain += 1;
        for (const [k, r] of c.rows.entries()) {
            if (lines[r].out !== c.name) looseChain += 1;
            else if (k > 0 && !word(lines[r].expr, c.name)) looseChain += 1;
        }
    }
}
check('every write chain is one quantity being updated', looseChain === 0, `${looseChain} loose`);
check(`${chainedRows} rows joined into a chain`, chainedRows === PIN.chainedRows, `pinned ${PIN.chainedRows}`);

// The case the read-back rule exists for. `rf_soll_calc` writes
// `rf_soll_kath_temp` five times: three are the catalyst-heating delta being
// refined, and two are an unrelated PT correction that recycled the name. One
// chain across all five would draw those as one quantity.
const rfSoll = blocks.find((n) => n.name === 'rf_soll_calc');
const recycled = rfSoll
    ? writeChains(rfSoll.stmts.map((st) => formatStatement(st, ctx)))
        .filter((c) => c.name.toLowerCase() === 'rf_soll_kath_temp')
        .map((c) => c.rows.join(','))
    : [];
// A read inside a CONDITION is a relation like any other, and it was the one
// with nothing on screen at all: `linkPairs` only ever looked at expressions.
// `rf_soll_calc` picks its filter time constant by testing the running total
// against the previous cycle, so all three rows that build that total reach
// statement 9 through its guard.
const guardLinks = rfSoll
    ? linkPairs(rfSoll.stmts.map((st) => formatStatement(st, ctx)))
        .filter((p) => p.viaGuard !== undefined && p.to === 9)
        .map((p) => p.from)
        .sort((a, b) => a - b)
    : [];
check('a read inside a condition is linked to what wrote it',
    guardLinks.join(',') === '1,5,7', guardLinks.join(',') || 'none');

check('a recycled temporary is two chains, not one',
    // The rows moved to 12,13 when line-joining recovered a statement earlier
    // in this function. What is asserted is the SHAPE — two chains, not one —
    // and that is unchanged: the first is still 2,3,4 and the sibling check on
    // rows 1,5,7 still passes, which places the new statement between 7 and 11.
    recycled.length === 2 && recycled[0] === '2,3,4' && recycled[1] === '12,13',
    recycled.join(' / ') || 'rf_soll_calc not found');

// --------------------------------------------------------------------------
// the listing: the same statements read top to bottom
// --------------------------------------------------------------------------

{
    let built = 0;
    let statements = 0;
    let unbalanced = 0;
    let strayDepth = 0;
    let missed = 0;
    let biggest = 0;
    for (const f of blocks) {
        const d = buildDiagram(g, f.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
        if (!d) continue;
        const listing = buildCode(g, d, ctx);
        built += 1;
        statements += listing.statements;
        biggest = Math.max(biggest, listing.lines.length);

        // Every block the picture draws gets listed exactly once, and nothing
        // else does: the listing is what is on screen, read as text.
        const drawn = new Set(d.nodes.filter((n) => n.kind === 'block' && n.target).map((n) => n.target));
        const listed = listing.lines.filter((l) => l.kind === 'block').map((l) => l.target);
        if (listed.length !== drawn.size || new Set(listed).size !== listed.length) missed += 1;

        // Braces balance, and nothing is emitted at a depth its `if` never
        // opened — an indent is a claim about which condition a line is under.
        let open = 0;
        for (const l of listing.lines) {
            if (l.kind === 'ring') continue;
            if (l.kind === 'block') { if (open !== 0) unbalanced += 1; open = 0; continue; }
            if (l.kind === 'guard') { if (l.depth !== open) strayDepth += 1; open += 1; continue; }
            if (l.kind === 'close') { open -= 1; if (l.depth !== open) strayDepth += 1; continue; }
            if (l.depth > open) strayDepth += 1;
        }
        if (open !== 0) unbalanced += 1;
    }
    check(`${built} listings build`, built === PIN.blocks, `pinned ${PIN.blocks}`);
    check('every drawn block is listed once, and only drawn blocks are',
        missed === 0, `${missed} listings disagree with their picture`);
    check('every if closes, in the block it opened in', unbalanced === 0, `${unbalanced} unbalanced`);
    check('nothing is indented under a condition that did not open', strayDepth === 0, `${strayDepth} stray`);
    check(`${statements} statements listed, longest listing ${biggest} lines`,
        statements === PIN.listedStatements && biggest === PIN.longestListing,
        `pinned ${PIN.listedStatements} / ${PIN.longestListing}`);
}

// --------------------------------------------------------------------------
// one grouping, one set of relations, three views
// --------------------------------------------------------------------------
{
    // The picture's bands and the listing's braces come from one call now. This
    // asserts it stays that way by comparing what each actually DREW, block by
    // block, rather than by reading the code and trusting it.
    let groups = 0;
    let deepest = 0;
    let disagree = 0;
    let flat = 0;
    for (const f of blocks) {
        const lines = (f.stmts ?? []).map((st) => formatStatement(st, ctx));
        const tree = guardTree(lines);
        const n = branchCount(tree);
        groups += n;
        if (n === 0) flat += 1;
        deepest = Math.max(deepest, maxNesting(tree));

        // Opened: the picture draws no branches at all until a box is, and
        // this check is about the two views agreeing on the SHAPE of one.
        const d = buildDiagram(g, f.id, {
            ctx, maxPorts: 14, depth: 1, expanded: new Set(),
            showAllLines: true, showNoise: true, openBlocks: true,
        });
        if (!d) continue;
        // The SUBJECT, by depth rather than by id. A self-recursive block is
        // drawn as its own callee as well, and a callee port carries kind
        // 'block' too — so both `target` and `kind` match the wrong node.
        // Exactly one node in a picture is at depth 0.
        const drawn = d.nodes.find((x) => x.depth === 0 && x.target === f.id);
        const listing = buildCode(g, d, ctx);
        const span = listing.spans.find((sp) => listing.lines[sp.at].target === f.id);
        if (!drawn || !span) continue;
        // Only this block's own guard lines: the listing holds its neighbours too.
        const braces = listing.lines.slice(span.at, span.end).filter((l) => l.kind === 'guard').length;
        if ((drawn.guards ?? []).length !== braces) disagree += 1;
    }
    check(`${groups} branch groups, deepest nesting ${deepest}`,
        groups === PIN.branchGroups && deepest === PIN.deepestNesting,
        `pinned ${PIN.branchGroups} / ${PIN.deepestNesting}`);
    check('the picture and the listing draw the same branches',
        disagree === 0, `${disagree} blocks where the two disagree`);
    check(`${flat} functions have no branch at all`,
        flat === PIN.flatFunctions, `pinned ${PIN.flatFunctions}`);
}

// --------------------------------------------------------------------------
// the subject is what was picked, and it comes first
// --------------------------------------------------------------------------
{
    // The failure this catches: selecting a map used to root the picture on one
    // of its users, so the map itself was nowhere on screen and the listing
    // opened on a block six columns upstream of it.
    let notFirst = 0;
    let deep = 0;
    for (let i = 0; i < blocks.length; i += 7) {
        const d = buildDiagram(g, blocks[i].id, { ctx, maxPorts: 14, depth: 3, expanded: new Set() });
        if (!d) continue;
        deep += 1;
        const first = buildCode(g, d, ctx).lines.find((l) => l.kind === 'block');
        if (first?.target !== blocks[i].id) notFirst += 1;
    }
    check(`a block subject is the first thing its listing names (${deep} at DEPTH 3)`,
        notFirst === 0, `${notFirst} listings open somewhere else`);

    const shared = raw.nodes.filter((n) => n.t === 'param' && usersOf(g, n).length > 1);
    check(`${shared.length} parameters are used by more than one block`,
        shared.length === PIN.sharedParams, `pinned ${PIN.sharedParams}`);

    // Every one of them, at DEPTH 1 with the caps lifted: the claim is that no
    // user is dropped, and dropping one is what the old behaviour did.
    let missingUsers = 0;
    for (const p of shared) {
        const d = buildDiagram(g, p.id, {
            ctx, maxPorts: 14, depth: 1, expanded: new Set(), showEverything: true,
        });
        if (!d) { missingUsers += 1; continue; }
        const drawn = new Set(d.nodes.filter((n) => n.kind === 'block').map((n) => n.target));
        if (usersOf(g, p).some((u) => !drawn.has(u.id))) missingUsers += 1;
    }
    check('every block that uses a parameter is drawn when it is the subject',
        missingUsers === 0, `${missingUsers} parameters lose a user`);

    // Exactly one node is the subject, and it is drawn under the name a formula
    // spells. Both halves were wrong at once: the subject arrived labelled with
    // the catalog's descriptive name — `kf_rf_soll (CSL Alpha-N)` — while a user
    // block listed the same map among its inputs as `KF_RF_SOLL`, so the map got
    // two boxes and clicking the symbol in a formula lit neither.
    let notOne = 0;
    let mislabelled = 0;
    for (const n of [...blocks, ...raw.nodes.filter((x) => x.t === 'param')]) {
        const d = buildDiagram(g, n.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
        if (!d) continue;
        const subject = d.nodes.filter((x) => x.depth === 0);
        if (subject.length !== 1 || subject[0].target !== n.id) { notOne += 1; continue; }
        if (subject[0].label !== displayName(codeName(g, n), n.t)) mislabelled += 1;
    }
    check('exactly one node in a picture is the subject', notOne === 0, `${notOne} pictures disagree`);
    check('the subject is drawn under the name a formula spells it by',
        mislabelled === 0, `${mislabelled} carry another spelling`);

    // DEPTH used to do nothing at all on a parameter: DEPTH 1 and DEPTH 3
    // produced an identical node list. It must now reach past the users — but
    // not for every parameter, and pretending otherwise would be a check that
    // lies. 28 of these have users that read and write only each other, so
    // there is genuinely nothing further out: `K_DWF_TOEL_0SEG` is read by
    // `dwf_st_init` and `dwf_st_calc`, and DWF_ST goes between exactly those
    // two. So: never SMALLER, and the split is pinned.
    let shrank = 0;
    let grew = 0;
    for (const p of shared) {
        const opts = { ctx, maxPorts: 14, expanded: new Set() };
        const one = buildDiagram(g, p.id, { ...opts, depth: 1 });
        const three = buildDiagram(g, p.id, { ...opts, depth: 3 });
        if (!one || !three) continue;
        if (three.nodes.length < one.nodes.length) shrank += 1;
        else if (three.nodes.length > one.nodes.length) grew += 1;
    }
    check('raising DEPTH never makes a parameter picture smaller',
        shrank === 0, `${shrank} shrank`);
    check(`DEPTH reaches past the users of ${grew} of ${shared.length} shared parameters`,
        grew === PIN.depthReaches, `pinned ${PIN.depthReaches}`);

    // The listing still opens on the users, three rings deep. Sampled: this one
    // costs a DEPTH-3 picture AND a listing each. Spread across the set rather
    // than taken off the front, where a run of related maps would all exercise
    // the same shape.
    let paramNotFirst = 0;
    let sampled = 0;
    for (let i = 0; i < shared.length; i += 9) {
        const p = shared[i];
        const three = buildDiagram(g, p.id, { ctx, maxPorts: 14, depth: 3, expanded: new Set() });
        if (!three) continue;
        sampled += 1;
        const head = buildCode(g, three, ctx).lines.find((l) => l.kind === 'block');
        const users = usersOf(g, p);
        if (!head || !users.some((u) => u.id === head.target)) paramNotFirst += 1;
    }
    check(`a parameter subject is listed by its own users first (${sampled} sampled)`,
        paramNotFirst === 0, `${paramNotFirst} listings open elsewhere`);

    // PLUMBING has to be reachable wherever it does something. Both halves are
    // checked: the count that draws the control, and whether the picture really
    // changes — a control offered where nothing happens is the same defect
    // wearing the other face.
    let folded = 0, changes = 0, silent = 0;
    for (const p of raw.nodes.filter((n) => n.t === 'param')) {
        const off = wideOpen(p.id, { showNoise: false });
        if (!off) continue;
        const on = wideOpen(p.id, { showNoise: true });
        const rows = (d) => d.nodes.reduce((a, n) => a + (n.lines?.length ?? 0), 0);
        const reported = off.hiddenNoise > 0;
        const changed = Boolean(on) && rows(on) !== rows(off);
        if (reported) folded += 1;
        if (changed) changes += 1;
        if (changed && !reported) silent += 1;
    }
    check(`${folded} parameter pictures report folded plumbing (${changes} visibly change)`,
        folded === PIN.paramsWithFoldedPlumbing, `pinned ${PIN.paramsWithFoldedPlumbing}`);
    check('no parameter picture changes with PLUMBING without offering the control',
        silent === 0, `${silent} change silently`);

    // Every empty box says why it is empty. A blank box with no explanation is
    // indistinguishable from one that failed to load, and 68% of the block
    // boxes this file draws are blank.
    let noFormula = 0, sourceOnly = 0, allPlumbing = 0, mute = 0;
    for (const f of raw.nodes.filter((n) => n.t === 'func')) {
        const d = wideOpen(f.id);
        const subject = d?.nodes.find((n) => n.depth === 0);
        // `rows` is what separates a real block box from a callee PORT, which
        // carries kind 'block' as well and is a name by design.
        if (!subject || !subject.rows || subject.lines?.length) continue;
        if (subject.empty === 'noFormula') noFormula += 1;
        else if (subject.empty === 'sourceOnly') sourceOnly += 1;
        else if (subject.empty === 'allPlumbing') allPlumbing += 1;
        else mute += 1;
    }
    check(`${noFormula} boxes say "never decompiled", ${sourceOnly} "text only", ${allPlumbing} "all plumbing"`,
        noFormula === PIN.emptyNoFormula
            && sourceOnly === PIN.emptySourceOnly
            && allPlumbing === PIN.emptyAllPlumbing,
        `pinned ${PIN.emptyNoFormula} / ${PIN.emptySourceOnly} / ${PIN.emptyAllPlumbing}`);
    check('no block box is empty without saying why', mute === 0, `${mute} are blank and mute`);
    // The claim the three states have to keep between them: a box that says
    // "never decompiled" must be about a function whose text really is absent.
    // Getting this backwards is the bug this whole worktree is about.
    {
        const byId = new Map(raw.nodes.map((n) => [n.id, n]));
        let wrong = 0;
        for (const f of raw.nodes.filter((n) => n.t === 'func')) {
            const d = wideOpen(f.id);
            const subject = d?.nodes.find((n) => n.depth === 0);
            if (subject?.empty === 'noFormula' && byId.get(f.id)?.hasCode) wrong += 1;
            if (subject?.empty === 'sourceOnly' && !byId.get(f.id)?.hasCode) wrong += 1;
        }
        check('the reason a box gives matches whether its text exists', wrong === 0, `${wrong} misreported`);
    }

    // The case that started this. It is in `shared`, but named outright so the
    // failure reads as itself rather than as a count.
    const rfUsers = usersOf(g, g.byId.get(raw.nameIndex['kf_rf_soll'])).map((n) => n.name).sort();
    check('kf_rf_soll names both of the blocks that read it',
        rfUsers.join() === 'rf_sk_wdk_calc,rf_soll_calc', rfUsers.join(', ') || '(none)');
}

// --------------------------------------------------------------------------
// inside one function
// --------------------------------------------------------------------------
{
    let edges = 0;
    let frames = 0;
    let widest = 0;
    let escaped = 0;
    let backwards = 0;
    for (const f of blocks) {
        for (const mode of ['flow', 'branches']) {
            // With the plumbing shown, so the frames can be compared against
            // the whole artifact's branch count: folding it away removes
            // statements, and a branch with none left is not drawn.
            const v = buildInside(f, ctx, { mode, showNoise: true });
            edges += v.edges.length;
            frames += v.frames.length;
            widest = Math.max(widest, Math.round(v.width));
            // Nothing drawn outside the canvas it was measured for - the same
            // invariant the picture's own boxes are held to.
            for (const r of v.rows) {
                if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > v.width + 0.5 || r.y + r.h > v.height + 0.5) {
                    escaped += 1;
                    break;
                }
            }
            for (const fr of v.frames) {
                if (fr.x < -0.5 || fr.w <= 0 || fr.y + fr.h > v.height + 0.5) { escaped += 1; break; }
            }
            // Values travel one way. A line running left to right would mean a
            // row reading something computed after it.
            const at = new Map(v.rows.map((r) => [r.row, r]));
            for (const e of v.edges) {
                const a = at.get(e.from);
                const b = at.get(e.to);
                if (a && b && b.x + b.w > a.x + 0.5) backwards += 1;
            }
        }
    }
    check(`${edges} hand-offs drawn inside blocks`,
        edges === PIN.insideEdges, `pinned ${PIN.insideEdges}`);
    check(`widest inside view ${widest}px`, widest === PIN.widestInside, `pinned ${PIN.widestInside}`);
    check('nothing inside a function is drawn outside its canvas', escaped === 0, `${escaped} escaped`);
    check('no hand-off runs against the flow', backwards === 0, `${backwards} run backwards`);
    // The frames ARE the branch groups: the listing's braces, the picture's
    // bands and these all come from the one tree.
    check('the frames are the same branches the other two views draw',
        frames === PIN.branchGroups, `${frames} vs ${PIN.branchGroups}`);
}

// --------------------------------------------------------------------------
// two processors, one dual-port window
// --------------------------------------------------------------------------
{
    // THE invariant this whole change exists to establish: the master and the
    // slave are separate computers, so a wire between them is only real when it
    // runs through the one window both can see.
    const chain = blockChain(g);
    let pairs = 0, cross = 0, notShared = 0;
    for (const [key, writers] of chain.writers) {
        for (const w of writers) for (const r of chain.readers.get(key) ?? []) {
            if (w === r) continue;
            pairs += 1;
            if (g.byId.get(w)?.bank === g.byId.get(r)?.bank) continue;
            cross += 1;
            if (!key.startsWith('shared:')) notShared += 1;
        }
    }
    check(`${cross} of ${pairs} block hand-offs cross between the processors`,
        cross === PIN.crossBankPairs, `pinned ${PIN.crossBankPairs}`);
    check('every cross-processor hand-off goes through the shared window',
        notShared === 0, `${notShared} weld two different addresses together`);

    // The bridge itself. It was invisible: 0 writes registered.
    const m = raw.nodes.find((n) => n.t === 'func' && n.name === 'dpr_sync' && n.bank === 'master');
    const sl = raw.nodes.find((n) => n.t === 'func' && n.name === 'dpr_sync' && n.bank === 'slave');
    const wrote = (chain.writtenBy.get(m.id) ?? []).length;
    const read = (chain.readBy.get(sl.id) ?? []).length;
    check(`dpr_sync posts ${wrote} values into the window and takes ${read} out`,
        wrote === PIN.dprSyncWrites && read === PIN.dprSyncWrites,
        `pinned ${PIN.dprSyncWrites} each way`);

    // The underscore. `_N_DPR` is a write to N_DPR, and it was being dropped.
    let underscored = 0;
    for (const f of raw.nodes) {
        for (const st of f.stmts ?? []) {
            const bare = st.out.replace(/[[\].>-].*$/, '');
            if (!bare.startsWith('_')) continue;
            if (graphName(bare.replace(/^_+/, ''))) underscored += 1;
        }
    }
    check(`${underscored} writes are recovered by stripping the leading underscore`,
        underscored === PIN.underscoreWrites, `pinned ${PIN.underscoreWrites}`);

    // `N` is the case that proves it: same name, two addresses, two signals.
    const nm = signalOf(g, 'N', 'master');
    const ns = signalOf(g, 'N', 'slave');
    check('N is two locations, one per processor',
        nm.key !== ns.key && !nm.shared && !ns.shared, `${nm.key} vs ${ns.key}`);
    // And P_UMG is the case that proves the other half.
    const pu = signalOf(g, 'P_UMG', 'master');
    check('P_UMG is one location both processors see', pu.shared, pu.key);

    // Both copies of a block can be on screen at once. 128 function names exist
    // on both banks, and `drawn` used to be keyed by name — so the second was
    // silently skipped, which for dpr_sync meant the bridge could never be
    // drawn as the two halves it is.
    const d = buildDiagram(g, m.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set(), showEverything: true });
    const syncs = (d?.nodes ?? []).filter((n) => n.kind === 'block' && n.label === 'dpr_sync');
    check('both processors\' dpr_sync are drawn in one picture',
        syncs.length === 2 && new Set(syncs.map((n) => n.detail)).size === 2,
        `${syncs.length} drawn: ${syncs.map((n) => n.detail).join(', ')}`);

    // No picture may hold two boxes with the same identity.
    let collided = 0;
    for (let i = 0; i < blocks.length; i += 11) {
        const pic = buildDiagram(g, blocks[i].id, { ctx, maxPorts: 14, depth: 2, expanded: new Set() });
        if (!pic) continue;
        const ids = pic.nodes.map((n) => n.id);
        if (new Set(ids).size !== ids.length) collided += 1;
    }
    check('no picture draws two nodes with the same id', collided === 0, `${collided} collide`);
}

// --------------------------------------------------------------------------
// the loop closes
// --------------------------------------------------------------------------
{
    let wires = 0, pics = 0, hidden = 0, cross = 0, self = 0, viaBlock = 0;
    let boxes = 0, both = 0, saying = 0, onward = 0, lanes = 0;
    for (const b of blocks) {
        const d = buildDiagram(g, b.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
        if (!d) continue;
        const byId = new Map(d.nodes.map((n) => [n.id, n]));
        const back = d.edges.filter((e) => e.back);
        if (back.length) pics += 1;
        wires += back.length;
        hidden += d.hiddenLoops;
        // The floor of the picture: every box is above it, so a wire whose
        // horizontal run is below it cannot cross one. Same idea as the
        // text-inside-the-box check — geometry, asserted, not eyeballed.
        const floor = Math.max(...d.nodes.map((n) => n.y + n.h));
        const seen = new Set();
        for (const e of back) {
            const at = /^M [\d.-]+ [\d.-]+ V ([\d.-]+) H/.exec(e.d);
            if (!at || Number(at[1]) < floor) cross += 1;
            else seen.add(at[1]);
            const a = byId.get(e.from), c = byId.get(e.to);
            if (a && c && a.kind !== 'block' && c.kind !== 'block') self += 1;
            else viaBlock += 1;
        }
        lanes = Math.max(lanes, seen.size);
        const fwd = new Set(), bwd = new Set();
        for (const e of d.edges) { (e.back ? bwd : fwd).add(e.from); (e.back ? bwd : fwd).add(e.to); }
        for (const id of bwd) if (fwd.has(id)) both += 1;
        for (const n of d.nodes) if (n.kind === 'block') {
            boxes += 1;
            if (n.moreBlocks) { saying += 1; onward += n.moreBlocks; }
        }
    }
    check(`${wires} return wires close a loop, in ${pics} of the ${blocks.length} pictures`,
        wires === PIN.loopWires && pics === PIN.loopPictures,
        `pinned ${PIN.loopWires} in ${PIN.loopPictures}`);
    check('at the default depth every loop the tool knows about is drawn',
        hidden === PIN.loopsHidden, `${hidden} fell past the lane budget`);
    check(`${self} are a block's own quantity, ${viaBlock} run through another block`,
        self === PIN.loopSelf && viaBlock === PIN.loopThroughBlock,
        `pinned ${PIN.loopSelf} / ${PIN.loopThroughBlock}`);
    check(`${both} boxes carry a wire each way`, both === PIN.loopBoxes, `pinned ${PIN.loopBoxes}`);
    check('no return wire runs through the columns', cross === 0, `${cross} cross a box`);
    check(`the deepest lane stack is ${lanes}`, lanes === PIN.loopLanes, `pinned ${PIN.loopLanes}`);
    check(`${saying} of ${boxes} boxes say the chain goes on, naming ${onward} blocks`,
        saying === PIN.chainContinues && onward === PIN.onwardBlocks,
        `pinned ${PIN.chainContinues} / ${PIN.onwardBlocks}`);

    // The named case. `rf_calc` computes the filling and reads the filling —
    // the tightest loop in the engine model, and the one the picture drew as
    // two boxes with a gap between them.
    const rf = raw.nodes.find((n) => n.t === 'func' && n.name === 'rf_calc');
    const d = buildDiagram(g, rf.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
    const byId = new Map(d.nodes.map((n) => [n.id, n]));
    const closed = d.edges.some((e) => {
        const a = byId.get(e.from), c = byId.get(e.to);
        return e.back && a?.label === 'RF' && c?.label === 'RF' && a.column === 1 && c.column === -1;
    });
    check("rf_calc's own RF comes back round to its input",
        closed, 'the two RF boxes are still unjoined');

    // And over every picture a PARAMETER draws, which is the way in most of
    // the time. Same geometry claim, asserted over 4,787 more pictures.
    let pPics = 0, pWith = 0, pWires = 0, pHidden = 0, pCross = 0;
    for (const n of raw.nodes) {
        if (n.t === 'func') continue;
        const pic = buildDiagram(g, n.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set(), highlight: n.id });
        if (!pic) continue;
        pPics += 1;
        const back = pic.edges.filter((e) => e.back);
        if (back.length) pWith += 1;
        pWires += back.length;
        pHidden += pic.hiddenLoops;
        const floor = Math.max(...pic.nodes.map((x) => x.y + x.h));
        for (const e of back) {
            const at = /^M [\d.-]+ [\d.-]+ V ([\d.-]+) H/.exec(e.d);
            if (!at || Number(at[1]) < floor) pCross += 1;
        }
    }
    check(`${pWith} of the ${pPics} parameter pictures are inside a loop, on ${pWires} wires`,
        pWith === PIN.paramLoopPictures && pWires === PIN.paramLoopWires,
        `pinned ${PIN.paramLoopPictures} / ${PIN.paramLoopWires}`);
    check(`${pHidden} return wires past the lane budget, and reported`,
        pHidden === PIN.paramLoopsHidden, `pinned ${PIN.paramLoopsHidden}`);
    check('no return wire in a parameter picture runs through the columns',
        pCross === 0, `${pCross} cross a box`);

    // The hint that stands in for a loop the view cannot reach. Checked against
    // the thing it promises: build the deeper picture and see.
    let atOne = 0, shown = 0, right = 0, missed = 0;
    for (const n of raw.nodes) {
        if (n.t !== 'param') continue;
        const one = buildDiagram(g, n.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set(), highlight: n.id });
        if (!one) continue;
        if (one.edges.some((e) => e.back)) { atOne += 1; continue; }
        const two = buildDiagram(g, n.id, { ctx, maxPorts: 14, depth: 2, expanded: new Set(), highlight: n.id });
        const deeper = Boolean(two && two.edges.some((e) => e.back));
        if (one.loopsBeyond > 0) { shown += 1; if (deeper) right += 1; }
        else if (deeper) missed += 1;
    }
    check(`${atOne} parameters show a loop at DEPTH 1`,
        atOne === PIN.paramsLoopAtOne, `pinned ${PIN.paramsLoopAtOne}`);
    check(`the deeper-loop hint appears ${shown} times and is right ${right} of them`,
        shown === PIN.paramsLoopHintShown && right === PIN.paramsLoopHintRight,
        `pinned ${PIN.paramsLoopHintShown} / ${PIN.paramsLoopHintRight}`);
    check('no loop appears one depth down without having been announced',
        missed === PIN.paramsLoopHintMissed, `${missed} went unannounced`);
}

// --------------------------------------------------------------------------
// the row the box is on the picture for
// --------------------------------------------------------------------------
{
    let rows = 0, kept = 0, marked = 0, markedWrong = 0, overran = 0;
    for (const n of raw.nodes) {
        if (n.t !== 'param') continue;
        const name = codeName(g, n).toLowerCase();
        const pic = buildDiagram(g, n.id, {
            ctx, maxPorts: 14, depth: 1, expanded: new Set(), highlight: n.id, openBlocks: true,
        });
        if (!pic) continue;
        for (const box of pic.nodes) {
            if (box.kind !== 'block' || !box.lines?.length) continue;
            box.lines.forEach((l, i) => {
                const whole = `${l.out} = ${l.expr}`.toLowerCase();
                if (!whole.includes(name)) return;
                rows += 1;
                const drawn = `${l.out} = ${l.shown}`.toLowerCase();
                if (drawn.includes(name)) kept += 1;
                // Marked from the DRAWN text, so a row whose mention was cut
                // away is never banded as if the reader could see it.
                const row = box.rows?.[i];
                if (row?.subject) {
                    marked += 1;
                    if (!drawn.includes(name)) markedWrong += 1;
                }
                // The window is still a window: it may not push the row out
                // through the border the clip exists to hold.
                const budget = Math.floor((box.w - 20) / CHAR_W) + 2;
                if (l.out.length + 3 + l.shown.length > budget) overran += 1;
            });
        }
    }
    check(`${rows} drawn rows mention the selection, ${kept} of them show it`,
        rows === PIN.subjectRows && kept === PIN.subjectRowsKept,
        `pinned ${PIN.subjectRows} / ${PIN.subjectRowsKept}`);
    check('sliding the window never pushes a row out through its border',
        overran === 0, `${overran} overrun`);
    check(`${marked} rows are banded as the reason their box is here`,
        marked > 0 && markedWrong === 0,
        `${marked} banded, ${markedWrong} of them without the name on screen`);
}

// --------------------------------------------------------------------------
// shut by default, opened one at a time
// --------------------------------------------------------------------------
{
    let shut = 0, open = 0, wrongEmpty = 0, noCount = 0;
    for (const b of blocks) {
        const d = buildDiagram(g, b.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
        if (!d) continue;
        for (const n of d.nodes) {
            // `kind: 'block'` is also worn by a PORT that stands for a called
            // function, and those are not boxes. A real box is the only thing
            // that carries `lines`, even when the list is empty because it is
            // shut. This exact confusion has cost three separate fixes.
            if (n.kind !== 'block' || !n.lines) continue;
            if (n.closed) {
                shut += 1;
                // A shut box has contents and is not showing them. It must not
                // borrow the sentence that belongs to a box which HAS none —
                // that sentence is load-bearing on 1,171 boxes.
                if (n.empty) wrongEmpty += 1;
                // And it has to say what opening it would cost, or there is
                // nothing on screen saying it opens at all.
                if (!n.inside && (g.byId.get(n.target)?.stmts?.length ?? 0) > 0) noCount += 1;
            } else open += 1;
        }
    }
    check(`${shut} boxes are shut at the default settings, and none is open`,
        shut === PIN.shutBoxes && open === 0,
        `pinned ${PIN.shutBoxes}, ${open} open`);
    check('no shut box claims there is nothing inside it', wrongEmpty === 0, `${wrongEmpty} do`);
    check('every shut box says how many rows it holds', noCount === 0, `${noCount} do not`);

    // Opening the SUBJECT has to work too. It was the one box drawn open, so
    // it was also the one box with no control to open it — and once it started
    // shut like the rest, that left the box the reader came for closed for
    // good. The renderer draws the toggle on every box now; this is the model
    // half of the same claim.
    const subjectOpens = blocks.filter((x) => {
        const opened = buildDiagram(g, x.id, {
            ctx, maxPorts: 14, depth: 1, expanded: new Set([x.id]),
        });
        const me = opened?.nodes.find((n) => n.depth === 0 && n.lines);
        // `closed` only. The 83 blocks whose every statement is plumbing open
        // to an empty box with PLUMBING off, and that is the folding working,
        // not the opening failing.
        return me?.closed === true;
    });
    check('the block that was asked about opens when it is asked to',
        subjectOpens.length === 0, `${subjectOpens.length} stay shut`);

    // Opening one opens that one. The `expanded` set is keyed by node id, and
    // 128 function names exist on both banks — a name-keyed set would open the
    // other processor's copy alongside it.
    const one = blocks.find((x) => x.name === 'rf_calc');
    const pic = buildDiagram(g, one.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
    const neighbour = pic.nodes.find((n) => n.kind === 'block' && n.lines && n.closed && n.target);
    const opened = buildDiagram(g, one.id, {
        ctx, maxPorts: 14, depth: 1, expanded: new Set([neighbour.target]),
    });
    const nowOpen = opened.nodes.filter((n) => n.kind === 'block' && n.lines && !n.closed);
    check(`opening ${neighbour.label} opens ${neighbour.label} and nothing else`,
        nowOpen.length === 1 && nowOpen[0].target === neighbour.target,
        `${nowOpen.length} boxes are open`);
}

// --------------------------------------------------------------------------
// where the ECU meets the engine
// --------------------------------------------------------------------------
{
    const b = boundary(g);
    check(`${b.inputs.length} sensor inputs and ${b.outputs.length} actuator outputs`,
        b.inputs.length === PIN.boundaryIn && b.outputs.length === PIN.boundaryOut,
        `pinned ${PIN.boundaryIn} / ${PIN.boundaryOut}`);

    // The rule's own failure detector. If this ever reaches zero it is because
    // the master's injector writes were recovered, which is good news — but it
    // must be noticed rather than absorbed.
    check(`${b.suspect.length} registers point both ways and are reported, not counted`,
        b.suspect.length === PIN.boundarySuspect
        && b.suspect.every((x) => x.node.name.startsWith('PSP1_')),
        b.suspect.map((x) => x.node.name).join(', '));

    // An input is one the ECU cannot write. That is the whole definition, so
    // assert it rather than trusting the construction.
    const chain2 = blockChain(g);
    const writable = b.inputs.filter((x) => (chain2.writers.get(x.key) ?? []).length);
    check('nothing in the binary writes an input', writable.length === 0,
        writable.map((x) => x.node.name).join(', '));
    const undriven = b.outputs.filter((x) => !(chain2.writers.get(x.key) ?? []).length);
    check('every output is driven by the binary', undriven.length === 0,
        undriven.map((x) => x.node.name).join(', '));

    // Chip configuration is not a boundary. SIM chip selects, QSM serial and
    // the SRAM controller are peripheral registers the engine cannot feel, and
    // a degree-only rule called 81 of them outputs.
    const config = [...b.inputs, ...b.outputs].filter((x) => /^(SIM_|QSM_|SRAM_|QADC_Q)/.test(x.node.name));
    check('no chip-configuration register is called an end of the ECU',
        config.length === 0, config.map((x) => x.node.name).join(', '));

    // The named path the plan promised end to end: pedal in, injector out.
    const pedal = b.inputs.find((x) => x.node.name === 'pwg1_ad');
    const inject = b.outputs.find((x) => x.node.name === 'PSP1_HIGH_TIME');
    check('the pedal is an input and the injection pulse is an output',
        Boolean(pedal && inject),
        `${pedal ? 'pedal ok' : 'pedal MISSING'}, ${inject ? 'injector ok' : 'injector MISSING'}`);

    // The ruler's numbers exist for the pictures that contain no end at all.
    let withEnd = 0;
    for (const blk of blocks) {
        const d = buildDiagram(g, blk.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
        if (!d) continue;
        if (d.ends.inShown || d.ends.outShown) withEnd += 1;
        // Whatever is marked must BE one, and the denominators are fixed lists.
        const bad = d.nodes.filter((n) => n.boundary && b.byKey.get(n.key)?.side !== n.boundary);
        if (bad.length) throw new Error(`${blk.name}: ${bad.length} boxes marked wrongly`);
        if (d.ends.inTotal !== PIN.boundaryIn || d.ends.outTotal !== PIN.boundaryOut) {
            throw new Error(`${blk.name}: the denominators moved`);
        }
    }
    check(`${withEnd} of the ${blocks.length} pictures contain an end at all`,
        withEnd === PIN.picturesWithAnEnd, `pinned ${PIN.picturesWithAnEnd}`);

    // The ruler itself. A distance is a number of blocks, and must be absent
    // rather than wrong when the end cannot be reached.
    const r = reach(g);
    let sensorMax = 0, actuatorMax = 0, loopMax = 0;
    for (const blk of blocks) {
        sensorMax = Math.max(sensorMax, r.fromInput.get(blk.id) ?? 0);
        actuatorMax = Math.max(actuatorMax, r.toOutput.get(blk.id) ?? 0);
        loopMax = Math.max(loopMax, r.loopSize.get(blk.id) ?? 1);
    }
    check(`the furthest block is ${sensorMax} from a sensor and ${actuatorMax} from an actuator`,
        sensorMax === 6 && actuatorMax === 8, `${sensorMax} / ${actuatorMax}`);
    // Smaller than it was at 502, with 2.6x the code: the blocks that were
    // missing formulas were joining separate rings into one blob, and having
    // their own statements splits them apart again.
    check(`the largest circle holds ${loopMax} blocks`, loopMax === 432, `${loopMax}`);
    // A block that reads a sensor is nought hops from one. Trivially true, and
    // it is what catches the walk being seeded from the wrong end.
    const seeded = b.inputs.flatMap((x) => x.blocks).filter((id) => r.fromInput.get(id) !== 0);
    check('every block that reads a sensor is nought hops from one',
        seeded.length === 0, `${seeded.length} are not`);
}

// --------------------------------------------------------------------------
// the map, and how much of the ECU it cannot name
// --------------------------------------------------------------------------
{
    const m = systemMap(g, 'ja');
    check(`${m.total - m.unplaced.length} of ${m.total} blocks carry a section, in ${m.regions.length} regions`,
        m.total - m.unplaced.length === PIN.mapPlaced
        && m.unplaced.length === PIN.mapUnplaced
        && m.regions.length === PIN.mapRegions,
        `pinned ${PIN.mapPlaced} / ${PIN.mapUnplaced} / ${PIN.mapRegions}`);

    // THE property of this map: the unnamed part is the biggest thing on it.
    // If a re-vendor ever makes a named region larger, the drawing stops being
    // a statement about its own coverage and this should fail.
    const biggest = m.regions[0]?.blocks.length ?? 0;
    check(`the unclassified region (${m.unplaced.length}) is larger than the largest named one (${biggest})`,
        m.unplaced.length > biggest, `${m.unplaced.length} vs ${biggest}`);

    // Every region has a name from the Funktionsrahmen, not a bare number.
    const nameless = m.regions.filter((x) => x.title === x.section);
    check('every named region really has a name', nameless.length === 0,
        nameless.map((x) => x.section).join(', '));

    // The same map every time, whatever order anything was read in.
    const again = systemMap(g, 'en');
    check('the grouping does not depend on the language',
        again.regions.length === m.regions.length && again.unplaced.length === m.unplaced.length,
        `${again.regions.length} / ${again.unplaced.length}`);
}

// --------------------------------------------------------------------------
// the listing's own gutter
// --------------------------------------------------------------------------
{
    let strayRail = 0;
    let overLane = 0;
    let checked = 0;
    for (const f of blocks.slice(0, 120)) {
        const d = buildDiagram(g, f.id, { ctx, maxPorts: 14, depth: 1, expanded: new Set() });
        if (!d) continue;
        const listing = buildCode(g, d, ctx);
        checked += 1;
        for (const r of listing.rails) {
            const span = listing.spans.find((sp) => r.from >= sp.at && r.from < sp.end);
            if (!span || r.to.some((t) => t < span.at || t >= span.end)) strayRail += 1;
            if (r.lane >= 10) overLane += 1;
        }
    }
    check(`${checked} listings drew their own gutter`, checked > 0);
    check('no rail in the listing leaves the block it belongs to', strayRail === 0, `${strayRail} stray`);
    check('the listing gutter keeps to its lane budget', overLane === 0, `${overLane} past it`);
}

// --------------------------------------------------------------------------
// the numbers the READER is shown
// --------------------------------------------------------------------------
//
// Everything above pins what the code computes. Nothing pinned what the hint
// strings SAY, and all three that quoted a measurement had gone stale: the
// actuator hint still said 33 outputs, the loop hint still said "212 of the
// 534 in a circle of 502", and the system-map hint still said 25 functions are
// documented directly -- a number corrected in system-map.ts and never
// corrected in the sentence on screen.
//
// A wrong comment misleads whoever edits the file. A wrong hint misleads the
// person tuning the car, which is worse, so the strings are pinned too.
{
    const copy = readFileSync('src/lib/calibration-graph/calib-i18n.ts', 'utf8');
    // A number must be POSITIVE to be evidence, and must appear with digit
    // boundaries. `copy.includes(String(0))` is true of almost any file, so the
    // first version of this check passed while reading `loop` instead of
    // `loopSize` and asserting "the hint says 1384 / 0 / 0" — a check that ran
    // and proved nothing, which is worse than one that fails.
    const says = (n) => {
        if (!(n > 0)) return false;
        return [n.toLocaleString('en-US'), String(n)].some((form) =>
            new RegExp(`(?<![0-9,])${form}(?![0-9])`).test(copy),
        );
    };

    const bb = boundary(g);
    check(`the actuator hint says ${bb.outputs.length}`, says(bb.outputs.length));
    check(`the sensor hint says ${bb.inputs.length}`, says(bb.inputs.length));

    const rr = reach(g);
    const withFormulas = raw.nodes.filter((n) => n.t === 'func' && n.stmts?.length);
    let inLoop = 0;
    let biggest = 0;
    for (const f of withFormulas) {
        const size = rr.loopSize.get(f.id) ?? 0;
        if (size > 1) inLoop += 1;
        biggest = Math.max(biggest, size);
    }
    check(`the loop hint says ${withFormulas.length} / ${inLoop} / ${biggest}`,
        says(withFormulas.length) && says(inLoop) && says(biggest));

    // 25 is the number of `documented` EDGES; 12 is the number of FUNCTIONS
    // they name. The hint quoted the edge count as if it were functions.
    const funcIds = new Set(raw.nodes.filter((n) => n.t === 'func').map((n) => n.id));
    const documented = new Set(
        raw.edges.filter((e) => e.o === 'fr' && e.k === 'documented' && funcIds.has(e.s)).map((e) => e.s),
    );
    check(`the system-map hint says ${documented.size} documented functions`, says(documented.size));
}

console.log(fails === 0 ? '\nverify-cal-logic: all checks passed' : `\nverify-cal-logic: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
