/**
 * The pressure coefficient, identified ACROSS two drives that traversed the range in opposite
 * directions — which is what a there-and-back drive is for, without needing one.
 *
 * ## Why one drive usually cannot answer it
 *
 * Barometric pressure inside a run moves because the car climbed or descended, and a car does that
 * monotonically. On the two drives this was written for, `corr(ln P, time)` is above 0.92, so the
 * within-drive slope carries every drift in the run — exhaust warming, fuel temperature, the driver
 * settling down — under pressure's name. Putting time in the model flips the sign on both. Nothing
 * is measured.
 *
 * NOT A LAW ABOUT DRIVES, a fact about those drives. Session #926 went up and came back down and
 * reads `corr(ln P, time) = -0.185`, which separates the two regressors inside one run: its
 * controlled coefficient is -0.076 against -0.135 uncontrolled, the same number either way rather
 * than a sign flip. `analyze:session` prints the correlation beside the coefficient for exactly
 * this reason — when a drive separates them, one drive is enough and this script is not needed.
 *
 * ## What two opposite drives give
 *
 *     #924   953 -> 990 mbar   descended
 *     #925   991 -> 952 mbar   climbed
 *
 * A cell visited in both was at DIFFERENT pressures at times that are unrelated, so the comparison
 * between them is free of each drive's own time trend. That is the round trip, split in two.
 *
 * ## The three things that would wreck it, and what is done about each
 *
 *   THE TUNE.   The second drive runs on the first one's flash, so a rewritten cell's correction is
 *               measured against a different base and would show a shift that has nothing to do
 *               with pressure. Only cells the flash left BYTE-IDENTICAL are used.
 *   THE DRIVES. Everything else that differed between the two — the air conditioning, the fuel, the
 *               weather, the roads — is a per-session constant. It is absorbed by the INTERCEPT:
 *               the slope is identified from how `d ln P` varies from cell to cell, not from the
 *               fact that one drive was lower than the other.
 *   TIME.       Each cell's series is detrended within its own session before the means are taken,
 *               so a drift inside either drive cannot reach the between-drive difference.
 *
 * If `d ln P` barely varies across cells, the slope is weakly identified and the report says so
 * rather than printing a number with a small standard error next to it.
 *
 *     node scripts/analyze-pressure-pair.mjs <session-a> <session-b>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dirs = process.argv.slice(2, 4);
if (dirs.length !== 2) {
    console.error('usage: node scripts/analyze-pressure-pair.mjs <session-a> <session-b>');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.pp-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
    "export { BinaryPatcher } from '@/lib/binary-engine/patcher';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.pp-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'error', alias: { '@': path.join(root, 'src') },
});
const M = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

const trimOf = (p) => {
    const b = [p.stft1, p.stft2].filter(v => v !== undefined);
    if (!b.length) return undefined;
    const s = b.reduce((a, c) => a + c, 0) / b.length;
    const l = [p.ltft1, p.ltft2].filter(v => v !== undefined);
    return s * (l.length ? l.reduce((a, c) => a + c, 0) / l.length : 1);
};

function loadSession(dir) {
    const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    const session = read('session.json');
    const bins = read('binaries.json');
    const base = Buffer.from(bins.base, 'base64');
    const ab = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
    const veMap = new M.BinaryPatcher(ab).getVETable();
    const processed = M.processLogData(read('log.json'), session.baseFileName,
        session.tuneSettings.filterConfig, session.tuneSettings.interpolationTable);
    const calc = new M.VECalculator();
    const ve = calc.annotateRfKorr(veMap, processed.data, M.readEgtTables(ab),
        { curves: M.readRfPtKorrCurves(ab) });
    return { label: session.label, veMap, ve };
}

const A = loadSession(dirs[0]);
const B = loadSession(dirs[1]);

const rpmAxis = A.veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
const loadAxis = A.veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;
const near = (axis, v) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < axis.length; i++) { const d = Math.abs(axis[i] - v); if (d < bd) { bd = d; bi = i; } }
    return bi;
};

/** Cells the flash between the two left byte-identical — the only ones comparable at all. */
const unchanged = new Set();
for (let r = 0; r < A.veMap.data.length; r++) {
    for (let c = 0; c < A.veMap.data[r].length; c++) {
        if (Math.abs(A.veMap.data[r][c] - B.veMap.data[r][c]) < 1e-9) unchanged.add(r + '|' + c);
    }
}

/** Per cell: the mean of ln(correction) and ln(P), after removing this session's own time trend. */
function cellMeans(S) {
    const cells = new Map();
    for (const p of S.ve) {
        const t = trimOf(p);
        const y = (t !== undefined && p.rfKorr !== undefined) ? t * p.rfKorr : undefined;
        if (!(y > 0) || !(p.ambientPressure > 0)) continue;
        const k = near(loadAxis, p.correctedLoad ?? p.rawLoad) + '|' + near(rpmAxis, p.rpm);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ t: p.time, x: Math.log(p.ambientPressure), y: Math.log(y) });
    }
    const out = new Map();
    for (const [k, arr] of cells) {
        if (arr.length < 20) continue;
        // Detrend ln(y) on time WITHIN this cell and session, then take the mean of the residual.
        const n = arr.length;
        const mt = arr.reduce((s, a) => s + a.t, 0) / n;
        const my = arr.reduce((s, a) => s + a.y, 0) / n;
        let stt = 0, sty = 0;
        for (const a of arr) { const dt = a.t - mt; stt += dt * dt; sty += dt * (a.y - my); }
        const slope = stt > 0 ? sty / stt : 0;
        const resid = arr.map(a => a.y - slope * (a.t - mt));
        out.set(k, {
            n,
            y: resid.reduce((s, v) => s + v, 0) / n,
            x: arr.reduce((s, a) => s + a.x, 0) / n,
        });
    }
    return out;
}

