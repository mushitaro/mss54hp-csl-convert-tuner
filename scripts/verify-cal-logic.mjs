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
import { makeContext, formatStatement } from '../src/lib/calibration-graph/logic-format.ts';
import { buildDiagram } from '../src/lib/calibration-graph/diagram-model.ts';
import { tokenize } from '../src/lib/calibration-graph/expr-tokens.ts';
import { buildAddressIndex, resolveAddress } from '../src/lib/calibration-graph/address.ts';
import { CHAR_W } from '../src/lib/calibration-graph/metrics.ts';

const PIN = {
    statements: 6164,
    guards: 6066,
    /** Guards read as a condition rather than left as C. */
    guardsPhrased: 5348,
    /** DAT_/UNK_/PTR_ occurrences, by which tier named them. */
    addrExact: 961,
    addrInferred: 1555,
    addrRegion: 1335,
    blocks: 534,
};

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
const blocks = raw.nodes.filter((n) => n.t === 'func' && n.stmts?.length);

let built = 0;
let overflow = 0;
let strayLeader = 0;
let railOutside = 0;
let unroutedSignal = 0;
let worst = '';

for (const f of blocks) {
    const d = buildDiagram(g, f.id, opts);
    if (!d) continue;
    built += 1;

    for (const n of d.nodes) {
        if (n.kind !== 'block' || !n.rows) continue;
        const textX = n.textX ?? 10;
        for (const row of n.rows) {
            const drawn = row.exprStart + row.tokens.reduce((a, t) => a + t.cells, 0);
            const end = textX + drawn * CHAR_W;
            if (end > n.w - 4) {
                overflow += 1;
                if (!worst) worst = `${f.name} / ${n.label}: ends at ${Math.round(end)} in a ${n.w} box`;
            }
        }
        // A rail lives in the gutter to the left of the text, never over it.
        // M and H carry an x; V carries a y, and reading it as an x said every
        // rail in the artifact was over the text.
        for (const rail of n.rails ?? []) {
            const xs = [...rail.d.matchAll(/([MH]) ([-\d.]+)/g)].map((m) => +m[2]);
            if (xs.some((x) => x > textX || x < 0)) railOutside += 1;
        }
    }

    for (const l of d.leaders) {
        const m = /^M ([-\d.]+) ([-\d.]+) H ([-\d.]+)$/.exec(l.d);
        if (!m) { strayLeader += 1; continue; }
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

console.log(fails === 0 ? '\nverify-cal-logic: all checks passed' : `\nverify-cal-logic: ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
