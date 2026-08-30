/**
 * Does the lambda trim cancel `rf_korr`? And what does multiplying it in do to the load signal?
 *
 * This is the surviving half of the adversarial review (objection D2). The shipped correction is
 *
 *     c = STFT x LTFT x rf_korr
 *
 * and the objection is that `rf_korr` is imported there from an argument about FUEL, while the
 * table it writes is the DME load signal — which the non-lambda consumers (ignition, the torque
 * model, the TABG model) read open-loop. If the multiply is wrong, fuel still comes right because
 * the loop closes on it, and RF is permanently off for everybody else.
 *
 * THE ALGEBRA, so the measurement has something to decide between.
 *
 *   The DME computes   RF = kf_rf_soll(N, aq) x RF_PT_KORR x rf_korr
 *   The trim says the air the engine really took, in RF units, was   RF x trim.
 *   Next drive the same cell produces   RF2 = kf_rf_soll_new x RF_PT_KORR x rf_korr2.
 *   Set RF2 equal to the measured truth and cancel RF_PT_KORR:
 *
 *       kf_rf_soll_new = kf_rf_soll_old x trim x (rf_korr / rf_korr2)
 *
 *   So the whole question is WHICH rf_korr2 the table is written for, and every shipped path is
 *   one choice of it:
 *
 *       rf_korr2 = rf_korr   ->  c = trim alone             (as-logged, applyRfKorr false)
 *       rf_korr2 = 1.000     ->  c = trim x rf_korr         (the DEFAULT, and what D2 attacks)
 *       rf_korr2 = k_new     ->  c = trim x rf_korr / k_new (the tuned path)
 *
 *   The default is therefore not a fuel claim at all — it is the statement "write the table for
 *   the state in which the EGT correction is inactive". That is a MODE, and the charge D2 lays is
 *   that it was never named. It is self-consistent; whether it is harmless is a measurement.
 *
 * THE OTHER HALF OF THE ALGEBRA, which decides what the measurement has to control for.
 *   `rfKorr` is not read from the car. It is `RF / (kf_rf_soll_interp x RF_PT_KORR)`, so
 *
 *       new = old x trim x rfKorr = trim x RF / RF_PT_KORR
 *
 *   and the table lookup CANCELS. The default therefore does not depend on reconstructing rf_soll
 *   correctly, and the as-logged mode does. That cuts the opposite way to D2 — but it also means
 *   the measured `rfKorr` carries every error in the reconstruction, including the RF channel 1 %
 *   quantisation, which at RF = 20 is 5 % on a single sample. Whether that survives averaging is
 *   the second thing measured here.
 *
 * TEST 1 — does the trim fight rf_korr?
 *   READING A (what the multiply assumes): rf_korr is a modifier the closed loop takes straight
 *     back out, so a perfect air model shows trim = 1/rf_korr, and `trim x rf_korr` = 1.000 means
 *     "change nothing". Predicts d ln(trim) / d ln(rf_korr) = -1.
 *   READING B: rf_korr is a genuine density correction that makes RF a BETTER estimate of the air,
 *     so a perfect air model shows trim = 1.000 whatever rf_korr is, and multiplying it in invents
 *     a correction. Predicts a slope of 0 — which is the exact shape of the TI_F_STAT error.
 *
 *   Split by the DME own gate, because that supplies a CONTROL GROUP. Below `kl_rf_korr_rf_min`
 *   the DME applies rf_korr = 1.000 by construction, so any slope measured there is entirely
 *   artefact — reconstruction error and within-cell load structure. The gate-open slope is
 *   artefact PLUS whatever is real. The difference is the identified effect, and neither number
 *   means anything on its own.
 *
 *   Regressed with a (session, VE cell) fixed effect, because rf_korr and VE error both vary with
 *   the operating point and a pooled slope would be reading that instead.
 *
 * TEST 2 — how big is the term in practice, and what does it cost?
 *   The same map derived twice, `applyRfKorr` true and false, so the cost of the multiply is
 *   counted in cells written and in the within-cell scatter those cells have to pass.
 *
 * Input is one or more of the three-blob session directories `verify-rf-korr.mjs` takes; see its
 * header for the wrangler query that produces one.
 *
 *     node scripts/analyze-rf-korr-mode.mjs <dir> [<dir> ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const NL = '\n';
const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dirs = process.argv.slice(2);
if (!dirs.length) {
    console.error('usage: node scripts/analyze-rf-korr-mode.mjs <dir> [<dir> ...]');
    process.exit(2);
}

const entry = path.join(root, 'scripts', '.rf-korr-mode-entry.ts');
fs.writeFileSync(entry, [
    "export { processLogData } from '@/lib/log-engine/filter';",
    "export { VECalculator } from '@/lib/ve-calculator/calculator';",
    "export { readEgtTables, gateOpen } from '@/lib/ve-calculator/egtTables';",
    "export { readRfPtKorrCurves, referenceOf } from '@/lib/ve-calculator/chargeTemp';",
    "export { BinaryParser } from '@/lib/binary-engine/parser';",
    "export { APP_CONFIG } from '@/config/constants';",
].join(NL));
const outfile = path.join(root, 'scripts', '.rf-korr-mode-bundle.mjs');
await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
});
const {
    processLogData, VECalculator, readEgtTables, gateOpen, readRfPtKorrCurves, referenceOf,
    APP_CONFIG, BinaryParser,
} = await import(pathToFileURL(outfile).href);
fs.rmSync(entry, { force: true });

const RULE = '='.repeat(94);
/** Linear interpolation on a rising axis, clamped at both ends — the DME own rule for a curve. */
function interpAt(x, v, at) {
    if (!(at > x[0])) return v[0];
    const last = x.length - 1;
    if (!(at < x[last])) return v[last];
    for (let i = 0; i < last; i++) {
        if (at >= x[i] && at <= x[i + 1]) {
            const span = x[i + 1] - x[i];
            return span === 0 ? v[i] : v[i] + ((at - x[i]) / span) * (v[i + 1] - v[i]);
        }
    }
    return v[last];
}
const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const fmtDist = (a) => a.length
    ? 'n=' + String(a.length).padStart(5) + '  p05 ' + q(a, 0.05).toFixed(4)
        + '  med ' + q(a, 0.5).toFixed(4) + '  p95 ' + q(a, 0.95).toFixed(4)
        + '  max ' + Math.max(...a).toFixed(4)
    : '(none)';
