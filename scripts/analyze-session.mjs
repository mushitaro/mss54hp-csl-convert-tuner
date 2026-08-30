/**
 * What one recorded drive earned, and the three things this particular one can settle.
 *
 *   1. TRIM NEUTRALITY. The first log carrying `ltft` — so the first one where the claim the whole
 *      derivation rests on (the long-term store never moved, therefore STFT is the whole standing
 *      error) can be CHECKED rather than assumed.
 *   2. THE TI BRANCH. The first log carrying `LLS_ST`. Bit 7 decides which table `ti_load_factor`
 *      reads at idle; the disassembly says a healthy valve leaves it low, and four source files
 *      say the car has never confirmed it.
 *   3. PRESSURE. This drive spans 880.9 to 949.5 mbar — 69 mbar INSIDE ONE RUN. That is the exact
 *      confound `annotateRfKorrPoint`'s RF_PT_KORR fix was written for, and until now it could only
 *      be tested BETWEEN drives, where the map and the weather both changed. Within one drive the
 *      VE error is fixed, so a cell fixed effect isolates pressure alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = process.argv[2];

const entry = path.join(root, 'scripts', '.sess-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables, gateOpen } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves, referenceOf, rfPtKorr } from '@/lib/ve-calculator/chargeTemp';",
    "export { trimNeutrality, learnersFrozen } from '@/lib/log-engine/trimNeutrality';",
    "export { BinaryParser } from '@/lib/binary-engine/parser';",
    "export { readAlphaNTables, tiLoadFactorAt, tiBranchAmbiguous } from '@/lib/ve-calculator/alphaNTable';",
    "export { tuneLowLoad } from '@/lib/ve-calculator/lowLoadTuner';",
    "export { buildCoverage, coverageCensus } from '@/lib/ve-calculator/cellCoverage';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.sess-bundle.mjs');
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
const table = session.tuneSettings.interpolationTable;

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
const curves = M.readRfPtKorrCurves(ab);
const tables = M.readAlphaNTables(ab);
const air = { curves, assumedPressureMbar: cfg.assumedAmbientPressure };

const RULE = '='.repeat(92);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

console.log(NL + RULE);
console.log(session.label + '   ' + new Date(session.createdAt).toISOString().slice(0, 16).replace('T', ' '));
console.log(RULE);
console.log('  base    ' + session.baseFileName);
console.log('          sha256 ' + session.baseSha256.slice(0, 32));
console.log('  points  ' + rawLog.length + '   ' + (Math.max(...rawLog.map(p => p.time)) / 60).toFixed(1)
    + ' min   ' + session.averageHz.toFixed(2) + ' Hz');

// ---------------------------------------------------------------- 1. trim neutrality
console.log(NL + '1. TRIM NEUTRALITY — can a write be armed at all?' + NL);
const win = new M.BinaryParser(ab).readLtftLearnWindow();
console.log('   learn window   K_LAA_TMOT_MIN ' + (win ? win.tmotMin : '?')
    + ' degC   K_LAA_TMOT_MAX ' + (win ? win.tmotMax : '?') + ' degC'
    + (win ? '   ' + (M.learnersFrozen(win) ? 'EMPTY — neither learner can run' : 'OPEN — learners can run') : ''));
const neu = M.trimNeutrality(rawLog, win);
console.log('   verdict        ' + neu.verdict.toUpperCase());
console.log('   samples        ' + neu.samples + ' carry ltft, of which ' + neu.atInit
    + ' are bit-exact 1.000 (' + (100 * neu.atInit / Math.max(1, neu.samples)).toFixed(2) + ' %)');
console.log('   worst laa_f    ' + neu.worst);

// ---------------------------------------------------------------- 2. the ti branch
console.log(NL + '2. THE ti_load_factor BRANCH — what the car says' + NL);
const lls = rawLog.map(p => p.llsSt).filter(v => v !== undefined && v !== null);
const bit7 = lls.filter(v => (v & 0x80) !== 0).length;
const counts = {};
for (const v of lls) counts['0x' + v.toString(16).padStart(2, '0')] = (counts['0x' + v.toString(16).padStart(2, '0')] ?? 0) + 1;
console.log('   LLS_ST samples ' + lls.length + '   distinct values ' + JSON.stringify(counts));
console.log('   bit 7 SET on   ' + bit7 + ' samples');
const idleRows = rawLog.filter(p => p.rpm < 1000 && (p.wdk1 ?? 99) <= 1.0);
const idleBit7 = idleRows.filter(p => ((p.llsSt ?? 0) & 0x80) !== 0).length;
console.log('   at idle        ' + idleRows.length + ' samples (rpm<1000, wdk1<=1.0), bit 7 set on ' + idleBit7);
console.log('   => branch      ' + (bit7 === 0
    ? 'KF_TI_N_RF throughout. The 0.859 KL_TI_N_ZWD_LL curve never ran.'
    : 'MIXED — bit 7 was set somewhere, so the idle branch DID run.'));
if (tables) {
    const amb = rawLog.filter(p => p.rf !== undefined
        && M.tiBranchAmbiguous(tables, p.rpm, p.rf / 100)).length;
    console.log('   tiBranchAmbiguous would have flagged ' + amb + ' of ' + rawLog.length + ' samples');
}

// ---------------------------------------------------------------- 3. pressure
console.log(NL + '3. PRESSURE — 69 mbar inside one drive, with the VE error held fixed' + NL);
const processed = M.processLogData(rawLog, session.baseFileName, cfg, table);
const calc = new M.VECalculator();
const ve = calc.annotateRfKorr(veMap, processed.data, egt, air);

const rpmAxis = veMap.xAxis ?? M.APP_CONFIG.MSS54HP.AXIS_RPM;
const loadAxis = veMap.yAxis ?? M.APP_CONFIG.MSS54HP.AXIS_LOAD;
const nearest = (axis, v) => { let bi = 0, bd = Infinity; for (let i = 0; i < axis.length; i++) { const d = Math.abs(axis[i] - v); if (d < bd) { bd = d; bi = i; } } return bi; };
const trimOf = (p) => {
    const b = [p.stft1, p.stft2].filter(v => v !== undefined);
    if (!b.length) return undefined;
    const s = b.reduce((a, c) => a + c, 0) / b.length;
    const l = [p.ltft1, p.ltft2].filter(v => v !== undefined);
    return s * (l.length ? l.reduce((a, c) => a + c, 0) / l.length : 1);
};

/** Pooled within-cell slope of ln(y) on ln(P). */
function pressureSlope(pick) {
    const cells = new Map();
    for (const p of ve) {
        const y = pick(p);
        if (!(y > 0) || !(p.ambientPressure > 0)) continue;
        const k = nearest(rpmAxis, p.rpm) + '|' + nearest(loadAxis, p.correctedLoad ?? p.rawLoad);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ x: Math.log(p.ambientPressure), y: Math.log(y) });
    }
    let sxx = 0, sxy = 0, n = 0, g = 0;
    const pts = [];
    for (const arr of cells.values()) {
        if (arr.length < 20) continue;
        const xs = arr.map(a => a.x);
        if (Math.max(...xs) - Math.min(...xs) < 0.005) continue; // needs ~5 mbar of span
        const mx = xs.reduce((a, b) => a + b, 0) / arr.length;
        const my = arr.reduce((a, b) => a + b.y, 0) / arr.length;
        for (const a of arr) { const dx = a.x - mx, dy = a.y - my; sxx += dx * dx; sxy += dx * dy; pts.push([dx, dy]); }
        n += arr.length; g++;
    }
    if (!sxx) return null;
    const slope = sxy / sxx;
    let sse = 0;
    for (const [dx, dy] of pts) { const r = dy - slope * dx; sse += r * r; }
    return { slope, se: Math.sqrt((sse / Math.max(1, n - g - 1)) / sxx), n, g };
}

