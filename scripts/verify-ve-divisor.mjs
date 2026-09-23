/**
 * The tuned VE derivation: does it divide by a correction the DME will actually apply?
 *
 * `New = Old × STFT × rf_korr ÷ k_new` (docs/ecu-logic/60 §6.4). The division exists so that a VE
 * map flashed alongside a rewritten KF_RF_KORR_DRREL is not corrected twice — the DME multiplies
 * k_new back in on the road, and the table must hold the nominal-temperature filling.
 *
 * That is only true where the DME reads the table at all. The correction is gated on filling:
 * `rf_soll > kl_rf_korr_rf_min(N)`, and below the floor rf_korr is 0x400 = 1.000 no matter how cold
 * the exhaust is (docs/ecu-logic/20 §1, master 0x021A70). Dividing a gate-shut sample by a table
 * value leaves `1/k_new` in the map with nothing to cancel it — and because the table's floor is
 * 1.000 and Δ is clipped at 0, that residual can only ever be LEAN.
 *
 * Measured on session #904 before the fix: 12.3 % of samples had the gate open, and 39.9 % were
 * gate-shut with a divisor above 1 (median 1.023, max 1.242).
 *
 * Everything here runs the real VECalculator against a real-shaped stock table, so the assertions
 * are about the shipped arithmetic and not a restatement of it.
 */
import { VECalculator, RF_TRUNCATION_MEAN_PERCENT, RF_KORR_SETTLE_SEC_DEFAULT } from '../src/lib/ve-calculator/calculator.ts';
import { RfKorrLatch } from '../src/lib/ve-calculator/egtTables.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

/**
 * The air every sample here is measured in.
 *
 * `annotateRfKorrPoint` no longer produces an rf_korr without one, because `RF / kf_rf_soll` is
 * `RF_PT_KORR * rf_korr` and the density has to come out before the number means anything. These
 * curves are flat at exactly 1.0000 so RF_PT_KORR is 1 everywhere and every assertion below is
 * about the DIVISION, unchanged — the density behaviour has its own section at the end.
 */
const FLAT_AIR = {
    curves: {
        tan: { x: [-40, 0, 20, 60, 100], values: [1, 1, 1, 1, 1] },
        pUmg: { x: [600, 800, 960.5, 1050, 1100], values: [1, 1, 1, 1, 1] },
    },
};
/**
 * Whatever a sample carries, plus an air the flat curves read as 1.000 — and an `rf` reported the
 * way the DME reports one.
 *
 * `rf_soll = (table * RF_PT_KORR) >> 12` and `RF = (rf_soll * rf_korr) >> 10` are truncations, so
 * the DME's RF sits about one 0.1 %RF step below the exact arithmetic and
 * `annotateRfKorrPoint` adds that step back (RF_TRUNCATION_MEAN_PERCENT). A synthetic sample built
 * from floating-point arithmetic has no such step missing, so it has to be taken out here or every
 * identity below is off by 0.1/RF — which at rf = 30 is 0.33 %, larger than several of the margins
 * these checks exist to hold.
 *
 * Written as a subtraction rather than by simulating the two shifts because the constant is a MEAN:
 * the real loss is uniform over an LSB and only its average is knowable, which is exactly what the
 * app adds back.
 */
const inAir = (sample) => ({
    // Moving, by default. `rf_korr_calc`'s condition has TWO operands and the second is
    // `k_rf_korr_v_min < V`, so a sample with no road speed is a sample that cannot be shown to
    // have cleared a 20 km/h floor — and `rfKorrActive` refuses it. Defaulted here rather than
    // written into thirty call sites, because "was the car moving" is not what most of these
    // checks are about; the ones that ARE override it.
    //
    // SETTLED by default, for the same reason. A gate-open sample younger than
    // `RF_KORR_SETTLE_SEC_DEFAULT` (1.0 s) is written with the trim alone, because the lambda loop
    // has not answered the enrichment yet. Every check below is about the DIVISOR rather than the
    // clock, so they say 30 s and the one section that IS about the clock overrides it.
    intakeTemp: 20, ambientPressure: 960.5, vehicleSpeed: 80, rfKorrDwellSec: 30, ...sample,
    ...(sample.rf === undefined ? {} : { rf: sample.rf - RF_TRUNCATION_MEAN_PERCENT }),
});

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;