const nearest = (axis, v) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < axis.length; i++) {
        const d = Math.abs(axis[i] - v);
        if (d < bd) { bd = d; bi = i; }
    }
    return bi;
};
const trimOf = (p) => {
    const b = [p.stft1, p.stft2].filter(v => v !== undefined);
    if (!b.length) return undefined;
    const s = b.reduce((a, c) => a + c, 0) / b.length;
    const l = [p.ltft1, p.ltft2].filter(v => v !== undefined);
    const lm = l.length ? l.reduce((a, c) => a + c, 0) / l.length : 1;
    return s * lm;
};

/**
 * One pooled within-group slope of `y` on `x`, groups demeaned first.
 *
 * A group needs real spread in the regressor to say anything: one where every sample sits at the
 * same x contributes no information about the slope and unbounded leverage to rounding, so it is
 * dropped rather than weighted down.
 */
function fixedEffectSlope(groups, minN, minSpread) {
    let sxx = 0, sxy = 0, used = 0, groupsUsed = 0;
    const pts = [];
    for (const arr of groups.values()) {
        if (arr.length < minN) continue;
        const xs = arr.map(a => a.x);
        if (Math.max(...xs) - Math.min(...xs) < minSpread) continue;
        const mx = xs.reduce((a, b) => a + b, 0) / arr.length;
        const my = arr.reduce((a, b) => a + b.y, 0) / arr.length;
        for (const a of arr) {
            const dx = a.x - mx, dy = a.y - my;
            sxx += dx * dx; sxy += dx * dy; pts.push([dx, dy]);
        }
        used += arr.length; groupsUsed++;
    }
    if (!sxx) return { slope: null, se: null, used, groupsUsed };
    const slope = sxy / sxx;
    let sse = 0;
    for (const [dx, dy] of pts) { const r = dy - slope * dx; sse += r * r; }
    const dof = Math.max(1, used - groupsUsed - 1);
    return { slope, se: Math.sqrt((sse / dof) / sxx), used, groupsUsed };
}

