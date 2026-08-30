/**
 * Two drives recorded on the SAME base binary, cell by cell — the out-of-sample test.
 *
 * ## Why the same base is the whole point
 *
 * The chain rule says the next session's BASE is the last one's flash, so consecutive drives are
 * normally measured against different bytes and their demands cannot be compared: a cell that moved
 * SHOULD read differently the second time. Two SIBLINGS — both children of one flash, neither
 * flashed between them — are measured against identical bytes, so the same cell's demand is the
 * same quantity twice.
 *
 * That is the only shape of evidence that can test what `VeMethod` claims for DIRECT: "under DIRECT
 * that question is answered by the next drive rather than by refusing this one". A single drive
 * cannot check it, and a chained pair cannot either.
 *
 * ## What it prints, and how to read each part
 *
 *   1. DIRECT vs STATISTICAL per drive — how many cells the shipped method writes, and which
 *      statistical gate would have refused each one. The gap is what DIRECT is spending.
 *   2. THE PAIRED DEMAND — the same cell, twice. `r` near 1 would mean the correction is a property
 *      of the engine; `sd(B-A)` larger than `sd(A)` means the drive-to-drive scatter is larger than
 *      the signal being written. The variance split reports both parts rather than one ratio.
 *   3. OUT OF SAMPLE — apply one drive's correction to the OTHER drive's evidence. This is the
 *      question a tuner actually has: does flashing this make the next drive's error smaller?
 *   4. The cells, sorted by disagreement.
 *
 * `demandMap` is compared, not `newMap`: the demand is what the drive MEASURED, while the write is
 * the demand after the clamp and the authority, and mixing the two would credit a policy layer with
 * agreement or blame it for disagreement.
 *
 * SMALL n. Two drives overlap in as few as a dozen cells, because each visits its own part of the
 * table. The correlation is printed with its interval for that reason: this design answers "is the
 * repeatable part anywhere near the size of what is being written", not "what is r".
 *
 *     node scripts/analyze-same-base-pair.mjs <session-dir-A> <session-dir-B>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dirs = process.argv.slice(2);
if (dirs.length !== 2) {
    console.error('usage: node scripts/analyze-same-base-pair.mjs <session-dir-A> <session-dir-B>');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.pair-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
    "export { BinaryPatcher } from '@/lib/binary-engine/patcher';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.pair-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const M = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

/** One session, through the real filter and the real calculator, under both methods. */
function derive(dir) {
    const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    const session = read('session.json');
    const binaries = read('binaries.json');
    const cfg = session.tuneSettings.filterConfig;
    const base = Buffer.from(binaries.base, 'base64');
    const ab = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
    // The BASE table read from the binary, never `veMapSnapshot` — that is the session's OUTPUT,
    // and feeding it back derives a correction on top of a correction. Same note as analyze:session.
    const veMap = new M.BinaryPatcher(ab).getVETable();
    const egt = M.readEgtTables(ab);
    const curves = M.readRfPtKorrCurves(ab);
    const processed = M.processLogData(read('log.json'), session.baseFileName, cfg,
        session.tuneSettings.interpolationTable);
    const calc = new M.VECalculator();
    const ve = calc.annotateRfKorr(veMap, processed.data, egt,
        { curves, assumedPressureMbar: cfg.assumedAmbientPressure });
    return {
        session, veMap,
        direct: calc.calculateNewVEMap(veMap, ve, { egt }),
        stat: calc.calculateNewVEMap(veMap, ve, { egt, veMethod: 'statistical' }),
    };
}

const [A, B] = dirs.map(derive);
const nameA = path.basename(dirs[0]), nameB = path.basename(dirs[1]);
const rpmAxis = A.veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
const loadAxis = A.veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;

const RULE = '='.repeat(100);
console.log(NL + RULE);
console.log('SAME-BASE PAIR   ' + A.session.label + '  vs  ' + B.session.label);
console.log(RULE);
console.log('  base A  ' + A.session.baseSha256);
console.log('  base B  ' + B.session.baseSha256);
if (A.session.baseSha256 !== B.session.baseSha256) {
    console.log(NL + '  THE TWO BASES DIFFER. A cell that moved between the drives SHOULD read');
    console.log('  differently the second time, so nothing below separates the tune from the engine.');
    console.log('  Pick two sessions that are siblings — same parent flash, none between them.');
    process.exit(1);
}
console.log('  identical — a cell-by-cell comparison is exact');