// --- Stand-ins shaped like the real tables ------------------------------------------------------
// Axes and magnitudes from the CSL 0401 binary: Δ = [30,40,100,200,300,400] with the Δ=30 row
// pinned at 1.000, and a floor of 0.55-0.80 filling.
const DELTA_AXIS = [30, 40, 100, 200, 300, 400];
const KORR_RPM = [1100, 1600, 2200, 3000, 4000, 5100];
const korrRow = (v) => KORR_RPM.map(() => v);
const KORR = [korrRow(1.000), korrRow(1.020), korrRow(1.120), korrRow(1.250), korrRow(1.320), korrRow(1.371)];

const egt = {
    rfKorr: { rpm: KORR_RPM, delta: DELTA_AXIS, values: KORR },
    // Flat 400 °C model, so Δ is simply 400 − TABG and a test can dial it directly.
    tabgModel: { rpm: KORR_RPM, rf: [0, 0.2, 0.4, 0.6, 0.8, 1.0], values: Array.from({ length: 6 }, () => korrRow(400)) },
    rfKorrMin: { rpm: KORR_RPM, values: korrRow(0.55) },
    hys: 0.1,
    vMin: 20,
};
const tuned = {
    rpm: KORR_RPM, delta: DELTA_AXIS, stock: KORR, tuned: KORR,
    countMap: [], weightMap: [], spreadMap: [], measuredMap: [], updated: [], rejected: [],
    anchorMap: [], anchorWeightMap: [], acceptable: true, report: {},
};

const calc = new VECalculator();
// A flat map so rf_soll is one number wherever the sample lands, and the gate is set by choosing
// that number rather than by hunting for a cell.
const mapOf = (v) => ({ xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => v)) });

/** One sample through the real path; returns the cell's nominal and tuned corrections. */
function run(map, sample, { apply = true, writeRfKorr = true, air = FLAT_AIR, tunedTable = tuned, gate = null } = {}) {
    // `gate` is the latch's verdict, and it is passed EXPLICITLY on every call. null means "no
    // history — decide from the entry condition alone", which is what a lone synthetic sample can
    // honestly claim. The section below is the one that exercises a real latch; everywhere else the
    // sample is built to be unambiguous either way.
    const point = calc.annotateRfKorrPoint(map, inAir(sample), egt, air, gate);
    const grid = calc.createGrid();
    // Enough copies to clear the evidence gate, which is 10 samples and weight 5.
    for (let i = 0; i < 40; i++) calc.accumulatePoint(grid, point, { source: 'rf-ratio', apply }, writeRfKorr ? tunedTable : null);
    const out = calc.finalizeGrid(map, grid, { minCellSamples: 1, minCellWeight: 0.01, tunedRfKorr: writeRfKorr ? tunedTable : null, writeRfKorr });
    let best = null;
    for (let r = 0; r < LOAD.length; r++) for (let c = 0; c < RPM.length; c++) {
        if (out.hitMap[r][c] > 0 && (!best || out.weightMap[r][c] > best.w)) {
            // `demandMap`, not `correctionMap`: this file is about WHICH rf_korr is divided out,
            // and correctionMap carries the significance shrinkage on top of that. The demand is
            // the divisor arithmetic alone, and it is defined even where the cell was refused —
            // which matters here, because a gate-shut sample legitimately demands exactly 1.000
            // and a cell demanding no change is (correctly) not written.
            best = { w: out.weightMap[r][c], correction: out.demandMap[r][c], usedTuned: out.tunedUsedMap[r][c], written: out.correctionMap[r][c] };
        }
    }
    return { point, ...best };
}

// rf_soll 0.30 -> below the 0.55 floor -> gate SHUT. rf is a percentage, so rf = 30 * rfKorr.
const SHUT = mapOf(0.30);
// rf_soll 0.70 -> above the floor -> gate OPEN.
const OPEN = mapOf(0.70);