/**
 * Within-group variance of `x`, over groups big enough to have one, plus the mean of a supplied
 * per-sample quantity over the same samples. One degree of freedom lost per group.
 */
function withinVar(rows, minN, pick) {
    const by = new Map();
    for (const r of rows) {
        if (!by.has(r.key)) by.set(r.key, []);
        by.get(r.key).push(r);
    }
    let sse = 0, n = 0, groups = 0, acc = 0;
    for (const arr of by.values()) {
        if (arr.length < minN) continue;
        const m = arr.reduce((a, b) => a + b.x, 0) / arr.length;
        for (const a of arr) { sse += (a.x - m) * (a.x - m); acc += pick(a); }
        n += arr.length; groups++;
    }
    return { v: n > groups ? sse / (n - groups) : null, n, groups, mean: n ? acc / n : null };
}

const shutGroups = new Map();
const openGroups = new Map();
/**
 * Every regression sample again, keeping the two things the attenuation correction needs: the
 * `rf_soll` it was taken at, so the noise can be estimated over a MATCHED filling band rather than
 * over the whole drive, and the RF reading, so the quantisation prediction can be checked.
 */
const raw = { shut: [], open: [] };
const modeTotals = { withKorr: 0, trimOnly: 0 };
/** Every per-cell gap between the two modes, pooled, so the summary can quote a real spread. */
const allGaps = [];
/**
 * Samples either side of the DME own gate, for the discontinuity test.
 *
 * `margin` is `rf_soll / kl_rf_korr_rf_min(rpm)`: below 1 the DME applies rf_korr = 1.000, above
 * it the table. The threshold is a filling NUMBER, not anything the engine knows about, so the
 * real VE error has to be continuous across it. Whichever expression is continuous there is the
 * one that means "the air model error"; the other one steps by the size of rf_korr.
 */
const seam = [];