// ---------------------------------------------------------------- 1. what each method would write
console.log(NL + '1. DIRECT vs STATISTICAL, per drive' + NL);
for (const [name, r] of [[nameA, A], [nameB, B]]) {
    let direct = 0, statistical = 0;
    const why = {};
    for (let i = 0; i < r.direct.acceptedMap.length; i++) {
        for (let j = 0; j < r.direct.acceptedMap[i].length; j++) {
            if (r.direct.acceptedMap[i][j]) {
                direct++;
                if (!r.stat.acceptedMap[i][j]) {
                    const k = r.stat.rejectMap[i][j];
                    why[k] = (why[k] ?? 0) + 1;
                }
            }
            if (r.stat.acceptedMap[i][j]) statistical++;
        }
    }
    console.log('   ' + name + ' ' + r.session.label + '   DIRECT writes ' + direct
        + '   STATISTICAL would write ' + statistical);
    console.log('        of those ' + direct + ', refused by a statistical gate: ' + JSON.stringify(why));
}

// ---------------------------------------------------------------- 2. the paired demand
const cells = [];
for (let i = 0; i < A.direct.hitMap.length; i++) {
    for (let j = 0; j < A.direct.hitMap[i].length; j++) {
        const na = A.direct.hitMap[i][j], nb = B.direct.hitMap[i][j];
        if (!na || !nb) continue;
        if (A.direct.rejectMap[i][j] === 'out-of-band') continue;   // LOW LOAD's band, not VE's
        cells.push({
            rpm: rpmAxis[j], load: loadAxis[i], old: A.veMap.data[i][j], na, nb,
            da: A.direct.demandMap[i][j], db: B.direct.demandMap[i][j],
            wroteA: A.direct.acceptedMap[i][j], wroteB: B.direct.acceptedMap[i][j],
        });
    }
}
if (!cells.length) {
    console.log(NL + '  The two drives share NO cell in the VE band. Nothing to compare.');
    process.exit(0);
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const variance = a => { const m = mean(a); return mean(a.map(v => (v - m) ** 2)); };
const sd = a => Math.sqrt(variance(a));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.round(p * (s.length - 1))]; };
const line = a => 'sd ' + sd(a).toFixed(2) + '   p05 ' + q(a, .05).toFixed(2)
    + '  p50 ' + q(a, .5).toFixed(2) + '  p95 ' + q(a, .95).toFixed(2);

const pctA = cells.map(c => 100 * (c.da - 1));
const pctB = cells.map(c => 100 * (c.db - 1));
const diff = cells.map(c => 100 * (c.db - c.da));

console.log(NL + '2. WHAT THE TWO DRIVES DEMAND OF THE SAME CELL' + NL);
console.log('   cells with evidence in BOTH drives, in the VE band: ' + cells.length);
console.log('   demand ' + nameA.padEnd(6) + '%   ' + line(pctA));
console.log('   demand ' + nameB.padEnd(6) + '%   ' + line(pctB));
console.log('   B - A        %   ' + line(diff));

const flips = cells.filter(c => (c.da - 1) * (c.db - 1) < 0).length;
console.log('   sign disagreement: ' + flips + ' of ' + cells.length
    + '  (' + (100 * flips / cells.length).toFixed(0) + ' %)');

// Covariance IS the repeatable part: var(A) = var(truth) + var(noise_A), and the two drives'
// noise is independent, so cov(A,B) estimates var(truth) directly. Printed as two standard
// deviations rather than one ratio, because "how much of this is real" is the question.
const ma = mean(pctA), mb = mean(pctB);
let sxy = 0;
for (let k = 0; k < cells.length; k++) sxy += (pctA[k] - ma) * (pctB[k] - mb);
const cov = sxy / cells.length;
const r = cov / (sd(pctA) * sd(pctB));
console.log('   correlation r = ' + r.toFixed(3) + '   slope of B on A = ' + (cov / variance(pctA)).toFixed(3)
    + '   (1.00 = perfectly repeatable)');