console.log('\n[the gate verdict is recorded on the sample]');
{
    const shut = run(SHUT, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 30, exhaustTemp: 100 });
    const open = run(OPEN, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 70, exhaustTemp: 100 });
    check('shut below the filling floor', shut.point.rfKorrGateOpen === false);
    check('open above it', open.point.rfKorrGateOpen === true);
    check('Δ is model − TABG either way', shut.point.tabgDelta === 300 && open.point.tabgDelta === 300);
}

console.log('\n[the SPEED half of the gate — the operand nothing in this app evaluated]');
{
    /*
     * `rf_korr_calc` is ONE `if` with two operands:
     *
     *     if (rf_korr_rf_min < rf_soll && k_rf_korr_v_min < V)  rf_korr = KF_RF_KORR_DRREL(...)
     *     else ... rf_korr = 0x400;                                                    // 1.000
     *
     * The load half has been reproduced since the divisor fix above. The speed half was not — `V`
     * was on no block this app read when the code was written, and when it arrived on the RAM read
     * (2026-08-30) nothing was changed to use it. `EgtTables.vMin` said so in its own comment for
     * nine months.
     *
     * What that cost, on the car. Session #941, cell 2400 rpm / 7.5 % opening, eight samples
     * reached the calculation. FIVE were taken at 13-15 km/h, so `rf_korr_calc` fell through both
     * branches to `rf_korr = 0x400` and the correction really was 1.000. The app measured
     * `RF / rf_soll` = 1.161 and wrote `trim x that` = 0.957 x 1.161 = +11.3 %; the bytes moved
     * +11.5 %. `rfKorrFromEgt`, which already reproduced the load half, said 1.000 on all eight —
     * two routes, one gated and one not, and the map was built from the ungated one.
     *
     * Repeated over six drives the cell climbed 0.637 to 0.851 (+32 %, and 12 % above CSL stock)
     * while the lambda controller moved the opposite way: 0 samples near its rich clamp on #941,
     * 96 on #946, one of them 1.4 % off the 0.700 floor.
     */
    const s = { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 100 };
    const opts = { writeRfKorr: false };
    const moving = run(OPEN, { ...s, vehicleSpeed: 80 }, opts);
    const crawling = run(OPEN, { ...s, vehicleSpeed: 15 }, opts);
    const atFloor = run(OPEN, { ...s, vehicleSpeed: 20 }, opts);
    const unknown = run(OPEN, { ...s, vehicleSpeed: undefined }, opts);

    check('above the floor and moving -> open', moving.point.rfKorrGateOpen === true);
    check('...and rf_korr is the measured ratio', near(moving.point.rfKorr, 1.1, 1e-9),
        String(moving.point.rfKorr));
    check('...so the correction carries it', near(moving.correction, 1.1, 1e-9),
        String(moving.correction));

    check('above the floor but under 20 km/h -> SHUT', crawling.point.rfKorrGateOpen === false);
    check('...and rf_korr is exactly 1, whatever the ratio read',
        crawling.point.rfKorr === 1, String(crawling.point.rfKorr));
    check('...so the cell is moved by the trim alone', near(crawling.correction, 1.0, 1e-9),
        String(crawling.correction));
    check('...which is a 10.0 % difference on this sample',
        Math.abs(moving.correction / crawling.correction - 1) > 0.09,
        String(moving.correction / crawling.correction - 1));

    // `k_rf_korr_v_min < V`, strictly. A car sitting exactly on the floor has not cleared it.
    check('exactly at the floor is not above it', atFloor.point.rfKorrGateOpen === false);
    // Refuse rather than assume — assuming it passed is precisely what produced the paragraph above.
    check('no road speed at all -> shut, not assumed open', unknown.point.rfKorrGateOpen === false);
    check('...and no rf_korr credited', unknown.point.rfKorr === 1, String(unknown.point.rfKorr));

    // The raw ratio survives, because two things need it: `egtFromRfKorr` inverts it against the
    // TABG sensor, and clamping its input would make that cross-check agree by construction.
    check('the ungated ratio is still recorded', near(crawling.point.rfKorrUngated, 1.1, 1e-9),
        String(crawling.point.rfKorrUngated));
    check('...and it is what the EGT cross-check was inverted from',
        crawling.point.egtFromRfKorr !== undefined && crawling.point.egtFromRfKorr < 400,
        String(crawling.point.egtFromRfKorr));
    // ...while the table route reads the gate, so the two disagree on purpose here. That
    // disagreement is the instrument: it is what says "these are different questions".
    check('the table route is pinned at 1.000 where the gate is shut',
        crawling.point.rfKorrFromEgt === 1.0, String(crawling.point.rfKorrFromEgt));
}

