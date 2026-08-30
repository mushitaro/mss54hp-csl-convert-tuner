/**
 * The VE evidence gate.
 *
 * ## What it was, and why none of it was derived
 *
 * Until 2026-08-15 the map had no sample threshold at all: the only test was `weightSum > 0.1`, and
 * weightSum is a sum of bilinear corner weights, so ONE sample landing squarely on a cell scored
 * 1.0 and moved it. The 10/30 pair that looked like thresholds were heatmap bands and gated nothing.
 * That 0.1 was EFIAnalytics' default, carried over from 10 Hz Testo logs; the 10 / 5.0 that replaced
 * it was copied from `RF_KORR_TUNE_DEFAULTS`, which does not derive it either.
 *
 * ## What it is now
 *
 * Two measurements changed it. First, the samples in a cell are not independent: `la_f_regler` is a
 * two-point controller oscillating at 1-2 Hz against a 4-5 Hz log, and the measured lag-1
 * autocorrelation is about 0.85 (`analyze:autocorrelation`, six drives), so a cell holds roughly a
 * TWELFTH of the independent evidence its sample count claims. Second, once that is accounted for,
 * the old bounds were writing the wrong cells: on session #1 ten of the fifteen cells they wrote had
 * corrections smaller than their own uncertainty, and two were below one writable table step.
 *
 * So the gate is now a decision rather than a bound. A cell is written when its correction is larger
 * than the uncertainty in it — a Student t test at 95 % — and the correction is then SHRUNK by
 * `1 - (tCrit/t)^2`, so clearing the bar by a hair moves the cell by a hair.
 *
 * ## What this file pins
 *
 * Above all the claim that makes the rest of it necessary: two logs with the SAME sample count, the
 * SAME mean and the SAME scatter, differing only in the ORDER of the samples, must not carry the
 * same weight. And the thing every version of this gate has had to keep getting right — a REJECTED
 * cell still reports the samples it has, because "never driven here" and "drive here again" are
 * different instructions.
 */
import {
    VECalculator, MIN_INDEPENDENT, AUTOCORR_FALLBACK, tCritical95, autocorrInflation, DIRECT_MIN_SAMPLES, VE_MIN_WEIGHT_DEFAULT,
} from '../src/lib/ve-calculator/calculator.ts';
import { APP_CONFIG } from '../src/config/constants.ts';
import { RF_KORR_TUNE_DEFAULTS, withDefaults } from '../src/lib/ve-calculator/rfKorrTuner.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const flat = () => ({ xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => 50)) });

