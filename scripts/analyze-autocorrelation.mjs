/**
 * How much of a cell's sample count is actually independent information.
 *
 * Every precision gate in this app divides by a sample count, and a count only means what it says
 * if the samples are independent draws. They are not. `la_f_regler` is a two-point controller: it
 * oscillates by construction at 1-2 Hz, and the log runs at roughly 4-5 Hz, so consecutive samples
 * are two to four points on one swing of the same limit cycle.
 *
 * For an AR(1) process with lag-1 autocorrelation `rho`, the variance of the mean is inflated by
 * `(1 + rho) / (1 - rho)`, so the honest independent count is
 *
 *     n_indep = n_eff * (1 - rho) / (1 + rho)
 *
 * where `n_eff` is Kish's `(sum w)^2 / sum w^2` — which corrects for unequal WEIGHTS and nothing
 * else. The two corrections are separate and compose.
 *
 * WHAT THIS SCRIPT IS FOR. `AUTOCORR_FALLBACK` in calculator.ts is the rho a cell uses when it has
 * too few consecutive pairs to estimate its own. That constant has to come from somewhere, and
 * "somewhere" is this measurement over every drive available — not a default inherited from
 * another tool, which is how the thresholds it replaces were chosen.
 *
 * METHOD, and the two traps in it:
 *
 *   1. Only pairs CONSECUTIVE IN THE LOG count. A cell is visited, left, and revisited; a pair
 *      straddling a gap of minutes is independent by construction and would drag rho toward zero.
 *      The gap test uses each log's own median sample interval rather than a fixed number of
 *      seconds, because the rate has changed across the drives in this repository.
 *   2. Deviations are taken from the CELL's mean, not the drive's. Otherwise rho would be reading
 *      the difference between cells — which is real structure, not serial correlation.
 *
 * A useful cross-check falls out for free: the correlation time `tau = -dt / ln(rho)` should land
 * near the period of the limit cycle the controller is known to run. If it does not, this is
 * measuring something else and the number should not be trusted.
 *
 *     node scripts/analyze-autocorrelation.mjs <dir> [<dir> ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dirs = process.argv.slice(2);
if (!dirs.length) {
    console.error('usage: node scripts/analyze-autocorrelation.mjs <dir> [<dir> ...]');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.acorr-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
    "export { LOW_LOAD_TOP_ROW } from '@/lib/ve-calculator/lowLoadTuner';",
    "export { BinaryParser } from '@/lib/binary-engine/parser';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.acorr-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const M = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const nearest = (a, v) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - v); if (d < bd) { bd = d; bi = i; } }
    return bi;
};
const trimOf = (p) => {
    const b = [p.stft1, p.stft2].filter(v => v !== undefined);
    if (!b.length) return undefined;
    const s = b.reduce((a, c) => a + c, 0) / b.length;
    const l = [p.ltft1, p.ltft2].filter(v => v !== undefined);
    return s * (l.length ? l.reduce((a, c) => a + c, 0) / l.length : 1);
};
/** Pearson correlation of a list of [x, y] deviation pairs. */
const corr = (pairs) => {
    if (pairs.length < 2) return null;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [a, b] of pairs) { sxy += a * b; sxx += a * a; syy += b * b; }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
};

const MIN_PAIRS_PER_CELL = 20;
const allPairs = [];
const allCellRhos = [];
const rows = [];

for (const dir of dirs) {
    const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
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

    const processed = M.processLogData(read('log.json'), session.baseFileName, cfg,
        session.tuneSettings.interpolationTable);
    const calc = new M.VECalculator();
    const ve = calc.annotateRfKorr(veMap, processed.data, M.readEgtTables(ab),
        { curves: M.readRfPtKorrCurves(ab) });
    const rpmAxis = veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
    const loadAxis = veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;

    const times = ve.map(p => p.time).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const dt = gaps.length ? q(gaps, 0.5) : 0.25;

    const cells = new Map();
    for (const p of ve) {
        const c = trimOf(p) * (p.rfKorr ?? 1);
        if (!(c > 0)) continue;
        const k = nearest(rpmAxis, p.rpm) + '|' + nearest(loadAxis, p.correctedLoad ?? p.rawLoad);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ t: p.time, c });
    }

    const sPairs = [];
    const cellRhos = [];
    for (const arr of cells.values()) {
        if (arr.length < 10) continue;
        arr.sort((a, b) => a.t - b.t);
        const mean = arr.reduce((a, b) => a + b.c, 0) / arr.length;
        const pairs = [];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i].t - arr[i - 1].t > dt * 1.6) continue;   // trap 1: consecutive in the LOG
            pairs.push([arr[i - 1].c - mean, arr[i].c - mean]); // trap 2: deviations from THIS cell
        }
        sPairs.push(...pairs);
        if (pairs.length >= MIN_PAIRS_PER_CELL) {
            const r = corr(pairs);
            if (r !== null) cellRhos.push(r);
        }
    }
    const rho = corr(sPairs);
    allPairs.push(...sPairs);
    allCellRhos.push(...cellRhos);
    rows.push({ label: session.label, dt, pairs: sPairs.length, rho, cellRhos });
}

const infl = (r) => (r !== null && r > -1 && r < 1) ? (1 + r) / (1 - r) : null;
const tau = (r, dt) => (r !== null && r > 0 && r < 1) ? -dt / Math.log(r) : null;

console.log(NL + '='.repeat(88));
console.log('Lag-1 autocorrelation of the per-sample correction, within a VE cell');
console.log('='.repeat(88));
console.log('  session        dt(s)    pairs     rho    variance x    tau(s)   cells w/ own rho');
for (const r of rows) {
    const i = infl(r.rho), t = tau(r.rho, r.dt);
    console.log('  ' + String(r.label).padEnd(14)
        + r.dt.toFixed(3).padStart(6)
        + String(r.pairs).padStart(9)
        + (r.rho === null ? '     n/a' : r.rho.toFixed(3).padStart(8))
        + (i === null ? '        -' : i.toFixed(1).padStart(14))
        + (t === null ? '        -' : t.toFixed(2).padStart(10))
        + String(r.cellRhos.length).padStart(19));
}

const pooled = corr(allPairs);
console.log(NL + '  POOLED over ' + dirs.length + ' drives:  pairs ' + allPairs.length
    + '   rho ' + pooled.toFixed(3));
console.log('  variance of the mean inflated x' + infl(pooled).toFixed(1)
    + '   =>  standard error x' + Math.sqrt(infl(pooled)).toFixed(2));

if (allCellRhos.length) {
    console.log(NL + '  PER-CELL rho (cells with >=' + MIN_PAIRS_PER_CELL + ' consecutive pairs, n='
        + allCellRhos.length + '):');
    console.log('    p05 ' + q(allCellRhos, 0.05).toFixed(3)
        + '   p25 ' + q(allCellRhos, 0.25).toFixed(3)
        + '   med ' + q(allCellRhos, 0.50).toFixed(3)
        + '   p75 ' + q(allCellRhos, 0.75).toFixed(3)
        + '   p95 ' + q(allCellRhos, 0.95).toFixed(3));
    console.log('    negative rho in ' + allCellRhos.filter(r => r < 0).length + ' cells'
        + '   (an oscillation sampled near its own period can alias to anti-correlation)');
}

console.log(NL + '  CROSS-CHECK. tau is the correlation time. `la_f_regler` is documented as a');
console.log('  1-2 Hz limit cycle, so tau should land near 0.5-1.0 s. A tau far from that means');
console.log('  this is measuring something other than the controller and must not be trusted.');
console.log('');