for (const dir of dirs) {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const rawLog = read('log.json');
    const session = read('session.json');
    const binaries = read('binaries.json');
    const cfg = session.tuneSettings?.filterConfig;
    const table = session.tuneSettings?.interpolationTable;
    if (!cfg || !table || !veMap) {
        throw new Error(dir + ': session.json is missing tuneSettings / veMapSnapshot');
    }

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
    const veMap = new BinaryParser(ab).getVETable();
    const egt = readEgtTables(ab);
    const curves = readRfPtKorrCurves(ab);
    if (!egt) throw new Error(dir + ': readEgtTables refused the BASE binary');
    if (!curves) throw new Error(dir + ': readRfPtKorrCurves refused the BASE binary');

    // The one thing verify-rf-korr.mjs does not do, and the reason its rf_korr column is empty on
    // every session it has ever been pointed at: without the curves `rfPtKorrFor` returns
    // undefined and NO sample gets an rf_korr. The app passes them (useVeCalculation); that
    // script does not.
    const air = { curves, assumedPressureMbar: cfg.assumedAmbientPressure };
    const ref = referenceOf(curves);

    console.log(NL + RULE);
    console.log(session.label + '  (' + rawLog.length + ' points, base '
        + (session.baseSha256 ? session.baseSha256.slice(0, 16) : '?') + ')');
    console.log('RF_PT_KORR = 1.000 at '
        + (ref ? ref.intakeTempC + ' degC, ' + ref.pressureMbar + ' mbar' : '(no reference)'));
    console.log('gate       kl_rf_korr_rf_min  '
        + egt.rfKorrMin.rpm.map((r, i) => r + ':' + egt.rfKorrMin.values[i]).join('  '));

    const processed = processLogData(rawLog, session.baseFileName ?? 'replay.csv', cfg, table);
    const calc = new VECalculator();
    const ve = calc.annotateRfKorr(veMap, processed.data, egt, air);
    const tun = calc.annotateRfKorr(veMap, processed.rfKorrData ?? processed.data, egt, air);
    console.log('filter     ' + rawLog.length + ' raw -> ' + ve.length + ' for VE, '
        + tun.length + ' for rf_korr');

    console.log(NL + '  -- the measured ratio --');
    for (const [name, set] of [['VE sample set    ', ve], ['rf_korr sample set', tun]]) {
        const withK = set.filter(p => p.rfKorr !== undefined);
        const open = withK.filter(p => gateOpen(egt, p.rpm, p.rfSoll));
        console.log('  ' + name + '  ' + fmtDist(withK.map(p => p.rfKorr)));
        console.log('    gate OPEN           ' + open.length + ' of ' + withK.length
            + ' (' + (100 * open.length / Math.max(1, withK.length)).toFixed(2) + ' %)'
            + (open.length ? '   ' + fmtDist(open.map(p => p.rfKorr)) : ''));
    }

    // Collect the regression samples, tagged by the gate the DME itself applied.
    const rpmAxis = veMap.xAxis ?? APP_CONFIG.MSS54HP.AXIS_RPM;
    const loadAxis = veMap.yAxis ?? APP_CONFIG.MSS54HP.AXIS_LOAD;
    for (const p of ve) {
        if (p.rfKorr === undefined || !(p.rfKorr > 0)) continue;
        const t = trimOf(p);
        if (!(t > 0)) continue;
        const key = session.id + '|' + nearest(rpmAxis, p.rpm) + '|'
            + nearest(loadAxis, p.correctedLoad ?? p.rawLoad);
        const isOpen = gateOpen(egt, p.rpm, p.rfSoll);
        const into = isOpen ? openGroups : shutGroups;
        if (!into.has(key)) into.set(key, []);
        into.get(key).push({ x: Math.log(p.rfKorr), y: Math.log(t) });
        raw[isOpen ? 'open' : 'shut'].push({
            key, x: Math.log(p.rfKorr), rfSoll: p.rfSoll, rf: p.rf,
        });
        const floor = interpAt(egt.rfKorrMin.rpm, egt.rfKorrMin.values, p.rpm);
        if (floor > 0) {
            seam.push({ margin: p.rfSoll / floor, trim: t, k: p.rfKorr, rpm: p.rpm });
        }
    }

    // -- TEST 2: the same map, derived both ways ------------------------------------------------
    console.log(NL + '  -- the map, derived both ways --');
    const runs = [
        ['x rf_korr (default)', {
            egt, rfKorrSource: cfg.rfKorrSource ?? 'rf-ratio', applyRfKorr: true,
        }],
        ['trim alone         ', {
            egt, rfKorrSource: undefined, rfKorrMode: 'as-logged', applyRfKorr: false,
        }],
    ];
    const derived = {};
    for (const [name, o] of runs) {
        const res = calc.calculateNewVEMap(veMap, ve, o);
        derived[name.trim() === 'trim alone' ? 'trimOnly' : 'withKorr'] = res;
        const census = {};
        let written = 0;
        const ks = [];
        for (let i = 0; i < res.acceptedMap.length; i++) {
            for (let j = 0; j < res.acceptedMap[i].length; j++) {
                if (res.acceptedMap[i][j]) { written++; ks.push(res.rfKorrMap[i][j]); }
                const r = res.rejectMap[i][j];
                if (r) census[r] = (census[r] ?? 0) + 1;
            }
        }
        modeTotals[name.trim() === 'trim alone' ? 'trimOnly' : 'withKorr'] += written;
        // 'scatter' and 'imprecise' are the two gates the noise of the multiply has to survive.
        const noisy = (census.scatter ?? 0) + (census.imprecise ?? 0);
        console.log('  ' + name + '  cells written ' + String(written).padStart(3)
            + '   rejected for scatter/imprecision ' + String(noisy).padStart(3));
        console.log('      census  ' + JSON.stringify(census));
        if (ks.length) console.log('      rf_korr in written cells  ' + fmtDist(ks));
    }

    // The number the whole objection comes down to: on the cells BOTH modes agree to write, how
    // far apart are the two tables? Everything above is about which derivation is right; this is
    // how much it matters on this drive.
    const a = derived.withKorr, b = derived.trimOnly;
    if (a.newMap && b.newMap) {
        const gaps = [];
        for (let i = 0; i < a.acceptedMap.length; i++) {
            for (let j = 0; j < a.acceptedMap[i].length; j++) {
                if (!a.acceptedMap[i][j] || !b.acceptedMap[i][j]) continue;
                const va = a.newMap.data[i][j], vb = b.newMap.data[i][j];
                if (!(vb > 0)) continue;
                gaps.push({ i, j, pct: 100 * (va / vb - 1), open: a.rfKorrMap[i][j] });
            }
        }
        gaps.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
        console.log(NL + '  -- what the two modes disagree about, on cells both write --');
        console.log('  cells written by both  ' + gaps.length);
        for (const g of gaps.slice(0, 8)) {
            console.log('    aq_rel_rf ' + String(loadAxis[g.i]).padStart(6)
                + ' %   ' + String(rpmAxis[g.j]).padStart(5) + ' rpm'
                + '   default is ' + (g.pct >= 0 ? '+' : '') + g.pct.toFixed(2) + ' %'
                + '   (mean rf_korr ' + g.open.toFixed(4) + ')');
        }
        if (gaps.length) {
            const worst = Math.max(...gaps.map(g => Math.abs(g.pct)));
            allGaps.push(...gaps.map(g => g.pct));
            console.log('  worst disagreement     ' + worst.toFixed(2) + ' %');
        }
    }
}

