// Checks the vendored calibration graph and its adaptation into CalParamDefs.
//
// Counts are PINNED to the shipped artifact: a re-sync that changes them should
// change this file in the same commit, deliberately. The read-only set is
// pinned BY NAME because each lock encodes a decision (see lib/calibration/
// types.ts EditLockReason) — a lock appearing or disappearing silently is
// exactly the failure this script exists to catch. So is the other direction:
// the four params that START at 0x4000/0xC000 sit one byte past the checksum
// slots and a closed-interval overlap test would refuse them falsely.
//
// Runner: node --experimental-strip-types --import ./scripts/ts-resolve.mjs

import { readFileSync } from 'node:fs';
import { buildCatalog } from '../src/lib/calibration/catalog.ts';

let fails = 0;
function check(label, ok, detail = '') {
    if (ok) { console.log(`  ok  ${label}`); return; }
    fails += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const graph = JSON.parse(readFileSync('public/data/calibration-graph.json', 'utf8'));

// ---- artifact shape --------------------------------------------------------

const nodeCounts = {};
for (const n of graph.nodes) nodeCounts[n.t] = (nodeCounts[n.t] ?? 0) + 1;
check('2529 params in the artifact', nodeCounts.param === 2529, `got ${nodeCounts.param}`);
check('1705 funcs', nodeCounts.func === 1705, `got ${nodeCounts.func}`);
check('2560 ram symbols', nodeCounts.ram === 2560, `got ${nodeCounts.ram}`);
check('71 categories', graph.categories.length === 71, `got ${graph.categories.length}`);
check('27620 edges', graph.edges.length === 27620, `got ${graph.edges.length}`);
check('39 frDocs', graph.frDocs.length === 39);

const withStmts = graph.nodes.filter(n => n.t === 'func' && n.stmts?.length).length;
check('534 funcs carry recovered formulas', withStmts === 534, `got ${withStmts}`);

// The strip: no baked values anywhere, no frpage excerpts.
const baked = graph.nodes.filter(n =>
    n.t === 'param' && (n.value !== undefined || n.raw !== undefined ||
        Object.values(n.axes ?? {}).some(a => a.values !== undefined)));
check('no baked param values survived the strip', baked.length === 0, baked.slice(0, 3).map(n => n.name).join(' '));
const excerpts = graph.nodes.filter(n => n.t === 'frpage' && n.excerpt !== undefined);
check('no frpage excerpts survived the strip', excerpts.length === 0);

// ---- adaptation ------------------------------------------------------------

const cat = buildCatalog(graph);

check('adaptation reports zero problems', cat.problems.length === 0,
    `${cat.problems.length}: ${cat.problems.slice(0, 5).join(' · ')}`);

const kinds = {};
for (const p of cat.params) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
check('1782 constants / 394 maps / 353 curves',
    kinds.constant === 1782 && kinds.map === 394 && kinds.curve === 353,
    JSON.stringify(kinds));

check('no duplicate names', cat.byName.size === cat.params.length,
    `${cat.params.length - cat.byName.size} collisions`);

// Every run inside the 64 KB partial, clear of both checksum slots, on the
// right bank. (Adaptation already refuses violations into `problems`; this
// re-checks the survivors independently.)
const SLOTS = [[0x3FFC, 0x4000], [0xBFFC, 0xC000]];
let outside = 0, onSlot = 0, wrongBank = 0;
for (const p of cat.params) {
    if (!p.run) continue;
    const start = p.run.address;
    const end = start + p.run.count * (p.run.bits / 8);
    if (start < 0 || end > 0x10000) outside++;
    if (SLOTS.some(([cs, ce]) => start < ce && end > cs) && !p.lock.locked) onSlot++;
    if ((start < 0x8000 ? 'slave' : 'master') !== p.bank) wrongBank++;
}
check('every run inside the partial BIN', outside === 0, `${outside} outside`);
check('no unlocked run overlaps a checksum slot', onSlot === 0);
check('bank agrees with address on every run', wrongBank === 0, `${wrongBank} disagree`);

// The four slot-adjacent params must NOT be refused (half-open interval pin).
for (const name of ['K_TEFC_CFG', 'K_TEFC_DELAY', 'K_START_SGANG', 'K_START_BEGINN']) {
    const p = cat.byName.get(name);
    check(`${name} (slot-adjacent) is editable`, !!p && !p.lock.locked,
        p ? `locked: ${p.lock.locked && p.lock.reason}` : 'missing');
}

// ---- the read-only set, by name -------------------------------------------

const locked = new Map();
for (const p of cat.params) {
    if (p.lock.locked) locked.set(p.name, p.lock.reason);
}
const expectLocked = [
    ['K_VERS_UP_S', 'no-address'],
    ['K_BELU_DIAG_ANLAUF_SPERRE', 'width-32'],
    ['K_RF_DIAG_SCHWELLE', 'k-linked'],
    ['KF_LLR_QVS_GRUND', 'idle-sealed'],
    ['K_LAA_TMOT_MIN', 'app-managed'],
    ['k_rf_cfg', 'app-managed'],
    ['K_TE_TVTE_GA', 'app-managed'],
];
for (const [name, reason] of expectLocked) {
    check(`${name} locked: ${reason}`, locked.get(name) === reason, `got ${locked.get(name)}`);
}
// KF_BZ_WDK_VL carries an alias suffix in the XDF title.
const wdkVl = [...locked.entries()].find(([n]) => n.startsWith('KF_BZ_WDK_VL'));
check('KF_BZ_WDK_VL locked: app-managed', wdkVl?.[1] === 'app-managed', `got ${wdkVl?.[1]}`);
check(`exactly ${expectLocked.length + 1} locked params`, locked.size === expectLocked.length + 1,
    `got ${locked.size}: ${[...locked.keys()].join(' ')}`);

// ---- geometry and shape pins ----------------------------------------------

const rawAxes = cat.params.filter(p =>
    (p.xAxis?.source === 'stored' && !p.xAxis.mathOk) ||
    (p.yAxis?.source === 'stored' && !p.yAxis.mathOk));
check('exactly one param decodes an axis raw (kl_rg_temp_dichte_korr)',
    rawAxes.length === 1 && rawAxes[0].name === 'kl_rg_temp_dichte_korr',
    rawAxes.map(p => p.name).join(' '));

const labelAxes = cat.params.filter(p => p.xAxis?.source === 'labels' || p.yAxis?.source === 'labels');
check('241 params have label-only axes', labelAxes.length === 241, `got ${labelAxes.length}`);

// Exactly one pair of aliased (overlapping) value runs in the whole catalog.
const runs = cat.params
    .filter(p => p.run)
    .map(p => ({ name: p.name, start: p.run.address, end: p.run.address + p.run.count * (p.run.bits / 8) }))
    .sort((a, b) => a.start - b.start);
const overlapPairs = [];
for (let i = 0; i < runs.length - 1; i++) {
    for (let j = i + 1; j < runs.length && runs[j].start < runs[i].end; j++) {
        overlapPairs.push(`${runs[i].name}~${runs[j].name}`);
    }
}
check('exactly one aliased run pair (kl_tog_level_can ~ k_tog_rp_sample_count_min)',
    overlapPairs.length === 1 && overlapPairs[0].includes('k_tog_rp_sample_count_min'),
    overlapPairs.join(' · '));

// Inverse synthesis: everything editable is affine or bisection — the scan
// fallback exists but nothing in this XDF should need it.
const inv = {};
for (const p of cat.params) {
    if (p.run && p.runMathOk) inv[p.run.scaling.inverse ?? 'plain'] = (inv[p.run.scaling.inverse ?? 'plain'] ?? 0) + 1;
}
check('inverses: 2466 affine + 60 bisection, 0 scan',
    inv.affine === 2466 && inv.bisection === 60 && !inv.scan, JSON.stringify(inv));

if (fails) {
    console.error(`\n${fails} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');