console.log('\n[the HOLD branch — the third outcome, which no per-sample test can reach]');
{
    /*
     * `rf_korr_calc` has three branches, not two:
     *
     *     if (floor < rf_soll && vMin < V)               enter, read the table
     *     else if (floor - hys <= rf_soll && vMin <= V)   HOLD whatever was latched
     *     else                                           reset to 1.000
     *
     * So a sample sitting in the hysteresis band is enriched or not according to how the car
     * ARRIVED, and the entry condition alone calls every one of them shut. Measured over
     * #941-#946 that mislabels 930 samples — 28.4 % of the truly enriched population — and writes
     * -8.25 % on them where the correct factor is -0.53 %.
     *
     * The floor here is 0.55 and hys is 0.1, so rf_soll 0.50 is inside the band: above 0.45, below
     * 0.55. Same sample, same everything, two arrival histories.
     */
    const BAND = mapOf(0.50);
    const latch = new RfKorrLatch();
    const s = (rf) => inAir({ time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf, exhaustTemp: 100 });

    // The band, reached from BELOW: nothing was ever latched, so the DME is at 1.000.
    check('cold: entry condition alone says shut in the band',
        latch.step(egt, 2200, 0.50, 80) === false);
    // Cross above the floor: the DME enters and reads the table.
    check('crossing above the floor enters', latch.step(egt, 2200, 0.70, 80) === true);
    // Fall back INTO the band: the hold branch keeps it engaged.
    check('falling back into the band HOLDS', latch.step(egt, 2200, 0.50, 80) === true);
    // Fall below floor - hys: reset.
    check('falling under floor - hys resets', latch.step(egt, 2200, 0.40, 80) === false);
    // Speed alone resets it, even inside the band.
    latch.step(egt, 2200, 0.70, 80);
    check('dropping under 20 km/h resets it', latch.step(egt, 2200, 0.50, 15) === false);

    // And what that verdict is worth, on the cell.
    const held = run(BAND, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 55, exhaustTemp: 100 }, { writeRfKorr: false, gate: true });
    const cold = run(BAND, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 55, exhaustTemp: 100 }, { writeRfKorr: false, gate: false });
    check('held: the measured enrichment is credited', near(held.point.rfKorr, 1.1, 1e-9),
        String(held.point.rfKorr));
    check('cold: it is not', cold.point.rfKorr === 1, String(cold.point.rfKorr));
    check('...and the two write a 10 % different correction',
        Math.abs(held.correction / cold.correction - 1) > 0.09,
        String(held.correction / cold.correction - 1));
    // The raw ratio is identical either way — the ONLY thing that differs is arrival history.
    check('the sample itself is the same measurement',
        near(held.point.rfKorrUngated, cold.point.rfKorrUngated, 1e-12));
}

