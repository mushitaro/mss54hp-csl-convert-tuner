/**
 * The VE evidence gate.
 *
 * Until 2026-08-15 the map had no sample threshold at all: the only test was `weightSum > 0.1`, and
 * weightSum is a sum of bilinear corner weights, so ONE sample landing squarely on a cell scored
 * 1.0 and moved it. The 10/30 pair that looked like thresholds were heatmap bands and gated nothing.
 *
 * The subtle half is what a REJECTED cell reports. Before the gate, the reject branch could only be
 * reached with no samples at all, so pushing 0 hits was the truth. Now a cell can hold nine samples
 * and still be refused — and reporting that as 0 would erase the difference between "you have never
 * driven here" and "drive here again", which is the whole signal the heatmap exists to give.
 */
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { APP_CONFIG } from '../src/config/constants.ts';
import { RF_KORR_TUNE_DEFAULTS, withDefaults } from '../src/lib/ve-calculator/rfKorrTuner.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const flat = () => ({ xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => 50)) });

/** n samples landing exactly on one axis intersection, so each contributes weight 1.0. */
const samples = (n, rpm, load, stft) => Array.from({ length: n }, (_, i) => ({
    time: i, rpm, rawLoad: load, correctedLoad: load, stft1: stft, stft2: stft, rf: 30,
}));

const at = (m, rpm, load) => m[LOAD.indexOf(load)][RPM.indexOf(rpm)];
const run = (log, opts) => new VECalculator().calculateNewVEMap(flat(), log, { applyRfKorr: false, ...opts });

console.log('\n[one sample no longer moves a cell]');
{
    const r = run(samples(1, 2700, 1.0, 1.20));
    check('no cell cleared, so there is no map', r.newMap === null, typeof r.newMap);
    check('correction reported as 1.0', at(r.correctionMap, 2700, 1.0) === 1.0);
    // The whole point of the change.
    const old = run(samples(1, 2700, 1.0, 1.20), { minCellSamples: 1, minCellWeight: 0.1 });
    check('...but it did under the old thresholds', Math.abs(at(old.newMap.data, 2700, 1.0) - 60) < 1e-9,
        at(old.newMap.data, 2700, 1.0));
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
    const noTrim = samples(400, 2700, 1.0, 1.20).map(s => ({ ...s, stft1: undefined, stft2: undefined }));
    const r = run(noTrim);
    check('an EGT-shaped log yields no map', r.newMap === null, typeof r.newMap);
    check('...and says so in the coverage', r.coverage.withEvidence === 0, r.coverage.withEvidence);
    // Not a rule about trim — an absence of one. 400 samples of a cell that is one short of the
    // threshold reaches the same verdict for the same reason.
    const thin = run(samples(9, 2700, 1.0, 1.20));
    check('nine samples everywhere yields no map either', thin.newMap === null, typeof thin.newMap);
}

console.log('\n[a rejected cell still reports what it has]');
{
    // Ten elsewhere so SOMETHING clears and a map exists to inspect — the nine-sample cell is the
    // subject, and it has to be readable without the whole result being withheld.
    const r = run([...samples(9, 2700, 1.0, 1.20), ...samples(10, 3100, 1.0, 1.10)]);
    check('9 samples: cell not moved', at(r.newMap.data, 2700, 1.0) === 50);
    check('hitMap reports 9, NOT 0', at(r.hitMap, 2700, 1.0) === 9, at(r.hitMap, 2700, 1.0));
    check('weightMap reports the real weight', at(r.weightMap, 2700, 1.0) > 8, at(r.weightMap, 2700, 1.0));
    const empty = run([]);
    check('a genuinely empty cell still reports 0', at(empty.hitMap, 2700, 1.0) === 0);
    check('an empty log yields no map', empty.newMap === null, typeof empty.newMap);
}

console.log('\n[the gate opens at the threshold]');
{
    const r = run(samples(10, 2700, 1.0, 1.20));
    check('10 samples: cell moves', Math.abs(at(r.newMap.data, 2700, 1.0) - 60) < 1e-9, at(r.newMap.data, 2700, 1.0));
    check('coverage counts it', r.coverage.withEvidence === 1, JSON.stringify(r.coverage));
}

console.log('\n[both conditions, not either]');
{
    // 20 samples midway between two rpm columns: plenty of count, weight split across neighbours.
    const mid = (RPM[RPM.indexOf(2700)] + RPM[RPM.indexOf(2900)]) / 2;
    const r = run(samples(20, mid, 1.0, 1.20), { minCellWeight: 15 });
    check('count alone does not open it when weight is short',
        r.coverage.withEvidence === 0 && r.newMap === null,
        'weight ' + at(r.weightMap, 2700, 1.0).toFixed(1) + ', cleared ' + r.coverage.withEvidence);
}

console.log('\n[the census is the cost of the threshold]');
{
    const log = [...samples(10, 2700, 1.0, 1.10), ...samples(3, 3100, 1.0, 1.10)];
    const r = run(log);
    check('withEvidence counts only cells that cleared', r.coverage.withEvidence === 1, r.coverage.withEvidence);
    check('withAnyData counts every cell touched', r.coverage.withAnyData >= 2, r.coverage.withAnyData);
    check('total is the whole map', r.coverage.total === RPM.length * LOAD.length, r.coverage.total);
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

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
