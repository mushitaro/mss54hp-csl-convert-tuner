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
    check('cell holds its stock value', at(r.newMap.data, 2700, 1.0) === 50, at(r.newMap.data, 2700, 1.0));
    check('correction reported as 1.0', at(r.correctionMap, 2700, 1.0) === 1.0);
    // The whole point of the change.
    const old = run(samples(1, 2700, 1.0, 1.20), { minCellSamples: 1, minCellWeight: 0.1 });
    check('...but it did under the old thresholds', Math.abs(at(old.newMap.data, 2700, 1.0) - 60) < 1e-9,
        at(old.newMap.data, 2700, 1.0));
}

console.log('\n[a rejected cell still reports what it has]');
{
    const r = run(samples(9, 2700, 1.0, 1.20));
    check('9 samples: cell not moved', at(r.newMap.data, 2700, 1.0) === 50);
    check('hitMap reports 9, NOT 0', at(r.hitMap, 2700, 1.0) === 9, at(r.hitMap, 2700, 1.0));
    check('weightMap reports the real weight', at(r.weightMap, 2700, 1.0) > 8, at(r.weightMap, 2700, 1.0));
    const empty = run([]);
    check('a genuinely empty cell still reports 0', at(empty.hitMap, 2700, 1.0) === 0);
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
    const moved = at(r.newMap.data, 2700, 1.0) !== 50;
    check('count alone does not open it when weight is short', !moved, 'weight ' + at(r.weightMap, 2700, 1.0).toFixed(1));
}

console.log('\n[the census is the cost of the threshold]');
{
    const log = [...samples(10, 2700, 1.0, 1.10), ...samples(3, 3100, 1.0, 1.10)];
    const r = run(log);
    check('withEvidence counts only cells that cleared', r.coverage.withEvidence === 1, r.coverage.withEvidence);
    check('withAnyData counts every cell touched', r.coverage.withAnyData >= 2, r.coverage.withAnyData);
    check('total is the whole map', r.coverage.total === RPM.length * LOAD.length, r.coverage.total);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