console.log(NL + RULE);
console.log('TEST 1 — d ln(trim) / d ln(rf_korr), (session, VE cell) fixed effect' + NL);
const MIN_N = 20;
const MIN_SPREAD = 0.01; // 1 % in rf_korr, in log units
const shut = fixedEffectSlope(shutGroups, MIN_N, MIN_SPREAD);
const open = fixedEffectSlope(openGroups, MIN_N, MIN_SPREAD);
const line = (name, r) => {
    if (r.slope === null) {
        console.log('  ' + name + '  no group has both >=' + MIN_N
            + ' samples and spread in rf_korr  ('
            + r.used + ' samples in ' + r.groupsUsed + ' groups)');
        return;
    }
    console.log('  ' + name + '  ' + (r.slope >= 0 ? '+' : '') + r.slope.toFixed(3)
        + ' +/- ' + r.se.toFixed(3)
        + '   (' + r.used + ' samples, ' + r.groupsUsed + ' cells)');
};
line('gate SHUT — rf_korr is 1.000 by construction, so this is pure artefact ', shut);
line('gate OPEN — artefact plus whatever is real                            ', open);
if (shut.slope !== null && open.slope !== null) {
    const d = open.slope - shut.slope;
    const se = Math.sqrt(shut.se * shut.se + open.se * open.se);
    console.log(NL + '  identified effect (open - shut)   ' + (d >= 0 ? '+' : '') + d.toFixed(3)
        + ' +/- ' + se.toFixed(3));
    console.log('  reading A predicts                -1.000   (trim cancels rf_korr)');
    console.log('  reading B predicts                 0.000   (multiplying it in invents)');
}

console.log(NL + RULE);
console.log('THE SEAM — which expression is continuous across the DME own gate?' + NL);

/*
 * `kl_rf_korr_rf_min` is a filling threshold and nothing more. The engine does not change at it;
 * only what the DME does to its own load signal changes. So the real air-model error is the same
 * on both sides, and the expression that is CONTINUOUS across it is the one that measures that
 * error. The other one has to step, by exactly the size of the correction that switches on.
 *
 * This is the same shape as the TI_F_STAT breakpoint test, and it needs no regression: two
 * medians either side of a line.
 */
const med = (a) => (a.length ? q(a, 0.5) : null);
let alphaSeam = null;
/**
 * The two medians either side of one line, in both expressions.
 *
 * `centre` is where the line is put, in units of the gate margin. At 1.00 it IS the gate. Below
 * 1.00 it is a PLACEBO: the DME is applying 1.000 on both sides there, so a step in `trim` can
 * only be load dependence, and the placebo measures exactly the confound this test has to survive.
 */