console.log('\n[the settle clock — an enrichment the loop has not answered is not evidence]');
{
    /*
     * The DME steps the fuel by rf_korr the instant its latch closes; the lambda loop cannot see
     * that for about a second. Inside the window `trim` still reads the mixture from BEFORE the
     * step, so `trim x rf_korr` credits the cell with the whole of rf_korr and measures nothing.
     *
     * Measured over #941-#946 by seconds since the latch closed, against a control of gate-shut
     * cells at load >= 5 sitting at -0.11 %:
     *
     *     0-0.5 s +9.93 %  |  1-1.5 s +7.44 %  |  2-3 s +1.69 %  |  5+ s -4.94 %  |  pooled +2.18 %
     *
     * Replacing everything under N with the trim alone lands the pooled figure at -0.76 % for
     * N = 1.0 and overshoots to -4.66 % by N = 3, because by then the loop HAS responded.
     *
     * The sample below is the same sample four times, differing only in its clock.
     */
    const s = { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 100 };
    const at = (dwell) => run(OPEN, { ...s, rfKorrDwellSec: dwell }, { writeRfKorr: false });

    check('the default is one second', RF_KORR_SETTLE_SEC_DEFAULT === 1.0,
        String(RF_KORR_SETTLE_SEC_DEFAULT));
    check('settled: the correction carries rf_korr', near(at(30).correction, 1.1, 1e-9),
        String(at(30).correction));
    check('just over the threshold: still carried', near(at(1.0).correction, 1.1, 1e-9),
        String(at(1.0).correction));
    check('just under it: the trim alone', near(at(0.99).correction, 1.0, 1e-9),
        String(at(0.99).correction));
    check('the instant it engaged: the trim alone', near(at(0).correction, 1.0, 1e-9),
        String(at(0).correction));

    // NOT dropped. The whole objection to a settle FILTER on this path is that the enriched
    // population lives in the high-load cells, so removing it deletes the region being fixed.
    check('an unsettled sample still reaches its cell', at(0).w > 0, String(at(0).w));
    check('...with the same weight a settled one carries', near(at(0).w, at(30).w, 1e-12));
    // And the measurement itself is untouched — only what is DONE with it changes.
    check('rf_korr is still recorded on the sample', near(at(0).point.rfKorr, 1.1, 1e-9),
        String(at(0).point.rfKorr));

    // A gate-open sample with no clock at all cannot be shown to have settled.
    const noClock = run(OPEN, { ...s, rfKorrDwellSec: undefined }, { writeRfKorr: false, gate: true });
    check('no clock on a gate-open sample reads as unsettled',
        near(noClock.correction, 1.0, 1e-9), String(noClock.correction));
    // A gate-SHUT sample has no step to wait for, so the clock must not gate it.
    const shutNoClock = run(SHUT, { time: 0, rpm: 2200, rawLoad: 30, stft1: 0.9, stft2: 0.9, rf: 30, exhaustTemp: 100, rfKorrDwellSec: undefined }, { writeRfKorr: false });
    check('a gate-shut sample is never held back by the clock',
        near(shutNoClock.correction, 0.9, 1e-9), String(shutNoClock.correction));
}

console.log('\n[gate SHUT: the DME applies 1.000, so nothing may be divided out]');
{
    // TABG 100 °C against a 400 °C model is Δ = 300, where the table reads 1.320. Before the fix
    // this cell came out at 1/1.320 = 0.758 — 24 % lean — on a sample the DME never corrected.
    const r = run(SHUT, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 30, exhaustTemp: 100 });
    check('correction is the trim itself', near(r.correction, 1.0, 1e-6),
        `got ${r.correction} — a divisor leaked in on a gate-shut sample`);
    check('the sample still carries its weight', r.usedTuned === true,
        'a shut gate is a definite statement about the cell, not missing evidence');
}

console.log('\n[gate OPEN: the divisor is the table value at this Δ]');
{
    // rf_soll 0.70, rf 77.0 -> measured rf_korr 1.10. TABG 300 against a 400 model is Δ = 100,
    // where the table reads 1.120.
    const r = run(OPEN, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 300 });
    check('measured rf_korr is RF ÷ rf_soll', near(r.point.rfKorr, 1.1, 1e-9));
    check('correction is STFT × rf_korr ÷ k_new', near(r.correction, 1.0 * 1.1 / 1.120, 1e-6),
        `got ${r.correction}, expected ${1.1 / 1.12}`);
    check('and the cell says it used the tuned path', r.usedTuned === true);
}

console.log('\n[the 15 % guard, stated rather than discovered]');
{
    // TUNED_VS_NOMINAL_MAX compares the tuned candidate against the nominal one, and the candidate
    // IS the nominal divided by k_new — so the test reduces to |1/k_new − 1| ≤ 0.15, i.e. it can
    // only ever pass for k_new ≤ 1.176. A cell whose samples sit where the correction is largest
    // therefore always falls back to the undivided value. That is safe (it under-corrects rather
    // than over-corrects) but it is not what the comment above it describes, and the stock table
    // peaks at 1.371 — so this is pinned here to be revisited deliberately, not rediscovered.
    const r = run(OPEN, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 100 });
    check('Δ = 300 is a divisor the guard must reject', KORR[DELTA_AXIS.indexOf(300)][0] > 1 / (1 - 0.15));
    check('the cell falls back to the undivided correction', near(r.correction, 1.1, 1e-6),
        `got ${r.correction}`);
    check('and says so rather than pretending', r.usedTuned === false);
}

