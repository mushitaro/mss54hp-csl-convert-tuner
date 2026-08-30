/**
 * Why a cell with plenty of samples still does not get written.
 *
 * Sample count is the FIRST of five tests, not the only one, and on a real drive it is rarely the
 * one that fails. This walks the same grid `calculateNewVEMap` walks — via the calculator's own
 * `createGrid` / `accumulatePoint`, so nothing here is a second implementation of the binning —
 * and prints, for every cell, the statistic each gate actually looked at against the bound it had
 * to clear.
 *
 * The five, in the order the calculator tests them:
 *
 *   thin-count       rawCount   >= minCellSamples (10)     were you here at all
 *   thin-weight      weightSum  >= minCellWeight (5.0)     were you here LONG enough, and CENTRED
 *   shared-evidence  selfShare  >= 0.30                    is the evidence about THIS cell
 *   scatter          sd         <= 0.08                    is it one condition or two averaged
 *   imprecise        stdErr     <= 0.005                   is the MEAN pinned finely enough
 *
 * The one that surprises people is `thin-weight`, because it is not a second sample count. A
 * sample is spread over the FOUR cells bracketing it by bilinear weight, so a cell only collects
 * the whole of a sample that lands exactly on its own axis crossing. Ten samples sitting near a
 * corner between four cells contribute about 0.25 each — weightSum 2.5 against a bar of 5.0 —
 * while ten samples parked dead centre contribute 1.0 each. Same count, four times the weight.
 *
 *     node scripts/analyze-cell-gates.mjs <session-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) {
    console.error('usage: node scripts/analyze-cell-gates.mjs <session-dir>');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.gates-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator, MIN_SELF_SHARE } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
    "export { MAX_SAMPLE_SD, MAX_STD_ERR, LOW_LOAD_TOP_ROW } from '@/lib/ve-calculator/lowLoadTuner';",
    "export { resolveRfKorr } from '@/lib/types';",
    "export { BinaryParser } from '@/lib/binary-engine/parser';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.gates-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const M = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const rawLog = read('log.json');
const session = read('session.json');
const binaries = read('binaries.json');
const cfg = session.tuneSettings.filterConfig;
const base = Buffer.from(binaries.base, 'base64');
const ab = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
// THE BASE TABLE, read from the binary — NOT `session.veMapSnapshot`.
//
// `veMapSnapshot` is the TUNED map (db/schema.ts: "TUNED map. Read by useComparison for the
// db: diff variants") — the OUTPUT of the derivation that session ran. Feeding it back in as
// the current map derives a correction on top of a correction, while the log it is derived
// from was recorded against the BASE that was actually in the ECU.
//
// On session #1 the two differ in 21 cells — VE's 15 plus LOW LOAD's 8, less the overlap — and
// the error is not small: 85 % at 2100 rpm reads 0.687 in the binary against 0.579 in the
// snapshot, so the correction came out -5.2 % where the truth is -16.6 %.
const veMap = new M.BinaryParser(ab).getVETable();
const egt = M.readEgtTables(ab);
const air = { curves: M.readRfPtKorrCurves(ab) };

const processed = M.processLogData(rawLog, session.baseFileName, cfg, session.tuneSettings.interpolationTable);
const calc = new M.VECalculator();
const ve = calc.annotateRfKorr(veMap, processed.data, egt, air);

// The same grid the write path builds, through the calculator's own methods.
const plan = M.resolveRfKorr({
    rfKorrSource: cfg.rfKorrSource, rfKorrMode: cfg.rfKorrMode, applyRfKorr: cfg.applyRfKorr,
});
const grid = calc.createGrid();
for (const p of ve) calc.accumulatePoint(grid, p, plan, null, undefined);

const MIN_SAMPLES = cfg.minVeCellSamples ?? 10;
const MIN_WEIGHT = cfg.minVeCellWeight ?? 5.0;
const rpmAxis = veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
const loadAxis = veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;

const rows = [];
for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
        const c = grid[i][j];
        if (!c || c.rawCount === 0) continue;
        const owns = i > M.LOW_LOAD_TOP_ROW;
        const selfShare = c.weightSum > 0 ? c.sumWeightSq / c.weightSum : 0;
        const wMean = c.weightSum > 0 ? c.sumStftWeighted / c.weightSum : 0;
        const wVar = c.weightSum > 0
            ? Math.max(0, c.sumStftSqWeighted / c.weightSum - wMean * wMean) : 0;
        const sd = Math.sqrt(wVar);
        const nEff = selfShare > 0 ? c.weightSum / selfShare : 0;
        const stdErr = nEff > 0 ? sd / Math.sqrt(nEff) : Infinity;
        const reject = !owns ? 'out-of-band'
            : c.rawCount < MIN_SAMPLES ? 'thin-count'
                : c.weightSum < MIN_WEIGHT ? 'thin-weight'
                    : selfShare < M.MIN_SELF_SHARE ? 'shared-evidence'
                        : sd > M.MAX_SAMPLE_SD ? 'scatter'
                            : stdErr > M.MAX_STD_ERR ? 'imprecise' : null;
        rows.push({
            i, j, load: loadAxis[i], rpm: rpmAxis[j],
            n: c.rawCount, w: c.weightSum, selfShare, sd, stdErr, nEff, reject,
            correction: wMean,
        });
    }
}

console.log(NL + '='.repeat(96));
console.log(session.label + '  —  why cells with samples are not written');
console.log('='.repeat(96));
console.log('  bounds:  count >= ' + MIN_SAMPLES + '   weight >= ' + MIN_WEIGHT.toFixed(1)
    + '   selfShare >= ' + M.MIN_SELF_SHARE + '   sd <= ' + M.MAX_SAMPLE_SD
    + '   stdErr <= ' + M.MAX_STD_ERR);

const owned = rows.filter(r => r.reject !== 'out-of-band');
const written = owned.filter(r => r.reject === null);
console.log('  cells with any sample: ' + rows.length
    + '   VE owns: ' + owned.length + '   written: ' + written.length);

// THE QUESTION: cells that cleared the sample count and still did not get written.
const passedCount = owned.filter(r => r.n >= MIN_SAMPLES);
const blocked = passedCount.filter(r => r.reject !== null);
console.log(NL + '  cells with ' + MIN_SAMPLES + '+ samples: ' + passedCount.length
    + '   of those, written: ' + (passedCount.length - blocked.length)
    + '   BLOCKED BY A LATER GATE: ' + blocked.length);

if (blocked.length) {
    const by = {};
    for (const r of blocked) by[r.reject] = (by[r.reject] ?? 0) + 1;
    console.log('  blocked by: ' + JSON.stringify(by));
    console.log(NL + '  aq_rel_rf    rpm    count   weight  selfShare      sd    stdErr   nEff   blocked by');
    console.log('  ' + '-'.repeat(92));
    blocked.sort((a, b) => b.n - a.n);
    for (const r of blocked) {
        // Marker AFTER its own value. Leading it reads as marking the next column, which is
        // exactly the misreading this table exists to prevent.
        const mark = (v, ok) => v + (ok ? ' ' : '*');
        console.log('  ' + String(r.load).padStart(8) + ' %'
            + String(r.rpm).padStart(7)
            + mark(String(r.n).padStart(7), r.n >= MIN_SAMPLES)
            + mark(r.w.toFixed(2).padStart(8), r.w >= MIN_WEIGHT)
            + mark(r.selfShare.toFixed(3).padStart(8), r.selfShare >= M.MIN_SELF_SHARE)
            + mark(r.sd.toFixed(4).padStart(8), r.sd <= M.MAX_SAMPLE_SD)
            + mark(r.stdErr.toFixed(4).padStart(9), r.stdErr <= M.MAX_STD_ERR)
            + r.nEff.toFixed(1).padStart(7)
            + '   ' + r.reject);
    }
    console.log('  ' + '-'.repeat(92));
    console.log('  * marks the statistic that is outside its bound.');
}

// And the mirror image, so the contrast is visible: what a written cell looks like.
if (written.length) {
    console.log(NL + '  For contrast, the cells that DID pass:' + NL);
    console.log('  aq_rel_rf    rpm    count   weight  selfShare      sd    stdErr   nEff');
    written.sort((a, b) => b.n - a.n);
    for (const r of written.slice(0, 8)) {
        console.log('  ' + String(r.load).padStart(8) + ' %'
            + String(r.rpm).padStart(7)
            + String(r.n).padStart(8)
            + r.w.toFixed(2).padStart(9)
            + r.selfShare.toFixed(3).padStart(10)
            + r.sd.toFixed(4).padStart(8)
            + r.stdErr.toFixed(4).padStart(10)
            + r.nEff.toFixed(1).padStart(7));
    }
}

// The weight-per-sample ratio is the whole of the thin-weight surprise, so state it directly.
console.log(NL + '  weight per sample (1.00 = every sample landed dead centre on this cell):' + NL);
const ratios = owned.filter(r => r.n >= 5).map(r => ({ ...r, ratio: r.w / r.n }));
ratios.sort((a, b) => a.ratio - b.ratio);
const show = (r) => '  ' + String(r.load).padStart(8) + ' % ' + String(r.rpm).padStart(6)
    + '   ' + String(r.n).padStart(4) + ' samples -> weight ' + r.w.toFixed(2).padStart(7)
    + '   ratio ' + r.ratio.toFixed(3) + (r.reject ? '   (' + r.reject + ')' : '   (written)');
console.log('  --- the most spread-out cells ---');
for (const r of ratios.slice(0, 6)) console.log(show(r));
console.log('  --- the most centred cells ---');
for (const r of ratios.slice(-6).reverse()) console.log(show(r));
