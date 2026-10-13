/**
 * The RF KORR tuner, re-anchored on the converged VE, and the high-Δ guard that licenses its 300/400
 * fill.
 *
 *     trim  = mean(STFT1, STFT2) x mean(LTFT1, LTFT2)        the VE write's own trim
 *     D_i   = rfKorr_i x trim_i                              gate open AND kRamp === false
 *     DRREL(N, Δ) <- Σ w·D_i / Σ w                           -0.05 / +0.10 per log, [1.000, 1.40],
 *                                                            never the Δ 30 row or 1100/5100 rpm
 *     refused 'kHeld'          the floor is K HOLD (2.000 x 6), so the gate never opened
 *     refused 'veNotAnchored'  median trim of the gate-shut post-ramp samples outside 1 ± 0.02
 *     above the highest written row of a column, with a K HOLD drive's guard ok:
 *         s = (k_new_top - 1) / (k_stock_top - 1),   k = 1 + s (k_stock - 1)   (same step, range)
 *         k_stock BMW's table (CSL_STOCK_RF_KORR_DRREL), the step from the loaded one
 *     the guard, over a K HOLD drive:
 *         K* = DRREL(N, model(N, rf_soll · K*) - TABG),  Δ* = model(N, rf_soll · K*) - TABG
 *         samples    = Δ* >= 300, stock gate entered, loop running
 *         leanLocked = any bank on its +clamp, or risen P+ + 0.02 without a rich switch
 *         ok         = samples >= 10 && leanLocked === 0
 *
 * All synthetic, plus the one binary the repo ships (public/mock) for BMW's stock tables. Nothing
 * here reads archive/.
 *
 *     node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/verify-rf-korr-tuner.mjs
 */
import fs from 'node:fs';
import { tuneRfKorrTable, rfKorrCensus, RF_KORR_TUNE_DEFAULTS } from '../src/lib/ve-calculator/rfKorrTuner.ts';
import {
    computeHighDeltaGuard, counterfactualRfKorr,
    HIGH_DELTA_GUARD_DELTA_MIN, HIGH_DELTA_GUARD_MIN_SAMPLES, LEAN_LOCK_MARGIN,
} from '../src/lib/ve-calculator/highDeltaGuard.ts';
import { readEgtTables, tabgModelAt, withStockRfKorrFloor } from '../src/lib/ve-calculator/egtTables.ts';
import { VECalculator, RF_TRUNCATION_MEAN_PERCENT } from '../src/lib/ve-calculator/calculator.ts';
import { LAMBDA_P_JUMP_FALLBACK } from '../src/lib/ve-calculator/rampState.ts';
import { APP_CONFIG, RF_KORR_GATE_FLOOR, CSL_STOCK_RF_KORR_DRREL } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const VE_AXES = { rpm: RPM, load: LOAD };
const MAP = { xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => 0.9)) };