console.log('\n[gate OPEN at Δ ≤ 30: the table is 1.000, so the division is a no-op]');
{
    // TABG 380 against a 400 model is Δ = 20, which clamps to the pinned Δ=30 row.
    const r = run(OPEN, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 70, exhaustTemp: 380 });
    check('divisor is exactly 1.000', near(r.correction, 1.0, 1e-6), `got ${r.correction}`);
}

console.log('\n[the error only ever went one way]');
{
    // Every gate-shut sample with a warm-model/cold-sensor gap used to be divided by ≥ 1.000, and
    // the table has no values below 1.000 to cancel it. So the old behaviour could not run rich.
    const deltas = [40, 100, 200, 300, 400];
    const corrections = deltas.map(d =>
        run(SHUT, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 30, exhaustTemp: 400 - d }).correction);
    check('no gate-shut Δ leans the cell', corrections.every(c => near(c, 1.0, 1e-6)),
        `got ${corrections.map(c => c.toFixed(4)).join(', ')}`);
    check('the table this is measured against really does rise above 1', Math.max(...KORR.flat()) > 1.3);
}

console.log('\n[apply = false: no half of the identity]');
{
    // A legacy 'as-logged' session does not multiply rf_korr in. Dividing anyway gives STFT ÷ k_new,
    // which is neither documented derivation and is lean by the whole size of the correction.
    const r = run(OPEN, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 100 }, { apply: false });
    check('correction is the trim alone', near(r.correction, 1.0, 1e-6), `got ${r.correction}`);
    check('and no tuned value was taken', r.usedTuned === false);
}

console.log('\n[writeRfKorr off: the conservative route never divides]');
{
    const r = run(OPEN, { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 100 }, { writeRfKorr: false });
    check('correction is STFT × rf_korr', near(r.correction, 1.1, 1e-6), `got ${r.correction}`);
}

console.log('\n[no air, no rf_korr — the correction that started all of this]');
{
    // `RF / kf_rf_soll` is not rf_korr. rf_soll_calc (master 0x01A9D2) ends with
    // `rf_soll = (filtered * RF_PT_KORR) >> 12`, so the ratio carries the day's ambient pressure
    // and intake temperature. Multiplying the lambda trim by it cancelled the DME's own density
    // compensation and left the raw air of the measurement day in the table: two drives ten hours
    // apart at 969 and 994 mbar produced maps 2.9 % apart, two campaigns at 888 and 993 mbar 12.9 %,
    // while the trim alone was within 0.5 % of 1.000 on all four days.
    //
    // So a sample that cannot say what air it was taken in gets NO rf_korr, and the calculation
    // falls back to the trim alone — which measurement shows is already pressure-free.
    const map = mapOf(0.60);   // above the 0.55 floor, so the gate would be open
    const hot = { rpm: 3000, rawLoad: 40, rf: 66, exhaustTemp: 200, stft1: 1.0, stft2: 1.0 };

    const withAir = calc.annotateRfKorrPoint(map, inAir(hot), egt, FLAT_AIR);
    check('with air, rf_korr is measured', withAir.rfKorr !== undefined, String(withAir.rfKorr));

    for (const [what, sample] of [
        ['no intake temperature', { ...hot, ambientPressure: 960.5 }],
        ['no ambient pressure', { ...hot, intakeTemp: 20 }],
        ['neither', hot],
    ]) {
        const p = calc.annotateRfKorrPoint(map, sample, egt, FLAT_AIR);
        check(`${what} -> no rf_korr at all`, p.rfKorr === undefined, String(p.rfKorr));
        // And nothing downstream may invent one: no gate verdict, no derived columns.
        check(`${what} -> and no gate verdict either`, p.rfKorrGateOpen === undefined);
    }

    const noCurves = calc.annotateRfKorrPoint(map, inAir(hot), egt, { curves: null });
    check('no curves (no binary) -> no rf_korr', noCurves.rfKorr === undefined);

    // A substituted ambient pressure is a plausible number that is not a measurement — the DME
    // re-learns its substitute from the manifold sensor at key-on. Refused outright.
    const sub = calc.annotateRfKorrPoint(
        map, inAir({ ...hot, ambientPressureSubstituted: true }), egt, FLAT_AIR);
    check('a substituted ambient pressure -> no rf_korr', sub.rfKorr === undefined);

    // The operator-supplied pressure, for logs older than the channel.
    const assumed = calc.annotateRfKorrPoint(
        map, { ...hot, intakeTemp: 20 }, egt, { ...FLAT_AIR, assumedPressureMbar: 888 });
    check('an assumed pressure restores it', assumed.rfKorr !== undefined, String(assumed.rfKorr));
    check('...and the logged pressure wins over the assumed one',
        calc.annotateRfKorrPoint(map, inAir(hot), egt, { ...FLAT_AIR, assumedPressureMbar: 500 })
            .rfKorr !== undefined);
}