/**
 * IS PRESSURE EVEN SEPARABLE FROM TIME IN THIS DRIVE?
 *
 * Barometric pressure inside one run moves because the car climbed or descended, and a car does
 * that monotonically: on most drives ln(P) and the clock are very nearly the same regressor. When
 * they are, the slope above is not "the effect of pressure" — it is the effect of everything that
 * drifted during the run, wearing pressure's name. Session #925 is the case in point: the pooled
 * slope reads +0.100 +/- 0.017, six sigma from zero, and putting time in the model moves it to
 * -0.219. Nothing about the air model changed; the drive simply went downhill.
 *
 * This has caught a false positive twice now, both times after the number had already been written
 * down as a finding. So the confound is measured and printed WITH the coefficient rather than left
 * for whoever reads it to think of.
 */
function pressureTimeConfound() {
    const xs = [], ts = [];
    for (const p of ve) {
        if (!(p.ambientPressure > 0)) continue;
        xs.push(Math.log(p.ambientPressure));
        ts.push(p.time);
    }
    if (xs.length < 30) return null;
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const mt = ts.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, stt = 0, sxt = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dt = ts[i] - mt;
        sxx += dx * dx; stt += dt * dt; sxt += dx * dt;
    }
    return (sxx > 0 && stt > 0) ? sxt / Math.sqrt(sxx * stt) : null;
}

