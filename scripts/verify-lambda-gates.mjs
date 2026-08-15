/**
 * The lambda-shutdown gates, and the census that reports them.
 *
 * These decide which samples reach the VE map, so a wrong one is not a wrong number on a screen —
 * it moves cells. Two failure directions matter and they are not symmetric: rejecting a good sample
 * costs coverage, keeping a bad one puts a trim that was not controlling anything into the average.
 * The tests below pin both, plus the two design decisions that are easy to undo by accident:
 *
 *  - the full-load gate reads the binary's own table, so this app's WOT patch DISABLES it, and
 *  - a missing channel never rejects, because "we did not measure it" is not evidence.
 *
 * Numbers come from a real 64 KB partial (K_LA_FMAX 1.30, K_LA_FMIN 0.70, KL_LA_N flat at 1.500,
 * KF_BZ_WDK_VL patched to 102.3) so a change that only works on invented data fails here.
 */
import {
    interpCurve, interpGrid, isFullLoad, isOverLoadThreshold, isAtControllerStop, EMPTY_CENSUS,
} from '../src/lib/log-engine/lambdaGates.ts';
import { processLogData } from '../src/lib/log-engine/filter.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

/** Stock, as CSL_STOCK_WOT_THRESHOLD_MAP has it: 35/55/63/65 % over rpm, flat over coolant. */
const STOCK = {
    wotThreshold: {
        x: [1300, 2000, 3000, 4000],
        y: [48, 68, 88, 108],
        z: [[35, 55, 63, 65], [35, 55, 63, 65], [35, 55, 63, 65], [35, 55, 63, 65]],
    },
    loadThreshold: { x: [3000, 4000, 4500, 5000, 5600, 5800, 6400], y: Array(7).fill(1.5) },
    fMax: 1.30, fMin: 0.70,
};
/** The same binary after this app's WOT TH patch — every cell 102.3 %. */
const PATCHED = { ...STOCK, wotThreshold: { ...STOCK.wotThreshold, z: STOCK.wotThreshold.z.map(r => r.map(() => 102.3)) } };

console.log('\n[interpolation holds flat outside the axes]');
{
    const c = { x: [1000, 2000], y: [10, 20] };
    check('below the first breakpoint', interpCurve(c, 0) === 10);
    check('above the last', interpCurve(c, 9999) === 20);
    check('halfway', interpCurve(c, 1500) === 15);
    // Extrapolating a calibration invents data; the DME does not, so neither does this.
    check('grid corner holds', interpGrid(STOCK.wotThreshold, 500, 20) === 35);
    check('grid interpolates on rpm', Math.abs(interpGrid(STOCK.wotThreshold, 2500, 90) - 59) < 1e-9,
        interpGrid(STOCK.wotThreshold, 2500, 90));
}

console.log('\n[full load: stock rejects, patched does not]');
{
    check('70 % throttle at 3000 rpm is full load on stock', isFullLoad(STOCK, 70, 3000, 90));
    check('30 % throttle is not', !isFullLoad(STOCK, 30, 3000, 90));
    // The threshold is where the DME's own comparison flips, so the sample sitting exactly on it is
    // the ambiguous one and is rejected.
    check('exactly on the threshold rejects', isFullLoad(STOCK, 63, 3000, 90));
    // The whole point of the patch. If this ever fails, patch-on logs are being gutted.
    check('the SAME sample is not full load once the WOT patch is in the binary',
        !isFullLoad(PATCHED, 70, 3000, 90));
    check('nothing reaches 102.3 %', !isFullLoad(PATCHED, 100, 6000, 90));
}