console.log('\n[the density really does divide out of the measurement]');
{
    // Real curves this time: pressure linear through 960.5 mbar, temperature the shallow BMW one.
    const air = {
        curves: {
            tan: { x: [0, 20, 40, 60], values: [1.0181, 1.0000, 0.9873, 0.9795] },
            pUmg: { x: [849.5, 897.5, 960.5, 1038.5], values: [0.8828, 0.9375, 1.0000, 1.0781] },
        },
    };
    // 0.80, not 0.60. RF_PT_KORR is 0.915 at 40 °C and 888 mbar, so a 0.60 table put rf_soll at
    // 0.549 — three thousandths UNDER the 0.55 floor — and the low-altitude sample came back
    // gate-shut at exactly 1.000 while the sea-level one measured 1.12. That is the gate working,
    // and it made a check about PRESSURE fail for a reason that had nothing to do with pressure.
    // 0.80 keeps both ends of the range clear of the floor so the check measures what it is named
    // after.
    const map = mapOf(0.80);
    // The SAME engine, the same trim, measured at two altitudes. RF is what the DME reported, and
    // the DME's rf_soll includes RF_PT_KORR — so RF moves with the air even though nothing about
    // the engine did.
    const ptk = (t, p) => {
        const lin = (x, y, at) => {
            for (let i = 0; i < x.length - 1; i++)
                if (at >= x[i] && at <= x[i + 1])
                    return y[i] + (y[i + 1] - y[i]) * (at - x[i]) / (x[i + 1] - x[i]);
            return at < x[0] ? y[0] : y[y.length - 1];
        };
        return lin(air.curves.tan.x, air.curves.tan.values, t)
            * lin(air.curves.pUmg.x, air.curves.pUmg.values, p);
    };
    const at = (tempC, pMbar) => {
        const k = ptk(tempC, pMbar);
        return calc.annotateRfKorrPoint(map, {
            // rf_soll * RF_PT_KORR * rf_korr, less the step the DME's truncations lose.
            rpm: 3000, rawLoad: 40, rf: 100 * 0.80 * k * 1.12 - RF_TRUNCATION_MEAN_PERCENT,
            exhaustTemp: 200, stft1: 1.0, stft2: 1.0, intakeTemp: tempC, ambientPressure: pMbar,
            // Built without `inAir`, so the road speed the gate needs is spelled out here.
            vehicleSpeed: 80,
        }, egt, air).rfKorr;
    };
    const road = at(40, 888), home = at(40, 960.5), hot = at(60, 960.5);
    check('the same rf_korr comes back at 888 mbar and at 960.5',
        near(road, home, 1e-9), `${road} vs ${home}`);
    check('...and at a different intake temperature', near(hot, home, 1e-9), `${hot} vs ${home}`);
    check('...and it is the rf_korr that went in', near(home, 1.12, 1e-9), String(home));
    // Without the division these would differ by the pressure ratio, which is the whole defect.
    check('while the raw ratio would have differed by 7.9 %',
        Math.abs((0.80 * ptk(40, 960.5)) / (0.80 * ptk(40, 888)) - 1) > 0.07);
}

