/**
 * Incremental must equal batch. Exactly.
 *
 * A live run now filters and bins only the samples that arrived, instead of redoing the whole drive
 * twice a second. That is only allowed to be faster — it is not allowed to be different, because the
 * same code path also produces the map that gets written to an ECU.
 *
 * The design makes that true by construction rather than by keeping two implementations in step:
 * `processLogData` resumes its own loop, and the binning is the same `accumulatePoint` in both
 * cases. This file exists because "by construction" is a claim, and the claim is worth one test:
 * feed the same log in one pass and in many, and require the results to be identical — not close,
 * identical, since it is the same arithmetic in the same order.
 *
 * Run against a real drive (session #902, 1600 samples) when the stored log is present, and against
 * a synthetic one otherwise, so the check works on a fresh clone.
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { processLogData } from '../src/lib/log-engine/filter.ts';
import { VECalculator } from '../src/lib/ve-calculator/calculator.ts';
import { resolveRfKorr } from '../src/lib/types.ts';
import { APP_CONFIG } from '../src/config/constants.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

const STORED = 'C:/Users/kazuh/AppData/Local/Temp/claude/C--Users-kazuh-E46M3CSL-TuningTool/'
    + 'ae1d88c3-cf0b-47ab-bbc8-9826efb12fdf/scratchpad/s902.json';

function realLog() {
    if (!existsSync(STORED)) return null;
    const row = JSON.parse(readFileSync(STORED, 'utf8'))[0].results[0];
    return JSON.parse(gunzipSync(Buffer.from(row.L, 'hex')).toString('utf8'));
}

/** Enough shape to exercise every branch: a warm-up, idle, steady pulls and transients. */
function syntheticLog(n = 900) {
    return Array.from({ length: n }, (_, i) => {
        const t = i * 0.25;
        const pulling = Math.sin(t / 9) > 0;
        return {
            time: t,
            rpm: pulling ? 2400 + Math.sin(t) * 900 : 800 + Math.sin(t * 3) * 60,
            rawLoad: pulling ? 2.2 + Math.sin(t * 1.3) * 0.9 : 0.8,
            stft1: 1.04 + Math.sin(t * 0.7) * 0.05,
            stft2: 1.02 + Math.cos(t * 0.6) * 0.05,
            coolantTemp: Math.min(92, 40 + t * 1.5),
            rf: pulling ? 70 + Math.sin(t) * 20 : 12,
            exhaustTemp: Math.round((300 + (pulling ? 400 : 0)) / 16) * 16,
            wdk1: pulling ? 45 : 4,
        };
    });
}

const CFG = {
    enableCorrection: true, enableMinTemp: true, minTemp: 65, enableIdle: true, idleRpm: 1000,
    enableTransient: true, transientWindow: 4, rpmStableThreshold: 10, tpsStableThreshold: 5,
};
const TABLE = APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;
const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const flatMap = () => ({ xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => 50)) });

/** The batch answer: one call, no resume. */
const batch = log => processLogData(log, 'x', CFG, TABLE, null);

/** The live answer: the log revealed a few samples at a time, resuming each time. */
function incremental(log, chunk) {
    let out = null;
    for (let end = 0; end < log.length;) {
        end = Math.min(log.length, end + chunk);
        out = processLogData(log.slice(0, end), 'x', CFG, TABLE, null, out?.resume);
    }
    return out;
}

const sameNums = (a, b, eps = 0) => a.length === b.length
    && a.every((v, i) => (Array.isArray(v) ? sameNums(v, b[i], eps) : Math.abs(v - b[i]) <= eps));

for (const [label, log] of [['session #902', realLog()], ['synthetic', syntheticLog()]]) {
    if (!log) { console.log(`\n[${label}] not present, skipped`); continue; }
    console.log(`\n[${label}: ${log.length} samples]`);

    const b = batch(log);
    // Three chunk sizes, because an off-by-one in the resume would survive one of them. 1 is the
    // adversarial case: every sample is its own pass, so any cross-sample state that is not carried
    // shows up immediately.
    for (const chunk of [1, 7, 250]) {
        const inc = incremental(log, chunk);
        check(`chunk ${chunk}: same valid count`, inc.validCount === b.validCount,
            `${inc.validCount} vs ${b.validCount}`);
        check(`chunk ${chunk}: same drop census`,
            JSON.stringify(inc.dropCensus) === JSON.stringify(b.dropCensus),
            `${JSON.stringify(inc.dropCensus)} vs ${JSON.stringify(b.dropCensus)}`);
        check(`chunk ${chunk}: same rf_korr sample set`, inc.rfKorrData.length === b.rfKorrData.length,
            `${inc.rfKorrData.length} vs ${b.rfKorrData.length}`);
        // Sample-for-sample, not just counts: the transient test looks back into the raw array, so a
        // resume that lost the prefix would keep the wrong ones while keeping the right number.
        check(`chunk ${chunk}: same samples, in order`,
            inc.data.every((p, i) => p.time === b.data[i].time && p.correctedLoad === b.data[i].correctedLoad));
    }

    // And the map the whole thing exists to produce.
    const calc = new VECalculator();
    const map = flatMap();
    const plan = resolveRfKorr({});
    const annotated = calc.annotateRfKorr(map, b.data, null);
    const gridBatch = calc.createGrid();
    for (const p of annotated) calc.accumulatePoint(gridBatch, p, plan, null);
    const wantMap = calc.finalizeGrid(map, gridBatch, {});

    const gridLive = calc.createGrid();
    let consumed = 0;
    const incLog = incremental(log, 13);
    // Bin in the same drip-feed the live path uses, annotating one sample at a time.
    while (consumed < incLog.data.length) {
        const upto = Math.min(incLog.data.length, consumed + 13);
        for (let i = consumed; i < upto; i++) {
            calc.accumulatePoint(gridLive, calc.annotateRfKorrPoint(map, incLog.data[i], null), plan, null);
        }
        consumed = upto;
        calc.finalizeGrid(map, gridLive, {});   // finalising must not disturb the grid
    }
    const gotMap = calc.finalizeGrid(map, gridLive, {});

    check('VE map identical', sameNums(wantMap.newMap.data, gotMap.newMap.data), 'cell values differ');
    check('hit map identical', sameNums(wantMap.hitMap, gotMap.hitMap));
    check('weight map identical', sameNums(wantMap.weightMap, gotMap.weightMap));
    check('coverage identical', JSON.stringify(wantMap.coverage) === JSON.stringify(gotMap.coverage),
        `${JSON.stringify(gotMap.coverage)} vs ${JSON.stringify(wantMap.coverage)}`);
    // Finalising is called on every flush, so it had better be a read.
    check('repeated finalize is stable', sameNums(gotMap.newMap.data, calc.finalizeGrid(map, gridLive, {}).newMap.data));
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