function seamAt(label, centre) {
    const below = seam.filter(r => r.margin >= 0.80 * centre && r.margin < centre);
    const above = seam.filter(r => r.margin > centre && r.margin <= 1.25 * centre);
    if (below.length < 30 || above.length < 30) {
        console.log('  ' + label + '  too few samples: '
            + below.length + ' below, ' + above.length + ' above');
        return;
    }
    const step = (f) => 100 * (med(above.map(f)) / med(below.map(f)) - 1);
    const sTrim = step(r => r.trim);
    const sBoth = step(r => r.trim * r.k);
    if (centre === 1.00) {
        // The rf_korr step is measured, not assumed to be (k_above - 1): below the gate the
        // MEASURED ratio is not exactly 1.000 either, and using its median on both sides keeps
        // the same reconstruction error in numerator and denominator where it cancels.
        const sK = Math.log(med(above.map(r => r.k)) / med(below.map(r => r.k)));
        if (Math.abs(sK) > 1e-6) alphaSeam = Math.log(1 + sBoth / 100) / sK;
    }
    console.log('  ' + label
        + '  n ' + String(below.length).padStart(5) + ' / ' + String(above.length).padStart(4)
        + '   rf_korr above ' + med(above.map(r => r.k)).toFixed(4)
        + '   trim alone ' + (sTrim >= 0 ? '+' : '') + sTrim.toFixed(2) + ' %'
        + '   trim x rf_korr ' + (sBoth >= 0 ? '+' : '') + sBoth.toFixed(2) + ' %');
}
console.log('  band = [0.80c, c) against (c, 1.25c]' + NL);
seamAt('THE GATE   c=1.00 ', 1.00);
console.log('');
console.log('  placebos — the DME applies 1.000 on BOTH sides of these, so any step is load');
console.log('  dependence and nothing else:');
seamAt('placebo    c=0.80 ', 0.80);
seamAt('placebo    c=0.65 ', 0.65);
seamAt('placebo    c=0.50 ', 0.50);
console.log('');
console.log('  A real effect shows a step at c=1.00 in ONE expression and nothing at the');
console.log('  placebos. A load artefact steps everywhere.');

console.log(NL + RULE);
console.log('ATTENUATION — is the shortfall from -1.000 measurement error in the regressor?' + NL);

/*
 * Classical errors-in-variables. The measured regressor is `ln(rf_korr_true) + e`, so the slope is
 * pulled toward zero by  lambda = var(true) / (var(true) + var(e)),  and the true slope is
 * `observed / lambda`.
 *
 * `var(e)` is measurable rather than assumed, because the DME hands us a control group: below the
 * gate `rf_korr_true` is exactly 1.000, so ALL of the within-cell variance there is `e`. The only
 * care needed is to estimate it over a MATCHED filling band — the dominant term is the RF channel
 * 1 % quantisation, which is relatively larger the smaller RF is, so the whole-drive gate-shut
 * variance would overstate the noise at the high filling where the gate opens, and the correction
 * would then run the wrong way.
 */
const openBand = raw.open.length
    ? [Math.min(...raw.open.map(r => r.rfSoll)), Math.max(...raw.open.map(r => r.rfSoll))]
    : null;