console.log('\n[a channel we do not have never rejects]');
{
    // Silence must not become evidence: a CSV, or any DS2 log from before wdk1 was decoded, simply
    // cannot answer this question, and the honest answer for a rejecting gate is "no".
    check('no wdk1 -> not full load', !isFullLoad(STOCK, undefined, 6000, 90));
    check('no rf -> not over the load threshold', !isOverLoadThreshold(STOCK, undefined, 6000));
    // Coolant IS an axis, but this calibration is flat over it, so a missing coolant reading cannot
    // change the verdict on a real binary — worth pinning, because it means the fallback below is
    // only ever exercised by a car whose table is not flat.
    check('a flat-over-coolant table gives the same answer with or without coolant',
        isFullLoad(STOCK, 60, 1300, undefined) === isFullLoad(STOCK, 60, 1300, 90));
    // When it is NOT flat, the fallback takes the warm end: the highest threshold, i.e. the one that
    // rejects the least. Guessing cold would throw away samples on the strength of a reading we
    // never took.
    const sloped = { ...STOCK, wotThreshold: { ...STOCK.wotThreshold, z: [[20, 20, 20, 20], [40, 40, 40, 40], [60, 60, 60, 60], [80, 80, 80, 80]] } };
    check('no coolant takes the warm end, which rejects the least',
        !isFullLoad(sloped, 70, 3000, undefined) && isFullLoad(sloped, 70, 3000, 48));
}

console.log('\n[load threshold: real calibration puts it out of reach]');
{
    // Measured 1.500 flat, and relative filling runs 0.3-1.1, so this gate is expected to be inert.
    // Kept, and tested, because it is calibration — another car's binary may differ.
    check('110 % filling is still under a 1.5 threshold', !isOverLoadThreshold(STOCK, 110, 4000));
    const low = { ...STOCK, loadThreshold: { x: [1000, 7000], y: [0.8, 0.8] } };
    check('a binary that DID set it low rejects', isOverLoadThreshold(low, 90, 4000));
}

console.log('\n[controller stops: pinned is not measured]');
{
    check('1.30 is the upper stop', isAtControllerStop(STOCK, 1.30, 1.0));
    check('0.70 is the lower stop', isAtControllerStop(STOCK, 1.0, 0.70));
    check('either bank pins the sample', isAtControllerStop(STOCK, 1.0, 1.30));
    check('1.20 is a working controller', !isAtControllerStop(STOCK, 1.20, 1.05));
    // The value arrives quantised at 1/32768 and the clamp is stored in the same units, so an exact
    // equality test would miss a sample one count inside the rail.
    check('one count inside the rail still counts as pinned',
        isAtControllerStop(STOCK, 1.30 - 3e-5, 1.0));
}

console.log('\n[the census adds up, and says which gate did it]');
{
    const base = { rpm: 3000, rawLoad: 5, stft1: 1.05, stft2: 1.05, coolantTemp: 90, rf: 60, wdk1: 20 };
    const log = [
        ...Array.from({ length: 5 }, (_, i) => ({ ...base, time: i, coolantTemp: 40 })),      // cold
        ...Array.from({ length: 3 }, (_, i) => ({ ...base, time: 10 + i, wdk1: 80 })),        // full load
        ...Array.from({ length: 2 }, (_, i) => ({ ...base, time: 20 + i, stft1: 1.30 })),     // pinned
        ...Array.from({ length: 4 }, (_, i) => ({ ...base, time: 30 + i })),                  // kept
    ];
    const cfg = { enableCorrection: false, enableMinTemp: true, minTemp: 65, enableIdle: true, idleRpm: 1000, enableTransient: false, transientWindow: 4, rpmStableThreshold: 10, tpsStableThreshold: 5 };
    const r = processLogData(log, 'test', cfg, undefined, STOCK);
    check('valid + dropped = total', r.validCount + r.droppedCount === log.length,
        `${r.validCount}+${r.droppedCount} vs ${log.length}`);
    check('the census sums to droppedCount',
        Object.values(r.dropCensus).reduce((a, b) => a + b, 0) === r.droppedCount, JSON.stringify(r.dropCensus));
    check('cold engine counted', r.dropCensus.coldEngine === 5, r.dropCensus.coldEngine);
    check('full load counted', r.dropCensus.fullLoad === 3, r.dropCensus.fullLoad);
    check('controller stop counted', r.dropCensus.controllerStop === 2, r.dropCensus.controllerStop);
    check('four survived', r.validCount === 4, r.validCount);

    // Without the limits the three lambda gates are absent, not silently permissive-by-default.
    const noLimits = processLogData(log, 'test', cfg, undefined, null);
    check('no binary -> lambda gates do not run', noLimits.dropCensus.fullLoad === 0 && noLimits.dropCensus.controllerStop === 0);
    check('no binary -> those samples are KEPT', noLimits.validCount === 9, noLimits.validCount);
    check('an untouched census is all zeros', Object.values(EMPTY_CENSUS).every(v => v === 0));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