console.log('\n[the step the DME truncates away]');
{
    // Two right shifts on the way from the table to RF, each discarding its remainder: one full
    // 0.1 %RF step below the exact arithmetic, on average. Left alone it reads as a lean-leaning
    // correction that grows toward idle — 1.0 % at RF 10, 0.25 % at RF 40.
    check('the constant is one RF step', RF_TRUNCATION_MEAN_PERCENT === 0.1, String(RF_TRUNCATION_MEAN_PERCENT));

    // A gate-shut sample: rf_korr is 1.0000 by construction, so a correctly measured ratio is 1.
    // Built with the step MISSING, the way a DME reports it.
    const map = mapOf(0.30);
    const reported = 100 * 0.30 - RF_TRUNCATION_MEAN_PERCENT;
    const p = calc.annotateRfKorrPoint(map, {
        rpm: 2200, rawLoad: 30, rf: reported, exhaustTemp: 400, stft1: 1.0, stft2: 1.0,
        intakeTemp: 20, ambientPressure: 960.5,
    }, egt, FLAT_AIR);
    check('a truncated RF still measures rf_korr = 1.000', near(p.rfKorr, 1.0, 1e-12), String(p.rfKorr));

    // Without the correction it would read low, and by more the lower the filling.
    const raw = (rf, table) => (rf / 100) / table;
    check('uncorrected it would read 0.33 % low at RF 30',
        Math.abs((1 - raw(reported, 0.30)) - 0.1 / 30) < 1e-9,
        String(1 - raw(reported, 0.30)));
    check('...and 1.0 % low at RF 10',
        Math.abs((1 - raw(10 - RF_TRUNCATION_MEAN_PERCENT, 0.10)) - 0.1 / 10) < 1e-9);
    check('...so the error grows toward idle, which is where the map is hardest to see',
        (0.1 / 10) > (0.1 / 80));
}


console.log('\n' + '[the tuned table, and its cell gate, are inert when the write is not armed]');
{
    // What licenses hiding the RF KORR CELL GATE from a build that cannot write the table.
    //
    // The gate's two sliders reach the VE map by exactly one route: they shape `tunedRfKorr`, which
    // calculator.ts consults only behind `options.writeRfKorr && tunedRfKorr.acceptable`. And
    // page.tsx ANDs that flag with featureEnabled('rfKorr', ...), so a production build cannot arm
    // it. If that chain holds, the sliders are dead there and a control that changes nothing is
    // worse than an absent one -- the user concludes the derivation is broken.
    //
    // Tested by CHANGING THE TABLE rather than by reading the condition: two tables that disagree
    // everywhere must give the same map when the write is off, and different maps when it is on.
    // The second half is what stops this passing for the wrong reason.
    // The same map and sample the gate-OPEN section above uses, because that one is known to reach
    // the divisor: rf_soll 0.70, rf 77.0, TABG 300 against a 400 model -> the table is read at
    // delta = 100. A sample that never opens the gate would make both halves of this pass for the
    // wrong reason.
    const other = { ...tuned, tuned: KORR.map(row => row.map(v => v * 1.5)) };
    const s = { time: 0, rpm: 2200, rawLoad: 30, stft1: 1.0, stft2: 1.0, rf: 77, exhaustTemp: 300 };

    const offA = run(OPEN, s, { writeRfKorr: false });
    const offB = run(OPEN, s, { writeRfKorr: false, tunedTable: other });
    check('write OFF: a different tuned table changes nothing',
        Math.abs(offA.correction - offB.correction) < 1e-12,
        offA.correction + ' vs ' + offB.correction);
    check('write OFF: the tuned divisor is never marked as used', offA.usedTuned !== true);

    const onA = run(OPEN, s, { writeRfKorr: true });
    const onB = run(OPEN, s, { writeRfKorr: true, tunedTable: other });
    check('write ON: the same two tables DO give different maps -- so the test has teeth',
        Math.abs(onA.correction - onB.correction) > 1e-9,
        onA.correction + ' vs ' + onB.correction);
}

console.log(fails === 0 ? '\nAll checks passed.\n' : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