/** The same pooled within-cell slope, with TIME as a second regressor. */
function pressureSlopeControlled(pick) {
    const cells = new Map();
    for (const p of ve) {
        const y = pick(p);
        if (!(y > 0) || !(p.ambientPressure > 0)) continue;
        const k = nearest(rpmAxis, p.rpm) + '|' + nearest(loadAxis, p.correctedLoad ?? p.rawLoad);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ x: Math.log(p.ambientPressure), t: p.time, y: Math.log(y) });
    }
    // Demeaned within cell, then one two-variable normal equation over the pooled deviations.
    let sxx = 0, stt = 0, sxt = 0, sxy = 0, sty = 0, n = 0;
    for (const arr of cells.values()) {
        if (arr.length < 20) continue;
        const xs = arr.map(a => a.x);
        if (Math.max(...xs) - Math.min(...xs) < 0.005) continue;
        const mx = xs.reduce((a, b) => a + b, 0) / arr.length;
        const mt = arr.reduce((a, b) => a + b.t, 0) / arr.length;
        const my = arr.reduce((a, b) => a + b.y, 0) / arr.length;
        for (const a of arr) {
            const dx = a.x - mx, dt = a.t - mt, dy = a.y - my;
            sxx += dx * dx; stt += dt * dt; sxt += dx * dt; sxy += dx * dy; sty += dt * dy; n++;
        }
    }
    const det = sxx * stt - sxt * sxt;
    if (!det || !n) return null;
    return { slope: (sxy * stt - sty * sxt) / det, n };
}

const ps = [
    ['trim alone                    ', pressureSlope(p => trimOf(p))],
    ['correction (trim x rf_korr)   ', pressureSlope(p => (p.rfKorr !== undefined ? trimOf(p) * p.rfKorr : 0))],
    ['measured rf_korr alone        ', pressureSlope(p => p.rfKorr)],
];
const pr = rawLog.map(p => p.ambientPressure).filter(v => v > 0);
console.log('   pressure span  ' + Math.min(...pr).toFixed(1) + ' to ' + Math.max(...pr).toFixed(1)
    + ' mbar   (' + (Math.max(...pr) - Math.min(...pr)).toFixed(1) + ' mbar, about '
    + Math.round((Math.max(...pr) - Math.min(...pr)) * 8.5) + ' m of altitude)');
for (const [name, r] of ps) {
    console.log('   d ln / d ln(P)  ' + name + (r
        ? (r.slope >= 0 ? '+' : '') + r.slope.toFixed(3) + ' +/- ' + r.se.toFixed(3)
            + '   (' + r.n + ' samples, ' + r.g + ' cells)'
        : '(no cell spans enough pressure)'));
}
const rho = pressureTimeConfound();
const ctrl = pressureSlopeControlled(p => (p.rfKorr !== undefined ? trimOf(p) * p.rfKorr : 0));
console.log('');
console.log('   corr(ln P, time)  ' + (rho === null ? '(not computable)'
    : (rho >= 0 ? '+' : '') + rho.toFixed(3)
        + (Math.abs(rho) > 0.8 ? '   <- PRESSURE AND TIME ARE THE SAME REGRESSOR HERE'
            : Math.abs(rho) > 0.5 ? '   <- partly confounded' : '   <- separable')));