if (!openBand) {
    console.log('  no gate-open samples — nothing to correct.');
} else {
    const lo = openBand[0] * 0.7;
    const matched = raw.shut.filter(r => r.rfSoll >= lo);
    const vAll = withinVar(raw.shut, MIN_N, r => r.rf);
    const vMat = withinVar(matched, 8, r => r.rf);
    const vOpen = withinVar(raw.open, 8, r => r.rf);
    console.log('  gate-open samples sat at rf_soll ' + openBand[0].toFixed(3)
        + ' to ' + openBand[1].toFixed(3));
    const show = (name, r) => console.log('  ' + name + '  '
        + (r.v === null ? 'n/a' : 'sd(ln x) ' + Math.sqrt(r.v).toFixed(4))
        + '   n=' + r.n + ' in ' + r.groups + ' cells'
        + (r.mean === null ? '' : ', mean RF ' + r.mean.toFixed(1)));
    show('gate SHUT, whole drive             ', vAll);
    show('gate SHUT, matched filling >=' + lo.toFixed(2) + '  ', vMat);
    show('gate OPEN                          ', vOpen);

    // Where that noise comes from: the RF channel is an integer percent, so a uniform +/-0.5
    // rounding on a reading of RF contributes sd = (1/sqrt(12))/RF in log units. If the measured
    // gate-shut scatter matches this, the noise is the resolution of the channel and nothing
    // more interesting.
    if (vMat.mean) {
        console.log('  RF quantisation alone predicts       sd(ln x) '
            + ((1 / Math.sqrt(12)) / vMat.mean).toFixed(4)
            + '   at mean RF ' + vMat.mean.toFixed(1) + ' %');
    }

    const vNoise = vMat.v ?? vAll.v;
    if (vNoise !== null && vOpen.v !== null && vOpen.v > vNoise && open.slope !== null) {
        const lambda = (vOpen.v - vNoise) / vOpen.v;
        const corrected = (open.slope - (shut.slope ?? 0)) / lambda;
        console.log(NL + '  attenuation factor lambda           ' + lambda.toFixed(3));
        console.log('  slope corrected for it              ' + (corrected >= 0 ? '+' : '')
            + corrected.toFixed(3) + '   (against -1.000 for reading A)');
    } else if (vOpen.v !== null && vNoise !== null) {
        console.log(NL + '  gate-open scatter (' + Math.sqrt(vOpen.v).toFixed(4)
            + ') is not above the matched noise floor ('
            + Math.sqrt(vNoise).toFixed(4) + '),');
        console.log('  so no attenuation correction can be justified from these samples.');
    }
}

console.log(NL + RULE);
console.log('ALPHA — how much of what KF_RF_KORR_DRREL adds is a REAL density effect?' + NL);

/*
 * 60-tuning-logic.md section 6.2 defines the one unknown the whole rf_korr question turns on:
 *
 *     d(delta) = 1 + alpha * (rf_korr(delta) - 1)
 *
 * where `d` is the density effect that is really there and `rf_korr` is what BMW claims. alpha = 1
 * means the factory table is accurate; alpha = 0 means the effect does not exist and rf_korr is a
 * deliberate modifier the closed loop takes straight back out. That document says alpha "cannot be
 * decided from one log and one delta", and section 6.3 names the way to decide it: look at the
 * trim against rf_korr inside one cell. Both measurements above do exactly that, so both estimate
 * alpha — and they should agree.
 *
 *   trim = d/k = (1 + alpha(k-1)) / k, so for small (k-1):
 *       d ln(trim)   / d ln(k) = alpha - 1     -> the fixed-effect regression
 *       d ln(trim*k) / d ln(k) = alpha         -> the step at the seam
 *
 * They are not independent, but they weight the data differently — the regression uses within-cell
 * variation over 9 cells, the seam uses medians over 1,443 samples — so agreement is worth having
 * and disagreement is worth reporting rather than averaging away.
 */
if (open.slope !== null && shut.slope !== null) {
    const aReg = 1 + (open.slope - shut.slope);
    console.log('  from the regression   alpha = 1 + (slope_open - slope_shut) = '
        + aReg.toFixed(3) + ' +/- ' + Math.sqrt(shut.se * shut.se + open.se * open.se).toFixed(3));
}
if (alphaSeam !== null) {
    console.log('  from the seam         alpha = ln(step in trim x rf_korr) / ln(step in rf_korr) = '
        + alphaSeam.toFixed(3));
}
console.log('');
console.log('  alpha = 1  the factory table is right; x rf_korr then overshoots RICH by k');
console.log('  alpha = 0  the effect is not there; x rf_korr is the only expression that does');
console.log('             not permanently lean the table by k');

console.log(NL + RULE);
console.log('WHAT THE MULTIPLY COSTS, summed over the sessions given' + NL);
console.log('  cells written, x rf_korr (default)  ' + modeTotals.withKorr);
console.log('  cells written, trim alone           ' + modeTotals.trimOnly);
if (allGaps.length) {
    const abs = allGaps.map(Math.abs);
    console.log('  cells written by both               ' + allGaps.length);
    console.log('  |default - trim alone|, per cell    med ' + q(abs, 0.5).toFixed(2)
        + ' %   p95 ' + q(abs, 0.95).toFixed(2) + ' %   max ' + Math.max(...abs).toFixed(2) + ' %');
}