// Fisher z, so the interval is reported rather than left for the reader to assume away.
if (cells.length > 3) {
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const half = 1.96 / Math.sqrt(cells.length - 3);
    const back = (v) => (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1);
    console.log('   95 % interval on r: ' + back(z - half).toFixed(2) + ' .. ' + back(z + half).toFixed(2)
        + '   (n = ' + cells.length + ')');
}
console.log('   repeatable component  sd ' + (cov > 0 ? Math.sqrt(cov).toFixed(2) : '0.00') + ' %'
    + '     per-drive noise  sd ' + Math.sqrt(Math.max(0, variance(pctA) - cov)).toFixed(2)
    + ' % / ' + Math.sqrt(Math.max(0, variance(pctB) - cov)).toFixed(2) + ' %');

console.log(NL + '   disagreement against evidence (the smaller raw count of the two):');
for (const [lo, hi] of [[0, 10], [10, 30], [30, 100], [100, Infinity]]) {
    const sub = cells.filter(c => Math.min(c.na, c.nb) >= lo && Math.min(c.na, c.nb) < hi);
    if (!sub.length) continue;
    const d = sub.map(c => Math.abs(100 * (c.db - c.da)));
    console.log('     n in [' + lo + ',' + (hi === Infinity ? 'inf' : hi) + ')'.padEnd(2)
        + '  cells ' + String(sub.length).padStart(3) + '   mean |B-A| ' + mean(d).toFixed(2) + ' %');
}

// ---------------------------------------------------------------- 3. out of sample
console.log(NL + '3. OUT OF SAMPLE — does one drive’s correction reduce the OTHER drive’s error?' + NL);
console.log('   before = |demand_other - 1|            the other drive’s error against the shared base');
console.log('   after  = |demand_other - demand_this|  what would remain had this drive’s write gone in');
for (const [self, other, wrote, tag] of [
    ['da', 'db', 'wroteA', nameA + ' -> ' + nameB],
    ['db', 'da', 'wroteB', nameB + ' -> ' + nameA],
]) {
    const sub = cells.filter(c => c[wrote]);
    if (!sub.length) { console.log('   ' + tag + ': no shared cell was written by the first drive'); continue; }
    const before = sub.map(c => Math.abs(100 * (c[other] - 1)));
    const after = sub.map(c => Math.abs(100 * (c[other] - c[self])));
    const better = sub.filter((_, k) => after[k] < before[k]).length;
    console.log('   ' + tag + '   on the ' + sub.length + ' shared cells the first drive WROTE:');
    console.log('        mean |error|  before ' + mean(before).toFixed(2) + ' %   after ' + mean(after).toFixed(2)
        + ' %   -> ' + (mean(after) < mean(before) ? 'IMPROVED' : 'WORSE'));
    console.log('        cells improved: ' + better + ' / ' + sub.length);
}

// ---------------------------------------------------------------- 4. the cells
console.log(NL + '4. CELL BY CELL, sorted by disagreement' + NL);
console.log('    load    rpm    base     ' + (nameA + ' demand').padEnd(21)
    + (nameB + ' demand').padEnd(21) + 'B-A     wrote');
for (const c of [...cells].sort((x, y) => Math.abs(y.db - y.da) - Math.abs(x.db - x.da))) {
    const show = (v, n) => ((100 * (v - 1) >= 0 ? '+' : '') + (100 * (v - 1)).toFixed(2) + '% n=' + n);
    console.log('   ' + String(c.load).padStart(5) + '  ' + String(c.rpm).padStart(5) + '  ' + c.old.toFixed(3)
        + '   ' + show(c.da, c.na).padEnd(21) + show(c.db, c.nb).padEnd(21)
        + (100 * (c.db - c.da)).toFixed(2).padStart(7)
        + '   ' + (c.wroteA ? 'A' : '-') + (c.wroteB ? 'B' : '-'));
}