if (ctrl) {
    const raw = ps[1][1];
    console.log('   correction slope with TIME in the model   '
        + (ctrl.slope >= 0 ? '+' : '') + ctrl.slope.toFixed(3)
        + (raw ? '   (was ' + (raw.slope >= 0 ? '+' : '') + raw.slope.toFixed(3) + ' without it)' : ''));
    if (raw && Math.abs(rho ?? 0) > 0.8) {
        console.log('');
        console.log('   READ THE CONTROLLED NUMBER, OR NEITHER. A drive that climbs or descends once');
        console.log('   moves pressure and the clock together, so the uncontrolled slope carries every');
        console.log('   drift in the run under pressure\'s name. When the two disagree in SIGN, as here,');
        console.log('   nothing about pressure has been measured and the honest report is "not');
        console.log('   identified" — not the larger of the two numbers.');
    }
}
console.log('');
console.log('   Before the RF_PT_KORR fix the correction measured +1.10 +/- 0.16 against pressure,');
console.log('   and the trim alone +0.07 +/- 0.06. A correction near ZERO here means the DME own');
console.log('   density compensation is being divided out properly and the map is not recording');
console.log('   the weather of the day it was driven.');

// ---------------------------------------------------------------- 4. what it earned
console.log(NL + '4. WHAT THE DRIVE EARNED' + NL);
console.log('   filter   ' + rawLog.length + ' raw -> ' + processed.data.length + ' for VE, '
    + (processed.rfKorrData ? processed.rfKorrData.length : 0) + ' for rf_korr');
const res = calc.calculateNewVEMap(veMap, ve, { egt });
const census = {};
let written = 0;
const moves = [];
for (let i = 0; i < res.acceptedMap.length; i++) {
    for (let j = 0; j < res.acceptedMap[i].length; j++) {
        const r = res.rejectMap[i][j];
        if (r) census[r] = (census[r] ?? 0) + 1;
        if (!res.acceptedMap[i][j]) continue;
        written++;
        const old = veMap.data[i][j], nw = res.newMap.data[i][j];
        moves.push({ i, j, pct: 100 * (nw / old - 1), n: res.hitMap[i][j], old, nw });
    }
}
console.log('   VE cells written  ' + written + ' of 480');
console.log('   reject census     ' + JSON.stringify(census));
if (moves.length) {
    moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const pcts = moves.map(m => m.pct);
    console.log('   change            med ' + q(pcts.map(Math.abs), 0.5).toFixed(2) + ' %   worst '
        + Math.max(...pcts.map(Math.abs)).toFixed(2) + ' %   '
        + pcts.filter(v => v < 0).length + ' down / ' + pcts.filter(v => v > 0).length + ' up');
    console.log('');
    console.log('   aq_rel_rf    rpm      base ->  tuned      change    samples');
    for (const m of moves) {
        console.log('   ' + String(loadAxis[m.i]).padStart(8) + ' %'
            + String(rpmAxis[m.j]).padStart(7)
            + '   ' + m.old.toFixed(3) + ' -> ' + m.nw.toFixed(3)
            + '   ' + (m.pct >= 0 ? '+' : '') + m.pct.toFixed(2) + ' %'
            + String(m.n).padStart(9));
    }
}

// ---------------------------------------------------------------- 5. low load
console.log(NL + '5. LOW LOAD' + NL);
if (!tables) {
    console.log('   readAlphaNTables refused the binary.');
} else {
    const ll = M.tuneLowLoad(processed.data, tables, veMap);
    if (!ll) {
        console.log('   returned null.');
    } else {
        console.log('   acceptable        ' + ll.acceptable);
        console.log('   cells measured    ' + ll.report.cellsMeasured);
        console.log('   samples used      ' + ll.report.samplesUsed);
        console.log('   rejects           ' + JSON.stringify(ll.report.rejects));
    }
}