// BMW's stock tables, out of the shipped partial: the real axes (12 rpm x 6 Δ), the real DRREL,
// kf_rf_tabg_modell, and the 700/550/650/650/650/800 floor.
const bin = fs.readFileSync(new URL('../public/mock/csl-0401-community-patch-v1.partial.bin', import.meta.url));
const EGT = readEgtTables(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
if (!EGT) { console.log('readEgtTables refused public/mock'); process.exit(1); }
const HELD = { ...EGT, rfKorrMin: { rpm: [...EGT.rfKorrMin.rpm], values: EGT.rfKorrMin.values.map(() => RF_KORR_GATE_FLOOR.HELD_RAW / 1000) } };

const R = (rpm) => EGT.rfKorr.rpm.indexOf(rpm);
const D = (delta) => EGT.rfKorr.delta.indexOf(delta);
const stockAt = (rpm, delta) => EGT.rfKorr.values[D(delta)][R(rpm)];
/** A density truth that is a fraction of what BMW's table claims: A = 1 + s (k_stock - 1). */
const truth = (rpm, delta, s) => 1 + s * (stockAt(rpm, delta) - 1);

// --- annotated samples, as annotateRfKorr hands them to the tuner ---------------------------------
//
// The tuner's contract is the annotated fields — rfKorr (K the DME applied), rfSoll, rfKorrGateOpen,
// kRamp, tabgDelta, the trims — so these are built directly. One end-to-end pass through the real
// annotation is at the bottom.

let clock = 0;
const LTFT = 0.98;   // off 1.000 on purpose: a tuner that dropped the long-term store reads 2 % high

/**
 * `n` samples at one operating point, 0.2 s apart. The first 3 s after a change of RF or TABG are
 * the tuner's own settle window and are not used; the remaining samples carry D = `d` exactly, the
 * trim split ±0.002 across the banks and the long-term store at LTFT.
 */
function block({ rpm, delta, load = 20, d, k = 1, n = 40, gate = true, kRamp = false, rfSoll = 0.9, v = 80 }) {
    const trim = d / k;
    const stft = trim / LTFT;
    const rf = 100 * rfSoll * k;
    const model = tabgModelAt(EGT, rpm, rf / 100);
    return Array.from({ length: n }, () => ({
        time: (clock = +(clock + 0.2).toFixed(6)), rpm, rawLoad: load, correctedLoad: load,
        stft1: stft + 0.002, stft2: stft - 0.002, ltft1: LTFT, ltft2: LTFT,
        rf, rfSoll, rfKorr: gate ? k : 1, rfKorrGateOpen: gate, kRamp,
        vehicleSpeed: v, exhaustTemp: model - delta, tabgDelta: delta,
    }));
}
/** The gate-shut, post-ramp stretch the anchor check reads: K = 1, the trim the VE's own error. */
const cruise = (centre, n = 40) => Array.from({ length: n }, (_, i) => block({
    rpm: 2200, delta: 30, load: 7.5, rfSoll: 0.4, gate: false, d: centre + (i % 2 ? 0.01 : -0.01), n: 1,
})[0]);
/** One measured cell, from two VE cells (loads 20 and 30), K the stock table, D = `d`. */
const cell = (rpm, delta, d, extra = {}) => [
    ...block({ rpm, delta, d, k: stockAt(rpm, delta), load: 20, ...extra }),
    ...block({ rpm, delta, d, k: stockAt(rpm, delta), load: 30, ...extra }),
];
const tune = (log, opts = {}, egt = EGT) => tuneRfKorrTable(MAP, log, egt, VE_AXES, opts);

console.log('\n[D = K x trim returns A(Δ) under a converged VE]');
{
    // The DME applies its loaded table, K = DRREL(N, Δ); the car's air is 90 % of that excess; the
    // loop settles on trim = A / K. The VE is converged — gate-shut trims centre on 1.000.
    const cells = [];
    for (const rpm of [2200, 3000, 3200, 4000]) for (const delta of [40, 100, 200]) cells.push([rpm, delta]);
    const log = [...cruise(1.0), ...cells.flatMap(([rpm, delta]) => cell(rpm, delta, truth(rpm, delta, 0.9)))];
    // Mid-ramp samples in one of those cells with trim x K = K: the clock, not the error. Must not move it.
    const ramp = block({ rpm: 2200, delta: 100, d: stockAt(2200, 100), k: stockAt(2200, 100), kRamp: true, n: 30 });
    const res = tune([...log, ...ramp]);
    check('a table, not refused', res && res.report.refused === null, JSON.stringify(res?.report.refused));
    let worst = 0;
    for (const [rpm, delta] of cells) {
        const r = D(delta), c = R(rpm);
        worst = Math.max(worst, Math.abs(res.tuned[r][c] - truth(rpm, delta, 0.9)));
        if (!res.updated[r][c] || res.extrapolated[r][c]) worst = Infinity;
    }
    check('every measured cell is written to A(Δ) exactly (LTFT included, mid-ramp ignored)', worst < 1e-9, String(worst));
    check('the mid-ramp samples are counted as k ramp, not used', res.report.samplesKRamp === 30, String(res.report.samplesKRamp));
    check('the 300/400 rows are not measured and, with no guard, stay stock',
        [300, 400].every(delta => [2200, 3000, 3200, 4000].every(rpm =>
            res.tuned[D(delta)][R(rpm)] === stockAt(rpm, delta) && res.rejected[D(delta)][R(rpm)] === 'no-evidence')));
    check('acceptable', res.acceptable === true);
    check('the live census reports the same samples-used', rfKorrCensus(log, EGT, VE_AXES).report.samplesUsed === res.report.samplesUsed);
    check('anchor check passed on the gate-shut trims (median 1.000)',
        res.report.anchorTrimSamples === 40 && near(res.report.anchorTrimMedian, 1.0, 1e-9),
        `${res.report.anchorTrimSamples} ${res.report.anchorTrimMedian}`);
}

console.log('\n[veNotAnchored: the gate-shut trim is off 1.000]');
{
    const cells = cell(2200, 100, truth(2200, 100, 0.9));
    const rich = tune([...cruise(1.04), ...cells]);
    check('median 1.04: refused veNotAnchored', rich?.report.refused === 'veNotAnchored', JSON.stringify(rich?.report.refused));
    check('...a table of nothing: stock, no cell updated, not acceptable',
        rich.acceptable === false && rich.updated.flat().every(u => !u)
        && rich.tuned.every((row, r) => row.every((v, c) => v === rich.stock[r][c])));
    check('...and nothing shown as measured', rich.countMap.flat().every(n => n === 0));
    const lean = tune([...cruise(0.975), ...cells]);
    check('median 0.975: refused', lean?.report.refused === 'veNotAnchored');
    const within = tune([...cruise(1.015), ...cells]);
    check('median 1.015 (inside ±0.02): not refused', within?.report.refused === null, JSON.stringify(within?.report.refused));
    const few = tune([...cruise(1.0, RF_KORR_TUNE_DEFAULTS.anchorCheckMinSamples - 1), ...cells]);
    check(`fewer than ${RF_KORR_TUNE_DEFAULTS.anchorCheckMinSamples} gate-shut samples: cannot pass, refused`,
        few?.report.refused === 'veNotAnchored');
    // An exit ramp after the gate shuts is still the loop taking K back, not the VE's error.
    const exitRamp = cruise(1.06, 30).map(p => ({ ...p, kRamp: true }));
    const ramped = tune([...cruise(1.0), ...exitRamp, ...cells]);
    check('gate-shut samples still in a ramp are not read by the check', ramped?.report.refused === null
        && ramped.report.anchorTrimSamples === 40, `${ramped?.report.refused} ${ramped?.report.anchorTrimSamples}`);
    check('the live census says the same', rfKorrCensus([...cruise(1.04), ...cells], EGT, VE_AXES).report.refused === 'veNotAnchored');
}

console.log('\n[kHeld: K HOLD drive]');
{
    // Under the hold every sample is gate-shut and K = 1; the VE is converged.
    const log = [...cruise(1.0), ...block({ rpm: 2200, delta: 100, d: 1.0, gate: false, n: 60 })];
    const res = tune(log, {}, HELD);
    check('refused kHeld', res?.report.refused === 'kHeld', JSON.stringify(res?.report.refused));
    check('...stock, nothing updated, not acceptable',
        res.acceptable === false && res.updated.flat().every(u => !u)
        && res.tuned.every((row, r) => row.every((v, c) => v === res.stock[r][c])));
    check('kHeld outranks veNotAnchored', tune([...cruise(1.05), ...log.slice(40)], {}, HELD)?.report.refused === 'kHeld');
    check('the live census says kHeld too', rfKorrCensus(log, HELD, VE_AXES).report.refused === 'kHeld');
    // A hold that did not take reaches the tuner with the stock floor back (resolveKHold) and is tuned.
    const back = tune([...cruise(1.0), ...cell(2200, 100, truth(2200, 100, 0.9))], {}, withStockRfKorrFloor(HELD));
    check('the same tables with the stock floor back: tuned, not refused', back?.report.refused === null && back.updated[D(100)][R(2200)]);
}

console.log('\n[step limits -0.05 / +0.10 per log and the range [1.000, 1.40]]');
{
    const log = [
        ...cruise(1.0),
        ...cell(2200, 100, 0.90),          // stock 1.045: down 0.05 would be 0.995, the floor holds 1.000
        ...cell(3000, 200, 1.0),           // stock 1.100: down by 0.05 exactly
        ...cell(3200, 100, 1.30),          // stock 1.045: up by 0.10 exactly
        ...cell(2350, 400, 1.60),          // stock 1.371: +0.10 is 1.471, the ceiling holds 1.40
        ...cell(2200, 30, 1.05),           // the Δ 30 row: never written
        ...cell(5100, 200, 1.05),          // an identity column: never written
        ...cell(1100, 200, 1.05),
    ];
    const res = tune(log);
    const at = (rpm, delta) => res.tuned[D(delta)][R(rpm)];
    check('D 0.90 against 1.045: clamped at the 1.000 floor', near(at(2200, 100), 1.0), String(at(2200, 100)));
    check('D 1.0 against 1.100: stock - 0.05', near(at(3000, 200), stockAt(3000, 200) - 0.05), String(at(3000, 200)));
    check('D 1.30 against 1.045: stock + 0.10', near(at(3200, 100), stockAt(3200, 100) + 0.10), String(at(3200, 100)));
    check('D 1.60 against 1.371: the 1.40 ceiling', near(at(2350, 400), 1.40), String(at(2350, 400)));
    check('the Δ 30 row is not written', at(2200, 30) === 1 && res.rejected[D(30)][R(2200)] === 'identity-row');
    check('5100 / 1100 rpm are not written', at(5100, 200) === 1 && at(1100, 200) === 1
        && res.rejected[D(200)][R(5100)] === 'identity-column' && res.rejected[D(200)][R(1100)] === 'identity-column');
    check('largestChange is the 0.10 step', near(res.report.largestChange, 0.10), String(res.report.largestChange));
}

console.log('\n[300/400: the shrink ratio of the highest measured row, only with the guard ok]');
{
    // 2200 rpm at s = 0.9: every target inside one step. 3000 rpm at s = 0.7: 300 and 400 want more
    // than 0.05 and are step-limited. 4000 rpm measured to 100 only: 200..400 follow row 100. 3200 rpm
    // went UP at its top row: s caps at 1, nothing above it moves.
    const log = [
        ...cruise(1.0),
        ...[40, 100, 200].flatMap(d => cell(2200, d, truth(2200, d, 0.9))),
        ...[40, 100, 200].flatMap(d => cell(3000, d, truth(3000, d, 0.7))),
        ...[40, 100].flatMap(d => cell(4000, d, truth(4000, d, 0.6))),
        ...[100, 200].flatMap(d => cell(3200, d, stockAt(3200, d) + 0.03)),
    ];
    const OK = { samples: 30, leanLocked: 0, ok: true };
    const res = tune(log, { highDeltaGuard: OK });
    const at = (rpm, delta) => res.tuned[D(delta)][R(rpm)];
    const ex = (rpm, delta) => res.extrapolated[D(delta)][R(rpm)] && res.updated[D(delta)][R(rpm)]
        && res.rejected[D(delta)][R(rpm)] === null;
    check('2200: s = 0.9 from row 200, 300 and 400 at 1 + 0.9 (k_stock - 1)',
        near(at(2200, 300), truth(2200, 300, 0.9)) && near(at(2200, 400), truth(2200, 400, 0.9)),
        `${at(2200, 300)} ${at(2200, 400)}`);
    check('...flagged extrapolated, written, not rejected', ex(2200, 300) && ex(2200, 400));
    check('3000: s = 0.7, both rows limited to stock - 0.05',
        near(at(3000, 300), stockAt(3000, 300) - 0.05) && near(at(3000, 400), stockAt(3000, 400) - 0.05),
        `${at(3000, 300)} ${at(3000, 400)}`);
    check('4000: measured to 100, so 200/300/400 follow row 100\'s s = 0.6',
        [200, 300, 400].every(d => ex(4000, d)
            && near(at(4000, d), Math.max(stockAt(4000, d) - 0.05, truth(4000, d, 0.6)))),
        [200, 300, 400].map(d => at(4000, d)).join(' '));
    check('3200: the top row went up, s caps at 1, rows above stay stock and are not flagged',
        [300, 400].every(d => at(3200, d) === stockAt(3200, d) && !res.extrapolated[D(d)][R(3200)]));
    check('the measured rows themselves are not flagged', !res.extrapolated[D(200)][R(2200)] && res.updated[D(200)][R(2200)]);
    check('extrapolatedCells counts them: 2 + 2 + 3', res.report.extrapolatedCells === 7, String(res.report.extrapolatedCells));
    check('a column with nothing measured gets nothing', [200, 300, 400].every(d => !res.updated[D(d)][R(1600)]));

    const locked = tune(log, { highDeltaGuard: { samples: 30, leanLocked: 4, ok: false } });
    check('guard lean-locked: 300/400 stay stock, unflagged, rejected as unmeasured',
        [2200, 3000].every(rpm => [300, 400].every(d => locked.tuned[D(d)][R(rpm)] === stockAt(rpm, d)
            && !locked.extrapolated[D(d)][R(rpm)] && locked.rejected[D(d)][R(rpm)] === 'no-evidence')));
    check('...and the measured rows are written all the same', near(locked.tuned[D(200)][R(2200)], truth(2200, 200, 0.9)));
    const none = tune(log, { highDeltaGuard: null });
    const absent = tune(log);
    check('guard null or absent: stock', [none, absent].every(t => t.report.extrapolatedCells === 0
        && t.tuned[D(400)][R(2200)] === stockAt(2200, 400)));

    // The shrink follows a measurement; it cannot make a log acceptable on its own.
    const two = tune([...cruise(1.0), ...[100, 200].flatMap(d => cell(2200, d, truth(2200, d, 0.9)))], { highDeltaGuard: OK });
    check('two measured cells + two extrapolated: still not acceptable', two.report.gridCellsUpdated === 4
        && two.report.extrapolatedCells === 2 && two.acceptable === false,
        `${two.report.gridCellsUpdated} ${two.report.extrapolatedCells} ${two.acceptable}`);
}

console.log('\n[300/400 over several DRREL passes: the shrink is against BMW\'s table, not the loaded one]');
{
    const ref = CSL_STOCK_RF_KORR_DRREL;
    check('CSL_STOCK_RF_KORR_DRREL is the shipped partial\'s DRREL, axes and values',
        ref.RPM.join() === EGT.rfKorr.rpm.join() && ref.DELTA.join() === EGT.rfKorr.delta.join()
        && ref.RAW.every((row, r) => row.every((v, c) => v / 1024 === EGT.rfKorr.values[r][c])));
    // D = 1.0 measured at Δ 40/100/200 on every pass (α ≈ 0) and fed back: each pass loads the
    // table the last one wrote, and K is what that table applied. Against the loaded table the
    // ratio was pass-relative — s read 1 once row 200 stopped moving, and the column had no excess
    // left once it reached 1.000 — so 300/400 froze where the -0.05 step had got them.
    const OK = { samples: 30, leanLocked: 0, ok: true };
    let egt = EGT;
    const path = { 300: [stockAt(2200, 300)], 400: [stockAt(2200, 400)] };
    for (let pass = 1; pass <= 10; pass++) {
        const k = (d) => egt.rfKorr.values[D(d)][R(2200)];
        const log = [
            ...cruise(1.0),
            ...[40, 100, 200].flatMap(d => [20, 30].flatMap(load => block({ rpm: 2200, delta: d, d: 1.0, k: k(d), load }))),
        ];
        const res = tune(log, { highDeltaGuard: OK }, egt);
        for (const d of [300, 400]) path[d].push(res.tuned[D(d)][R(2200)]);
        egt = { ...egt, rfKorr: { ...egt.rfKorr, values: res.tuned.map(row => [...row]) } };
    }
    const stepped = (xs) => xs.every((v, i) => i === 0 || near(v, Math.max(1, xs[i - 1] - 0.05), 1e-9));
    check('row 300 steps down 0.05 every pass until 1.000 — no freeze part-way',
        stepped(path[300]) && near(path[300].at(-1), 1), path[300].map(v => v.toFixed(3)).join(' '));
    check('row 400 the same', stepped(path[400]) && near(path[400].at(-1), 1), path[400].map(v => v.toFixed(3)).join(' '));
}

console.log('\n[Δ*: the fixed point the DME\'s own pass-by-pass update settles on]');
{
    // Linear tables with a closed-form answer. model = 400 + 500 RF, DRREL = 1 + 0.001 (Δ - 30), so
    //     K = 1 + 0.001 (400 + 500 rf_soll K - TABG - 30)  ->  K = (1.37 - 0.001 TABG) / (1 - 0.5 rf_soll)
    // At rf_soll 0.8, TABG 600: K = 0.77 / 0.6 = 1.28333..., Δ = 313.33..., inside the axis.
    const ax = [1000, 3000, 6000];
    const deltaAx = [30, 40, 100, 200, 300, 400];
    const lin = {
        rfKorr: { rpm: ax, delta: deltaAx, values: deltaAx.map(d => ax.map(() => 1 + 0.001 * (d - 30))) },
        tabgModel: { rpm: ax, rf: [0, 0.5, 1.0, 1.5], values: [0, 0.5, 1.0, 1.5].map(rf => ax.map(() => 400 + 500 * rf)) },
        rfKorrMin: { rpm: ax, values: [0.5, 0.5, 0.5] }, hys: 0.1, vMin: 20,
    };
    const fp = counterfactualRfKorr(lin, 2500, 0.8, 600);
    check('closed form: K* = 0.77 / 0.6', near(fp.k, 0.77 / 0.6, 1e-7), String(fp.k));
    check('...Δ* = 400 + 500·0.8·K* - 600', near(fp.delta, 400 + 400 * (0.77 / 0.6) - 600, 1e-4), String(fp.delta));
    const once = 1 + 0.001 * (400 + 500 * 0.8 - 600 - 30);
    check('...and it is not the one-pass value at rf_soll (the iteration is the point)', fp.k - once > 0.05,
        `${fp.k} vs ${once}`);

    // BMW's tables, against the DME's update run pass by pass with an interpolation written here
    // (clamped bilinear, the DME's kfu_wint) rather than borrowed from egtTables.
    const lerp = (x, v, q) => {
        if (!(q > x[0])) return { i: 0, j: 0, w: 0 };
        const last = x.length - 1;
        if (!(q < x[last])) return { i: last, j: last, w: 0 };
        let i = 0; while (q > x[i + 1]) i++;
        return { i, j: i + 1, w: (q - x[i]) / (x[i + 1] - x[i]) };
    };
    const bilinear = (x, y, z, xq, yq) => {
        const a = lerp(x, null, xq), b = lerp(y, null, yq);
        const row = (r) => z[r][a.i] * (1 - a.w) + z[r][a.j] * a.w;
        return row(b.i) * (1 - b.w) + row(b.j) * b.w;
    };
    const dme = (rpm, rfSoll, tabg) => {
        let k = 1;
        for (let pass = 0; pass < 500; pass++) {
            const delta = Math.max(0, bilinear(EGT.tabgModel.rpm, EGT.tabgModel.rf, EGT.tabgModel.values, rpm, rfSoll * k) - tabg);
            k = bilinear(EGT.rfKorr.rpm, EGT.rfKorr.delta, EGT.rfKorr.values, rpm, delta);
        }
        return k;
    };
    let worst = 0, moved = 0;
    for (const rpm of [2200, 2500, 3000, 3500]) for (const rfSoll of [0.7, 0.8, 0.9]) for (const tabg of [200, 260, 320, 400]) {
        const got = counterfactualRfKorr(EGT, rpm, rfSoll, tabg);
        worst = Math.max(worst, Math.abs(got.k - dme(rpm, rfSoll, tabg)));
        if (got.k > 1.05) moved++;
    }
    check('stock 0401 tables, 48 operating points: the DME\'s K to 1e-9', worst < 1e-9, String(worst));
    check('...over points where the correction is really engaged', moved >= 20, String(moved));
}

// --- the guard over a synthetic K HOLD drive -----------------------------------------------------

/**
 * A switching P+I loop in continuous time (5 ms), the sensor seeing the mixture `delay` late, read
 * every 0.3 s — the VE profile's ~3 Hz. `m` is how lean the hold leaves the engine: the loop
 * centres on trim = 1 / m. Bank 2 rides 0.004 below bank 1.
 */
function holdLoop({ m1 = 1.0, m2 = m1, T = 12, delay = 0.12, trim0 = 1.0 }) {
    const dt = 0.005, lag = Math.round(delay / dt), every = Math.round(0.3 / dt);
    const KI_NEG = 0.0406, KI_POS = 0.050, P_POS = LAMBDA_P_JUMP_FALLBACK.pos, P_NEG = LAMBDA_P_JUMP_FALLBACK.neg;
    const banks = [{ trim: trim0 + 0.003, m: m1, mix: [], was: null }, { trim: trim0 - 0.001, m: m2, mix: [], was: null }];
    const out = [];
    for (let i = 0; i * dt <= T; i++) {
        for (const b of banks) {
            b.mix.push(b.trim * b.m);
            const rich = b.mix[Math.max(0, i - lag)] > 1;
            if (b.was !== null && rich !== b.was) b.trim += rich ? -P_NEG : P_POS;
            else b.trim += (rich ? -KI_NEG : KI_POS) * dt;
            b.trim = Math.min(1.3, Math.max(0.7, b.trim));
            b.was = rich;
        }
        if (i % every === 0) out.push(banks.map(b => Math.round(b.trim * 32768) / 32768));
    }
    return out;
}
// 2500 rpm, RF 75 % — over the stock 0.65 floor, so the stock gate would have entered — at 80 km/h.
// TABG 240 puts Δ* well above 300 on BMW's model; 520 puts it at the bottom of the table.
const RF_HOLD = 75;
const deltaStar = (tabg) => counterfactualRfKorr(EGT, 2500, (RF_HOLD + RF_TRUNCATION_MEAN_PERCENT) / 100, tabg).delta;
const holdLog = (trims, { tabg = 240, t0 = 0, rf = RF_HOLD, v = 80 } = {}) => trims.map(([a, b], i) => ({
    time: +(t0 + 0.3 * i).toFixed(6), rpm: 2500, rawLoad: 20, stft1: a, stft2: b, rf, vehicleSpeed: v, exhaustTemp: tabg,
}));

console.log('\n[the high-Δ guard over a K HOLD drive]');
{
    check(`the synthetic sits at Δ* >= ${HIGH_DELTA_GUARD_DELTA_MIN} (Δ* ${deltaStar(240).toFixed(0)})`, deltaStar(240) >= HIGH_DELTA_GUARD_DELTA_MIN);
    check(`...and the cold-model case below it (Δ* ${deltaStar(520).toFixed(0)})`, deltaStar(520) < HIGH_DELTA_GUARD_DELTA_MIN);

    const cycling = holdLoop({ m1: 1.0 });
    const g = computeHighDeltaGuard(holdLog(cycling), HELD);
    check('a loop that reaches λ = 1: every sample counted, none lean-locked, ok',
        g && g.samples === cycling.length && g.leanLocked === 0 && g.ok === true, JSON.stringify(g));

    // 8 % lean under the hold: the trim has to climb to 1.087 at I+ 0.050/s, 1.7 s of rising with no
    // rich switch — past P+ + 0.02 = 0.04 after 0.8 s.
    const lean = computeHighDeltaGuard(holdLog(holdLoop({ m1: 0.92 })), HELD);
    check('8 % lean: lean-locked samples, not ok', lean && lean.leanLocked > 0 && lean.ok === false, JSON.stringify(lean));
    // Lean before Δ* got to 300: the climb is over and the loop cycles around 1.064. Still lean.
    const settledLean = computeHighDeltaGuard(holdLog(holdLoop({ m1: 0.94, trim0: 1 / 0.94 })), HELD);
    check('6 % lean, the trim already cycling at 1.064: locked by its level, not ok',
        settledLean && settledLean.leanLocked > settledLean.samples * 0.8 && !settledLean.ok, JSON.stringify(settledLean));
    const pinned = computeHighDeltaGuard(holdLog(holdLoop({ m1: 0.7, T: 20 })), HELD);
    check('30 % lean, both banks on the +clamp: locked, not ok', pinned && pinned.leanLocked > 0 && !pinned.ok, JSON.stringify(pinned));
    const oneBank = computeHighDeltaGuard(holdLog(holdLoop({ m1: 0.92, m2: 1.0 })), HELD);
    // One table feeds both banks, so a shrink the lean bank needed the enrichment for leans it.
    check('only one bank lean: that is a lock, not ok',
        oneBank && oneBank.leanLocked > 0 && oneBank.ok === false, JSON.stringify(oneBank));
    // The threshold itself, on hand-written lean phases: trough, the P+ jump, then the I ramp — a
    // rise of P+ + 0.015 and a rich switch is a normal half cycle; P+ + 0.025 is a lock.
    const P = LAMBDA_P_JUMP_FALLBACK.pos;
    const phase = (top) => {
        const out = [];
        for (let rep = 0; rep < 4; rep++) {
            out.push(1.0, 1.0 + P);
            for (let x = 1.0 + P + 0.005; x <= 1.0 + top + 1e-9; x += 0.005) out.push(x);
            out.push(1.0 + top - 0.012, 1.0 + 0.002);   // the rich switch, and down the I- ramp
        }
        return out.map(v => [v, v - 0.004]);
    };
    const normal = computeHighDeltaGuard(holdLog(phase(P + LEAN_LOCK_MARGIN - 0.005)), HELD);
    check(`a lean phase rising P+ + ${LEAN_LOCK_MARGIN - 0.005} and switching: no lock`,
        normal && normal.leanLocked === 0 && normal.samples >= HIGH_DELTA_GUARD_MIN_SAMPLES, JSON.stringify(normal));
    const over = computeHighDeltaGuard(holdLog(phase(P + LEAN_LOCK_MARGIN + 0.005)), HELD);
    check(`...rising P+ + ${LEAN_LOCK_MARGIN + 0.005}: locked at the top of each phase`,
        over && over.leanLocked === 4, JSON.stringify(over));

    const short = computeHighDeltaGuard(holdLog(cycling.slice(0, HIGH_DELTA_GUARD_MIN_SAMPLES - 1)), HELD);
    check(`fewer than ${HIGH_DELTA_GUARD_MIN_SAMPLES} samples at Δ* >= 300: not ok`,
        short && short.samples === HIGH_DELTA_GUARD_MIN_SAMPLES - 1 && short.leanLocked === 0 && !short.ok, JSON.stringify(short));
    const cold = computeHighDeltaGuard(holdLog(cycling, { tabg: 520 }), HELD);
    check('Δ* under 300: nothing counted', cold && cold.samples === 0 && !cold.ok, JSON.stringify(cold));
    const slow = computeHighDeltaGuard(holdLog(cycling, { v: 15 }), HELD);
    check('under 20 km/h the stock gate would not have entered: nothing counted', slow && slow.samples === 0);
    const light = computeHighDeltaGuard(holdLog(cycling, { rf: 50 }), HELD);
    check('rf_soll under the stock floor: nothing counted', light && light.samples === 0);
    const off = computeHighDeltaGuard(holdLog(cycling.map(() => [1, 1])), HELD);
    check('loop off (both banks exactly 1.000, the VL): nothing counted', off && off.samples === 0);
    check('not a K HOLD drive: null', computeHighDeltaGuard(holdLog(cycling), EGT) === null);
    check('a hold that did not take (stock floor back): null', computeHighDeltaGuard(holdLog(cycling), withStockRfKorrFloor(HELD)) === null);
}

console.log('\n[end to end: annotateRfKorr -> kRamp -> the tuner]');
{
    // A flat Alpha-N map at 0.9 and flat air curves, so rf_soll is 0.9 everywhere and RF / rf_soll is
    // the K the log carries. Gate-shut cruise under 20 km/h with the exhaust warm (Δ 30, A = 1: the
    // converged VE), then the gate opens at Δ 100 on two VE cells: K steps to DRREL(2200, 100), the
    // loop ramps down, switches, and cycles around trim = A / K.
    const FLAT_AIR = {
        curves: {
            tan: { x: [-40, 0, 20, 60, 100], values: [1, 1, 1, 1, 1] },
            pUmg: { x: [600, 800, 960.5, 1050, 1100], values: [1, 1, 1, 1, 1] },
        },
        loadTable: null,
    };
    const RF_SOLL = 0.9;
    const A = truth(2200, 100, 0.5);
    const K = stockAt(2200, 100);
    const segments = [
        { T: 12, open: false, k: 1, a: 1, delta: 30, load: 20 },
        { T: 14, open: true, k: K, a: A, delta: 100, load: 20 },
        { T: 6, open: false, k: 1, a: 1, delta: 30, load: 20 },
        { T: 14, open: true, k: K, a: A, delta: 100, load: 30 },
    ];
    const dt = 0.005, lag = Math.round(0.12 / dt), every = Math.round(0.3 / dt);
    let trim = 1.002, was = null, i = 0;
    const mix = [], log = [];
    for (const s of segments) {
        for (let n = 0; n * dt < s.T; n++, i++) {
            mix.push(trim * s.k / s.a);
            const rich = mix[Math.max(0, i - lag)] > 1;
            if (was !== null && rich !== was) trim += rich ? -LAMBDA_P_JUMP_FALLBACK.neg : LAMBDA_P_JUMP_FALLBACK.pos;
            else trim += (rich ? -0.0406 : 0.050) * dt;
            was = rich;
            if (i % every === 0) {
                const rf = 100 * RF_SOLL * s.k - RF_TRUNCATION_MEAN_PERCENT;
                const q = (x) => Math.round(x * 32768) / 32768;
                log.push({
                    time: +(i * dt).toFixed(6), rpm: 2200, rawLoad: s.load, correctedLoad: s.load,
                    stft1: q(trim), stft2: q(trim - 0.004), rf, vehicleSpeed: s.open ? 80 : 10,
                    intakeTemp: 20, ambientPressure: 960.5,
                    exhaustTemp: tabgModelAt(EGT, 2200, (rf + RF_TRUNCATION_MEAN_PERCENT) / 100) - s.delta,
                });
            }
        }
    }
    const ann = new VECalculator().annotateRfKorr(MAP, log, EGT, FLAT_AIR, log);
    const res = tuneRfKorrTable(MAP, ann, EGT, VE_AXES);
    const r = D(100), c = R(2200);
    check('the walk marked both the ramps and the settled samples',
        ann.some(p => p.rfKorrGateOpen && p.kRamp === true) && ann.some(p => p.rfKorrGateOpen && p.kRamp === false));
    check('not refused: the cruise trims centre on 1.000', res?.report.refused === null,
        `${res?.report.refused} median ${res?.report.anchorTrimMedian}`);
    check('mid-ramp samples were counted out', res.report.samplesKRamp > 0, String(res.report.samplesKRamp));
    check('the 2200 / 100 cell is written', res.updated[r][c], `${res.rejected[r][c]} n=${res.countMap[r][c]}`);
    check(`...at A(Δ) = ${A.toFixed(4)} to within the limit cycle (±0.005)`, Math.abs(res.measuredMap[r][c] - A) < 0.005,
        res.measuredMap[r][c].toFixed(4));
    // What the old same-time write would have used: the ramp from K down to A, i.e. the clock.
    const mid = ann.filter(p => p.rfKorrGateOpen && p.kRamp === true && p.stft1 !== undefined)
        .map(p => p.rfKorr * (p.stft1 + p.stft2) / 2);
    const midMean = mid.reduce((x, y) => x + y, 0) / mid.length;
    check(`...where the mid-ramp samples alone average ${midMean.toFixed(4)}, between K ${K.toFixed(4)} and A`,
        midMean - A > 0.008 && midMean < K + 0.003, `${midMean} K ${K} A ${A}`);
}

console.log(fails === 0 ? '\nAll rf-korr tuner checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