/** Deterministic pseudo-random in [-1, 1], from the index alone. */
function jitter(i) {
    let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * How many samples it takes to hold `MIN_INDEPENDENT` independent observations at the fallback
 * autocorrelation, when they arrive as ONE unbroken run.
 *
 * Solved rather than written down, so this file keeps testing the rule and not a number: if the
 * measured autocorrelation is ever re-derived, or the inflation formula changes, the fixtures
 * follow. Note it is NOT `n * (1-rho)/(1+rho)` — that is the asymptotic form, and a run of a few
 * dozen samples is nowhere near it.
 */
const indepOf = (n) => n / autocorrInflation(AUTOCORR_FALLBACK, n);
let ENOUGH = 2;
while (ENOUGH < 5000 && indepOf(ENOUGH) < MIN_INDEPENDENT + 0.5) ENOUGH++;
let TOO_FEW = ENOUGH;
while (TOO_FEW > 3 && indepOf(TOO_FEW) > MIN_INDEPENDENT - 0.5) TOO_FEW--;

/**
 * n samples landing exactly on one axis intersection, so each contributes weight 1.0.
 *
 * At a REAL log's spacing, 0.2 s, so they form one unbroken run and the autocorrelation correction
 * is actually exercised. They used to be a second apart, which is beyond `AUTOCORR_MAX_GAP_SEC`,
 * so no pairs formed, the run length came out 1 and the samples were treated as fully independent
 * — which is what the gap rule says and is not what a 1.1 s correlation time means. A fixture at a
 * rate no DS2 log runs at was testing a path no drive reaches.
 */
const samples = (n, rpm, load, stft) => Array.from({ length: n }, (_, i) => ({
    time: i * 0.2, rpm, rawLoad: load, correctedLoad: load, stft1: stft, stft2: stft, rf: 30,
}));

/** The same, but at a real log's spacing and with the trim under the caller's control, so a cell
 *  can be given a genuine time series to estimate its own autocorrelation from. */
const series = (n, rpm, load, fn, dt = 0.2) => Array.from({ length: n }, (_, i) => ({
    time: i * dt, rpm, rawLoad: load, correctedLoad: load, stft1: fn(i), stft2: fn(i), rf: 30,
}));

/**
 * A load that belongs to VE.
 *
 * `kf_rf_soll` is one table with two owners, split at row 12 (3.2 %): below it the rows are LOW
 * LOAD's, and the VE calculator refuses them outright. These tests are about the EVIDENCE, so they
 * have to be driven somewhere VE is allowed to write. 7.5 % is row 14. The refusal itself is pinned
 * separately at the end of this file.
 */
const VE_LOAD = 7.50;

const at = (m, rpm, load) => m[LOAD.indexOf(load)][RPM.indexOf(rpm)];
/**
 * PINNED TO THE STATISTICAL METHOD, because that is what the cases below are about.
 *
 * Self-share, independence, scatter and significance only run under that method — under the
 * default ('direct') a cell is written whenever it has samples, which is the whole point of it. Every
 * case here that asserts a REFUSAL would otherwise be asserting the other method's behaviour and
 * silently passing for the wrong reason once the default moved. The DIRECT side has its own section
 * at the end, including the comparison that motivated the default.
 */
const run = (log, opts) => new VECalculator().calculateNewVEMap(flat(), log,
    { applyRfKorr: false, veMethod: 'statistical', ...opts });

/** The default method, spelled out so a case that means "as shipped" cannot drift. */
const runDirect = (log, opts) => new VECalculator().calculateNewVEMap(flat(), log,
    { applyRfKorr: false, veMethod: 'direct', ...opts });

console.log('\n[one sample no longer moves a cell]');
{
    const r = run(samples(1, 2700, VE_LOAD, 1.20));
    check('no cell cleared, so there is no map', r.newMap === null, typeof r.newMap);
    // NOT 1.0 — that was the old behaviour and it was wrong to display.
    //
    // A refused cell still MEASURED something, and reporting it as exactly 1.000 made it
    // indistinguishable on LAMBDA FEEDBACK from a cell measured at no correction at all. Those are
    // opposite facts, and the one the driver needs is the reading. The gate decides what is
    // WRITTEN — `acceptedMap` and `newMap` below hold that line.
    check('the refused cell still reports what it measured',
        Math.abs(at(r.correctionMap, 2700, VE_LOAD) - 1.20) < 1e-9,
        String(at(r.correctionMap, 2700, VE_LOAD)));
    check('...while acceptedMap still says it was NOT written',
        at(r.acceptedMap, 2700, VE_LOAD) === false);
    check('...and a cell nobody drove still reads 1.000',
        at(r.correctionMap, 5300, VE_LOAD) === 1.0, String(at(r.correctionMap, 5300, VE_LOAD)));
    // 'thin-count', not 'thin-independent': the gates are tested in the order a reader would act
    // on them, and "you were barely here" comes before "what you saw was one observation".
    check('and it says WHY', at(r.rejectMap, 2700, VE_LOAD) === 'thin-count',
        at(r.rejectMap, 2700, VE_LOAD));
    // The whole point of the 2026-08-15 change, still true: the pre-gate rule wrote this cell.
    // Reproduced by hand rather than by relaxing options, because no option reopens it now.
    check('...whereas weightSum > 0.1 would have passed it',
        at(r.weightMap, 2700, VE_LOAD) > 0.1, at(r.weightMap, 2700, VE_LOAD));
}

/**
 * THE MEASUREMENT THE WHOLE GATE RESTS ON.
 *
 * Two logs of the same length, the same mean and (to a rounding) the same scatter. One is noise,
 * the other a slow sine — the shape a two-point controller actually makes. Only the ORDER differs,
 * and the ordered one carries almost no independent information.
 *
 * Any gate built on sample count or weight sum scores these identically, which is exactly how ten
 * cells on session #1 came to be written with corrections smaller than their own uncertainty.
 */
console.log('\n[the same samples in a different order are not the same evidence]');
{
    const n = 200;
    const noisy = run(series(n, 2700, VE_LOAD, i => 1.20 + jitter(i) * 0.02));
    const smooth = run(series(n, 2700, VE_LOAD, i => 1.20 + Math.sin(i * 0.05) * 0.02));

    check('same sample count', at(noisy.hitMap, 2700, VE_LOAD) === at(smooth.hitMap, 2700, VE_LOAD),
        `${at(noisy.hitMap, 2700, VE_LOAD)} vs ${at(smooth.hitMap, 2700, VE_LOAD)}`);
    check('same weight', Math.abs(at(noisy.weightMap, 2700, VE_LOAD) - at(smooth.weightMap, 2700, VE_LOAD)) < 1e-9);
    check('the unordered one is written', at(noisy.acceptedMap, 2700, VE_LOAD) === true,
        at(noisy.rejectMap, 2700, VE_LOAD));
    check('the ordered one is REFUSED', at(smooth.acceptedMap, 2700, VE_LOAD) === false);
    check('...for the right reason', at(smooth.rejectMap, 2700, VE_LOAD) === 'thin-independent',
        at(smooth.rejectMap, 2700, VE_LOAD));
}

/**
 * A log that clears nothing must not produce a map at all.
 *
 * Every refused cell keeps its stock value, so zero cleared cells means a map byte-identical to the
 * BASE — and returned as an object it was indistinguishable from a tune. The app offered SAVE and
 * WRITE, `Boolean(newMap)` recorded `tuned: true`, and a flash slot would have gone on writing the
 * BASE back to the car under a TUNED name.
 *
 * Session #903 is the real case: an EGT run reads block 3 alone, so it carries no lambda trim at
 * all, so not one sample can be binned — and it was stored with a sha256 as though it were a tune.
 */
console.log('\n[a log that earns nothing is not a tune]');
{
    const noTrim = samples(400, 2700, VE_LOAD, 1.20).map(s => ({ ...s, stft1: undefined, stft2: undefined }));
    const r = run(noTrim);
    check('an EGT-shaped log yields no map', r.newMap === null, typeof r.newMap);
    check('...and says so in the coverage', r.coverage.withEvidence === 0, r.coverage.withEvidence);
    const thin = run(samples(TOO_FEW, 2700, VE_LOAD, 1.20));
    check(`${TOO_FEW} samples everywhere yields no map either`, thin.newMap === null, typeof thin.newMap);
}

console.log('\n[a rejected cell still reports what it has]');
{
    // Enough elsewhere so SOMETHING clears and a map exists to inspect — the thin cell is the
    // subject, and it has to be readable without the whole result being withheld.
    const r = run([...samples(TOO_FEW, 2700, VE_LOAD, 1.20), ...samples(ENOUGH, 3100, VE_LOAD, 1.10)]);
    check('a thin cell is not moved', at(r.newMap.data, 2700, VE_LOAD) === 50);
    check(`hitMap reports ${TOO_FEW}, NOT 0`, at(r.hitMap, 2700, VE_LOAD) === TOO_FEW, at(r.hitMap, 2700, VE_LOAD));
    check('weightMap reports the real weight', at(r.weightMap, 2700, VE_LOAD) > TOO_FEW - 2,
        at(r.weightMap, 2700, VE_LOAD));
    const empty = run([]);
    check('a genuinely empty cell still reports 0', at(empty.hitMap, 2700, VE_LOAD) === 0);
    check('an empty log yields no map', empty.newMap === null, typeof empty.newMap);
}

console.log('\n[the gate opens where the evidence becomes independent]');
{
    const r = run(samples(ENOUGH, 2700, VE_LOAD, 1.20));
    check(`${ENOUGH} independent-enough samples: cell moves`,
        at(r.acceptedMap, 2700, VE_LOAD) === true, at(r.rejectMap, 2700, VE_LOAD));
    check('coverage counts it', r.coverage.withEvidence === 1, JSON.stringify(r.coverage));
    // A constant trim has zero scatter, so sigma is the half-step floor and the demand is realised
    // essentially in full. This is the case the floor exists to make well defined.
    check('a perfectly steady cell writes its full demand',
        Math.abs(at(r.newMap.data, 2700, VE_LOAD) - 60) < 0.05, at(r.newMap.data, 2700, VE_LOAD));
}

/**
 * Clearing the bar by a hair must move the cell by a hair.
 *
 * The old gate was a cliff: weight 4.99 wrote nothing and weight 5.01 wrote the whole correction,
 * and nothing in the evidence justified the discontinuity. The shrinkage removes it.
 */
console.log('\n[the write is damped by how much of it could be noise]');
{
    // A small correction against large scatter: significant, but not by much.
    const marginal = run(series(60, 2700, VE_LOAD, i => 1.02 + jitter(i) * 0.10));
    const confident = run(series(60, 2700, VE_LOAD, i => 1.02 + jitter(i) * 0.005));
    const mv = at(marginal.newMap?.data ?? [[]], 2700, VE_LOAD);
    const cv = at(confident.newMap?.data ?? [[]], 2700, VE_LOAD);

    check('the confident cell is written', at(confident.acceptedMap, 2700, VE_LOAD) === true,
        at(confident.rejectMap, 2700, VE_LOAD));
    check('the confident cell realises nearly all of its demand', cv > 50.9 && cv <= 51.0, String(cv));
    if (at(marginal.acceptedMap, 2700, VE_LOAD)) {
        check('the marginal cell moves LESS than its demand', mv > 50 && mv < cv, `${mv} vs ${cv}`);
    } else {
        check('the marginal cell is refused rather than written in full',
            at(marginal.rejectMap, 2700, VE_LOAD) === 'not-significant',
            at(marginal.rejectMap, 2700, VE_LOAD));
    }
}

/** A correction smaller than the uncertainty in it is noise, and writing it injects that noise. */
console.log('\n[a correction smaller than its own error is refused]');
{
    // Plenty of independent evidence, but the mean sits a whisker from 1.000 against real scatter.
    const r = run(series(300, 2700, VE_LOAD, i => 1.001 + jitter(i) * 0.05));
    check('refused', at(r.acceptedMap, 2700, VE_LOAD) === false, 'it was written');
    check('...as not-significant', at(r.rejectMap, 2700, VE_LOAD) === 'not-significant',
        at(r.rejectMap, 2700, VE_LOAD));
    check('...and the cell keeps its stock value',
        r.newMap === null || at(r.newMap.data, 2700, VE_LOAD) === 50);
}

console.log('\n[the exact autocorrelation inflation]');
{
    // Against the definition it is a closed form of, summed directly.
    const ref = (rho, n) => {
        let sum = 0;
        for (let k = 1; k < n; k++) sum += (1 - k / n) * Math.pow(rho, k);
        return 1 + 2 * sum;
    };
    let worst = 0;
    for (const rho of [0.3, 0.6, 0.85, 0.95]) {
        for (const n of [2, 3, 6, 10, 50, 200]) {
            worst = Math.max(worst, Math.abs(autocorrInflation(rho, n) - ref(rho, n)));
        }
    }
    check('matches the sum it is a closed form of', worst < 1e-9, worst.toExponential(2));
    // The asymptotic form the old gate used, which this replaces, is the large-n limit.
    const asym = (1 + 0.85) / (1 - 0.85);
    check('tends to (1+rho)/(1-rho)', Math.abs(autocorrInflation(0.85, 1e5) - asym) < 1e-3,
        autocorrInflation(0.85, 1e5));
    check('and is far below it on a real run length',
        autocorrInflation(0.85, 6) < asym / 2.5, autocorrInflation(0.85, 6));
    check('a single sample inflates nothing', autocorrInflation(0.85, 1) === 1);
    check('uncorrelated samples inflate nothing', autocorrInflation(0, 50) === 1);
    check('perfectly correlated samples are ONE observation', autocorrInflation(1, 50) === 50);
    check('monotone increasing in run length',
        [2, 3, 5, 10, 30, 100].every((n, i, a) => i === 0
            || autocorrInflation(0.85, n) > autocorrInflation(0.85, a[i - 1])));
    check('monotone increasing in rho',
        [0.1, 0.3, 0.6, 0.9].every((r, i, a) => i === 0
            || autocorrInflation(r, 20) > autocorrInflation(a[i - 1], 20)));
}

console.log('\n[the Student critical values]');
{
    check('dof 2 is 4.303', Math.abs(tCritical95(2) - 4.303) < 1e-9, tCritical95(2));
    check('dof 10 is 2.228', Math.abs(tCritical95(10) - 2.228) < 1e-9, tCritical95(10));
    check('dof 30 is 2.042', Math.abs(tCritical95(30) - 2.042) < 1e-9, tCritical95(30));
    check('it falls toward 1.96, never below', tCritical95(1e6) >= 1.959 && tCritical95(1e6) <= 1.961,
        tCritical95(1e6));
    check('monotone decreasing in dof',
        [2, 3, 5, 8, 15, 40, 200].every((d, i, a) => i === 0 || tCritical95(d) < tCritical95(a[i - 1])));
    check('below one degree of freedom it refuses almost everything', tCritical95(0.5) > 12);
    // Interpolation, not a step: a dof between two rows must land between their values.
    check('interpolates between tabulated rows',
        tCritical95(12) < tCritical95(10) && tCritical95(12) > tCritical95(15), tCritical95(12));
}

/**
 * The heatmap's middle band is this map, and nothing else.
 *
 * It means "this cell was rewritten", which is a decision the gate has already made — so it is
 * reported rather than reconstructed. Two earlier versions reconstructed it from a threshold and
 * both were wrong; a count cannot express a gate that also tests independence and significance.
 */
console.log('\n[the accepted map IS the gate]');
{
    const r = run([...samples(ENOUGH, 2700, VE_LOAD, 1.10), ...samples(3, 3100, VE_LOAD, 1.10)]);
    const trues = r.acceptedMap.flat().filter(Boolean).length;
    check('one true per cell that cleared', trues === r.coverage.withEvidence, `${trues} vs ${r.coverage.withEvidence}`);
    check('accepted where it cleared', at(r.acceptedMap, 2700, VE_LOAD) === true);
    check('refused where it did not', at(r.acceptedMap, 3100, VE_LOAD) === false);
    check('same shape as the map', r.acceptedMap.length === LOAD.length
        && r.acceptedMap.every(row => row.length === RPM.length));
}

console.log('\n[the census is the cost of the threshold]');
{
    const log = [...samples(ENOUGH, 2700, VE_LOAD, 1.10), ...samples(3, 3100, VE_LOAD, 1.10)];
    const r = run(log);
    check('withEvidence counts only cells that cleared', r.coverage.withEvidence === 1, r.coverage.withEvidence);
    check('withAnyData counts every cell touched', r.coverage.withAnyData >= 2, r.coverage.withAnyData);
    // Not the whole table. The line this feeds reads "N of TOTAL cells met the evidence gate", and
    // 480 would count the 260 cells below the seam — LOW LOAD's rows, which VE may never write —
    // as cells VE failed to earn. Measuring a corrector against ground it is forbidden to touch
    // makes the number say the opposite of what it means.
    check('total is VE’s own band, not the whole map',
        r.coverage.total === RPM.length * (LOAD.length - 13), r.coverage.total);
    check('...which is smaller than the table', r.coverage.total < RPM.length * LOAD.length);
}

/**
 * The seam itself.
 *
 * `kf_rf_soll` is ONE table. Rows 0-12 are LOW LOAD's, which derives them on evidence shaped for a
 * dwell rather than a sweep. Ownership used to be settled only at composition, in `composeVeGrid`,
 * and that left a hole: wherever LOW LOAD refused a cell for thin evidence, `owned` came out false
 * and VE's value is what reached the binary. Refusing here means such a cell keeps BASE instead.
 */
console.log('\n[the low band is not VE’s to write]');
{
    const LOW = LOAD[12];        // 3.20 %, the last row LOW LOAD owns
    const FIRST_VE = LOAD[13];   // 5.00 %, the first row VE owns

    const low = run(samples(400, 2700, LOW, 1.20));
    check('400 samples in the low band clear nothing', low.newMap === null, typeof low.newMap);
    check('...and the accepted map says refused', at(low.acceptedMap, 2700, LOW) === false);
    // Refused, not invisible: the coverage heat still has to show the band was driven, because
    // LOW LOAD judges those same samples and the driver needs to see they landed.
    check('...but the hits are still counted', at(low.hitMap, 2700, LOW) === 400, at(low.hitMap, 2700, LOW));
    check('...and they are kept out of the census', low.coverage.withAnyData === 0, low.coverage.withAnyData);

    const high = run(samples(400, 2700, FIRST_VE, 1.20));
    check('the very next row up does clear', high.newMap !== null);
    check('...and moves the cell', Math.abs(at(high.newMap.data, 2700, FIRST_VE) - 60) < 0.05,
        at(high.newMap.data, 2700, FIRST_VE));

    // Lowering the evidence gate must not buy a way in — the band is not a threshold.
    const forced = run(samples(400, 2700, LOW, 1.20), { minCellSamples: 1, minCellWeight: 0.1 });
    check('no threshold unlocks the low band', forced.newMap === null, typeof forced.newMap);
}

/**
 * An absent setting must not read as "no gate".
 *
 * The page assembles its options object unconditionally, so an untouched session hands the rf_korr
 * tuner `{ minCellSamples: undefined, minCellWeight: undefined }`. Object spread copies those keys
 * WITH their undefined values, and `count < undefined` is false — so a plain `{...DEFAULTS,...opts}`
 * left both gates on a flashable 72-cell table wide open, on every fresh session, silently.
 *
 * Asserted against the exported defaults rather than against 10 and 5.0, so the test keeps meaning
 * the same thing after the measured defaults land.
 */
console.log('\n[an absent option is not an option set to nothing]');
{
    const merged = withDefaults({ minCellSamples: undefined, minCellWeight: undefined });
    check('undefined does not overwrite minCellSamples',
        merged.minCellSamples === RF_KORR_TUNE_DEFAULTS.minCellSamples, String(merged.minCellSamples));
    check('undefined does not overwrite minCellWeight',
        merged.minCellWeight === RF_KORR_TUNE_DEFAULTS.minCellWeight, String(merged.minCellWeight));
    check('a real value still wins',
        withDefaults({ minCellSamples: 42 }).minCellSamples === 42, 'not applied');
    check('untouched fields keep their defaults',
        withDefaults({ minCellSamples: 42 }).settleSec === RF_KORR_TUNE_DEFAULTS.settleSec, 'settleSec moved');
}

/**
 * THE METHOD SWITCH, and the property that decided the default.
 *
 * The statistical gates were measured to be a PURE SUBTRACTION on a real drive: they wrote no cell
 * the DIRECT method did not, changed no value on a cell both wrote, and deleted 21 of 31. That is the
 * claim the default rests on, so it is pinned here on a fixture rather than left in a document.
 *
 * The fixture needs one thick cell and one thin one, because a claim about which cells each method
 * writes is empty if every cell is the same.
 */
console.log('\n[the method decides WHICH cells, not what they say]');
{
    // Thick: enough for either method. Thin: real evidence, but not 95 % worth of it.
    const log = [
        ...samples(ENOUGH, 2700, VE_LOAD, 1.10),
        ...samples(4, 3100, VE_LOAD, 1.10),
    ];
    // The SAME structural floor on both, or this measures the floor instead of the method.
    const stat = run(log, { minCellSamples: 3 });
    const efi = runDirect(log, { minCellSamples: 3 });

    const cells = [];
    for (let i = 0; i < stat.acceptedMap.length; i++) {
        for (let j = 0; j < stat.acceptedMap[i].length; j++) {
            cells.push([i, j]);
        }
    }
    const onlyDirect = cells.filter(([i, j]) => efi.acceptedMap[i][j] && !stat.acceptedMap[i][j]);
    const onlyStat = cells.filter(([i, j]) => stat.acceptedMap[i][j] && !efi.acceptedMap[i][j]);
    const both = cells.filter(([i, j]) => stat.acceptedMap[i][j] && efi.acceptedMap[i][j]);

    check('DIRECT writes the thin cell', onlyDirect.length > 0, 'it wrote nothing extra');
    check('the statistical method writes nothing DIRECT does not',
        onlyStat.length === 0, onlyStat.length + ' cells');
    check('...so it can only ever subtract', onlyStat.length === 0 && onlyDirect.length > 0);
    // NOT "identical". Session #923 measured them identical to 0.00e+0, but that is a fact about
    // that drive's evidence — shrinkage saturated at lambda = 1 on all ten shared cells. The
    // INVARIANT is weaker and always true: shrinkage cannot exceed authority 1.0, so the
    // statistical method never moves a shared cell further than DIRECT does, and never the other way.
    const baseMap = flat().data;
    check('a shared cell never moves FURTHER under the statistical method',
        both.length > 0 && both.every(([i, j]) => {
            const dEfi = efi.newMap.data[i][j] - baseMap[i][j];
            const dStat = stat.newMap.data[i][j] - baseMap[i][j];
            return Math.abs(dStat) <= Math.abs(dEfi) + 1e-12 && dStat * dEfi >= 0;
        }), 'a shared cell overshot DIRECT');
    // Shrinkage APPROACHES authority without reaching it: lambda = 1 - (t95/t)^2 is below 1 for
    // any finite t. On strong evidence the gap is a rounding — well under a writable table step —
    // which is why session #923 reported the two methods bit-identical on all ten shared cells.
    check('...and on strong evidence the gap is smaller than one writable step',
        both.length > 0 && both.every(
            ([i, j]) => Math.abs(efi.newMap.data[i][j] - stat.newMap.data[i][j]) < 0.0005),
        'the shared cells differ by more than half a table step');
    check('the thin cell is refused for a STATISTICAL reason, not a structural one',
        onlyDirect.every(([i, j]) => ['shared-evidence', 'scatter', 'thin-independent', 'not-significant']
            .includes(stat.rejectMap[i][j])),
        onlyDirect.map(([i, j]) => stat.rejectMap[i][j]).join(','));
}

console.log('\n[DIRECT applies AUTHORITY, and nothing else scales the step]');
{
    const log = samples(ENOUGH, 2700, VE_LOAD, 1.10);
    const full = runDirect(log);
    const half = runDirect(log, { directAuthority: 0.5 });
    const i = LOAD.indexOf(VE_LOAD), j = RPM.indexOf(2700);
    const base = flat().data[i][j];
    const dFull = full.newMap.data[i][j] / base - 1;
    const dHalf = half.newMap.data[i][j] / base - 1;
    check('authority 1.0 takes the whole demand', Math.abs(dFull) > 0, 'nothing moved');
    check('authority 0.5 takes half of it', Math.abs(dHalf / dFull - 0.5) < 1e-9, (dHalf / dFull).toFixed(6));
    check('authority 0 writes the cell unchanged',
        Math.abs(runDirect(log, { directAuthority: 0 }).newMap.data[i][j] - base) < 1e-12);
    check('a negative authority cannot invert the correction',
        runDirect(log, { directAuthority: -2 }).newMap.data[i][j] === base, 'it moved');
    check('an authority above 1 cannot amplify it',
        Math.abs(runDirect(log, { directAuthority: 5 }).newMap.data[i][j] - full.newMap.data[i][j]) < 1e-12,
        'it amplified');
}

console.log('\n[the structural refusals run under BOTH methods]');
{
    // The low band belongs to LOW LOAD whichever method is selected — it is ownership, not evidence.
    const LOW = LOAD[12];        // 3.20 %, the last row LOW LOAD owns
    const low = runDirect(samples(400, 2700, LOW, 1.20));
    check('the low band is still refused under DIRECT',
        low.acceptedMap[LOAD.indexOf(LOW)][RPM.indexOf(2700)] === false, 'it was written');
    check('...and says out-of-band',
        low.rejectMap[LOAD.indexOf(LOW)][RPM.indexOf(2700)] === 'out-of-band',
        String(low.rejectMap[LOAD.indexOf(LOW)][RPM.indexOf(2700)]));
    // And a cell nobody drove is refused for having nothing, not for failing a test.
    const none = runDirect(samples(ENOUGH, 2700, VE_LOAD, 1.10));
    check('an undriven cell says no-evidence',
        none.rejectMap[LOAD.indexOf(VE_LOAD)][RPM.indexOf(5300)] === 'no-evidence',
        String(none.rejectMap[LOAD.indexOf(VE_LOAD)][RPM.indexOf(5300)]));
    check('DIRECT still honours its own sample floor',
        runDirect(samples(2, 2700, VE_LOAD, 1.10), { minCellSamples: 3 })
            .rejectMap[LOAD.indexOf(VE_LOAD)][RPM.indexOf(2700)] === 'thin-count',
        'it was written on two samples');
}

console.log('\n[the two evidence bars, as literals]');
{
    // Both moved on 2026-08-30 and neither had anything holding it. SAMPLES stopped counting
    // grazes — it counts samples at `w >= CLAMP_MIN_WEIGHT` now, which is what makes it agree with
    // the anti-ratchet clamp about which samples a cell owns — and WEIGHT came back off 0, where it
    // had been documented as retired, because with the count fixed the two no longer measure the
    // same thing. A default that moves in a commit about something else is how a map quietly
    // changes shape, so both are pinned here where changing one has to be deliberate.
    check('DIRECT writes a cell on three samples of its own', DIRECT_MIN_SAMPLES === 3,
        String(DIRECT_MIN_SAMPLES));
    check('and on 2.5 of a sample-weight of coverage', VE_MIN_WEIGHT_DEFAULT === 2.5,
        String(VE_MIN_WEIGHT_DEFAULT));
    // The RELATION is the point, not the two numbers: three samples that each only just clear
    // CLAMP_MIN_WEIGHT carry 0.75 of weight, so the weight bar is the binding one on thin cells
    // while the count bar is the binding one on cells visited only by grazes. Neither subsumes the
    // other, and a pair that stopped overlapping would leave one of the two doing nothing.
    check('the weight bar binds beyond what three minimum-weight samples carry',
        VE_MIN_WEIGHT_DEFAULT > DIRECT_MIN_SAMPLES * 0.25,
        VE_MIN_WEIGHT_DEFAULT + ' vs ' + (DIRECT_MIN_SAMPLES * 0.25));
}


console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