const ma = cellMeans(A), mb = cellMeans(B);
const pairs = [];
for (const [k, a] of ma) {
    const b = mb.get(k);
    if (!b || !unchanged.has(k)) continue;
    pairs.push({ k, dx: b.x - a.x, dy: b.y - a.y, n: Math.min(a.n, b.n) });
}

console.log(NL + '='.repeat(92));
console.log('PRESSURE, ACROSS TWO DRIVES THAT WENT OPPOSITE WAYS');
console.log('='.repeat(92));
console.log('  ' + A.label + '  and  ' + B.label);
console.log('  cells the flash left untouched: ' + unchanged.size + ' of '
    + (A.veMap.data.length * A.veMap.data[0].length));
console.log('  of those, measured in BOTH drives with n>=20: ' + pairs.length);

if (pairs.length < 8) {
    console.log(NL + '  Too few paired cells to regress. Nothing is concluded.');
    process.exit(0);
}

const dxs = pairs.map(p => p.dx);
const spread = Math.max(...dxs) - Math.min(...dxs);
console.log('  spread of d ln P across those cells: ' + spread.toFixed(4)
    + '  (' + (100 * (Math.exp(spread) - 1)).toFixed(1) + ' % of pressure)');

const n = pairs.length;
const mx = dxs.reduce((a, b) => a + b, 0) / n;
const my = pairs.reduce((s, p) => s + p.dy, 0) / n;
let sxx = 0, sxy = 0;
for (const p of pairs) { const dx = p.dx - mx; sxx += dx * dx; sxy += dx * (p.dy - my); }
const beta = sxy / sxx;
const alpha = my - beta * mx;
let sse = 0;
for (const p of pairs) { const e = p.dy - (alpha + beta * p.dx); sse += e * e; }
const se = Math.sqrt((sse / (n - 2)) / sxx);

console.log(NL + '  d ln(correction) / d ln(P)   ' + (beta >= 0 ? '+' : '') + beta.toFixed(3)
    + ' +/- ' + se.toFixed(3) + '   (' + n + ' paired cells)');
console.log('  intercept (everything that differed between the drives)  '
    + (alpha >= 0 ? '+' : '') + alpha.toFixed(4));

console.log(NL + '  WHAT IT WOULD MEAN. Before the RF_PT_KORR fix this measured +1.10: the map was');
console.log('  recording the weather. A coefficient consistent with ZERO means the DME own density');
console.log('  compensation is being divided out and a cell means the same thing in any weather.');
console.log('  At the 47 mbar these drives span, a coefficient of ' + beta.toFixed(2) + ' moves a cell by '
    + (100 * beta * 0.0485).toFixed(2) + ' %.');
/**
 * ROBUSTNESS, because 2.5 sigma on 35 points is exactly the size of result that evaporates.
 *
 * `d ln P` varies across cells because different cells were driven at different points of the two
 * routes — so a cell's leverage is partly a fact about WHERE it was driven, and anything else that
 * varies along a route rides with it. These cuts do not remove that; they only show whether the
 * slope rests on the whole set or on a handful of extreme points.
 */
const variants = [
    ['all paired cells', pairs],
    ['n >= 50 in both', pairs.filter(p => p.n >= 50)],
    ['n >= 100 in both', pairs.filter(p => p.n >= 100)],
];
{
    const sorted = [...pairs].sort((a, b) => a.dx - b.dx);
    const trim = Math.floor(sorted.length * 0.1);
    variants.push(['middle 80 % of d ln P', sorted.slice(trim, sorted.length - trim)]);
}
console.log(NL + '  robustness');
console.log('    subset                     cells      slope');
for (const [name, set] of variants) {
    if (set.length < 6) { console.log('    ' + name.padEnd(26) + String(set.length).padStart(5) + '      (too few)'); continue; }
    const k = set.length;
    const mX = set.reduce((s, p) => s + p.dx, 0) / k;
    const mY = set.reduce((s, p) => s + p.dy, 0) / k;
    let xx = 0, xy = 0;
    for (const p of set) { const d = p.dx - mX; xx += d * d; xy += d * (p.dy - mY); }
    const b2 = xy / xx;
    const a2 = mY - b2 * mX;
    let e2 = 0;
    for (const p of set) { const e = p.dy - (a2 + b2 * p.dx); e2 += e * e; }
    const s2 = Math.sqrt((e2 / (k - 2)) / xx);
    console.log('    ' + name.padEnd(26) + String(k).padStart(5) + '   '
        + (b2 >= 0 ? '+' : '') + b2.toFixed(3) + ' +/- ' + s2.toFixed(3));
}

if (spread < 0.004) {
    console.log(NL + '  BUT THE LEVERAGE IS THIN. `d ln P` barely varies from cell to cell, so the slope');
    console.log('  rests on very little and the standard error above understates how little. Treat');
    console.log('  this as a bound, not a measurement.');
}
