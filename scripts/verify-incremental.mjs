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
import { resolveRfKorr, resolveTransientWindow } from '../src/lib/types.ts';
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

/**
 * A deterministic pseudo-random stream in [-1, 1].
 *
 * The trim in these fixtures used to be a pure sinusoid, which is a perfectly autocorrelated
 * series: the evidence gate now measures that (rho approaches 1), concludes the whole cell is one
 * observation, and writes nothing — leaving this file comparing two null maps and proving nothing.
 * Real trim carries sample-to-sample noise on top of the limit cycle, so the fixture must too.
 *
 * Hash of the INDEX rather than a seeded generator, so a sample's noise depends only on which
 * sample it is. A generator advanced by iteration order would produce a different log when the
 * live path consumed it in a different order, which is the very thing this file is checking.
 */
function jitter(i) {
    let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
}

/** Enough shape to exercise every branch: a warm-up, idle, steady pulls and transients. */
function syntheticLog(n = 900) {
    return Array.from({ length: n }, (_, i) => {
        const t = i * 0.25;
        const dwell = i >= n * (2 / 3);
        const pulling = !dwell && Math.sin(t / 9) > 0;
        return {
            time: t,
            // A SWEEP, and then a DWELL.
            //
            // The pulls have to land ABOVE the LOW LOAD seam (row 12, 3.2 %), or the VE
            // calculator refuses every one of them and there is no map to compare. Idle stays
            // at 0.8, which is LOW LOAD's band: a log carrying both is exactly what the split
            // is for.
            //
            // The last third holds 2700 rpm at 7.5 % — an axis crossing — because a sweep
            // earns nothing under the evidence gate and never did: rpm moving continuously
            // spreads every sample over four cells and the autocorrelation gate then finds one
            // observation, not three hundred. Without a stretch of steady state this file
            // compares two null maps. That is the same thing the gate asks a driver for, so the
            // fixture is now shaped like a drive that would actually earn a cell.
            rpm: dwell ? 2700 : (pulling ? 2400 + Math.sin(t) * 900 : 800 + Math.sin(t * 3) * 60),
            rawLoad: dwell ? 7.5 : (pulling ? 8.2 + Math.sin(t * 1.3) * 0.9 : 0.8),
            // Limit cycle PLUS per-sample noise. Without the second term the series is
            // perfectly predictable, and the autocorrelation gate correctly refuses every cell.
            stft1: 1.04 + Math.sin(t * 0.7) * 0.05 + jitter(i) * 0.02,
            stft2: 1.02 + Math.cos(t * 0.6) * 0.05 + jitter(i + 7919) * 0.02,
            coolantTemp: Math.min(92, 40 + t * 1.5),
            rf: (pulling || dwell) ? 70 + Math.sin(t) * 20 : 12,
            exhaustTemp: Math.round((300 + ((pulling || dwell) ? 400 : 0)) / 16) * 16,
            wdk1: (pulling || dwell) ? 45 : 4,
        };
    });
}

/**
 * The same drive on a link whose rate is NOT constant.
 *
 * `syntheticLog` steps time by exactly 0.25 s, so every prefix of it measures exactly 4.00 Hz and a
 * seconds-based look-back converts to the same sample count however much of the log you have seen.
 * That makes it useless for the question being asked here. A real DS2 link is not like that: it
 * retries, it slows when a block is added, and #904 measured 2.95 Hz against a predicted 3.03.
 *
 * So this one starts fast and finishes slow, deterministically. Its first 300 samples measure about
 * 5 Hz and the whole log about 3.3, which is exactly the spread that makes an early flush and a
 * batch pass disagree about how many samples two seconds is.
 */
function jitteryLog(n = 900) {
    const out = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
        const dwell = i >= n * (2 / 3);
        const pulling = !dwell && Math.sin(t / 9) > 0;
        out.push({
            time: t,
            // A SWEEP, and then a DWELL.
            //
            // The pulls have to land ABOVE the LOW LOAD seam (row 12, 3.2 %), or the VE
            // calculator refuses every one of them and there is no map to compare. Idle stays
            // at 0.8, which is LOW LOAD's band: a log carrying both is exactly what the split
            // is for.
            //
            // The last third holds 2700 rpm at 7.5 % — an axis crossing — because a sweep
            // earns nothing under the evidence gate and never did: rpm moving continuously
            // spreads every sample over four cells and the autocorrelation gate then finds one
            // observation, not three hundred. Without a stretch of steady state this file
            // compares two null maps. That is the same thing the gate asks a driver for, so the
            // fixture is now shaped like a drive that would actually earn a cell.
            rpm: dwell ? 2700 : (pulling ? 2400 + Math.sin(t) * 900 : 800 + Math.sin(t * 3) * 60),
            rawLoad: dwell ? 7.5 : (pulling ? 8.2 + Math.sin(t * 1.3) * 0.9 : 0.8),
            // Limit cycle PLUS per-sample noise. Without the second term the series is
            // perfectly predictable, and the autocorrelation gate correctly refuses every cell.
            stft1: 1.04 + Math.sin(t * 0.7) * 0.05 + jitter(i) * 0.02,
            stft2: 1.02 + Math.cos(t * 0.6) * 0.05 + jitter(i + 7919) * 0.02,
            coolantTemp: Math.min(92, 40 + t * 1.5),
            rf: (pulling || dwell) ? 70 + Math.sin(t) * 20 : 12,
            exhaustTemp: Math.round((300 + ((pulling || dwell) ? 400 : 0)) / 16) * 16,
            wdk1: (pulling || dwell) ? 45 : 4,
        });
        // Ramps 0.20 s -> 0.40 s across the log, plus a repeating stutter. No Math.random: a test
        // that cannot be reproduced cannot be debugged.
        t += 0.20 + (0.20 * i) / n + (i % 7 === 0 ? 0.09 : 0);
    }
    return out;
}

const CFG = {
    enableCorrection: true, enableMinTemp: true, minTemp: 65,
    enableTransient: true, transientWindow: 4, rpmStableThreshold: 10, tpsStableThreshold: 5,
};

/**
 * The same filters, with the transient wait expressed in SECONDS.
 *
 * This is the case the frames config cannot exercise: the look-back is now derived from the log's
 * own measured rate, and a resumed call has seen fewer samples than a batch one, so it measures a
 * slightly different rate. If that ever rounds to a different number of samples, batch and live
 * disagree — and on the live path there is no full reprocess afterwards to paper over it, so the
 * map on screen at STOP is the map that gets saved.
 */
const CFG_SEC = { ...CFG, transientSettleSec: 2.0 };
const TABLE = APP_CONFIG.MSS54HP.INTERPOLATION_TABLE;
const RPM = APP_CONFIG.MSS54HP.AXIS_RPM;
const LOAD = APP_CONFIG.MSS54HP.AXIS_LOAD;
const flatMap = () => ({ xAxis: RPM, yAxis: LOAD, data: LOAD.map(() => RPM.map(() => 50)) });

/** The batch answer: one call, no resume. */
const batch = (log, cfg = CFG) => processLogData(log, 'x', cfg, TABLE, null);

/** The live answer: the log revealed a few samples at a time, resuming each time. */
function incremental(log, chunk, cfg = CFG) {
    let out = null;
    for (let end = 0; end < log.length;) {
        end = Math.min(log.length, end + chunk);
        out = processLogData(log.slice(0, end), 'x', cfg, TABLE, null, out?.resume);
    }
    return out;
}

const sameNums = (a, b, eps = 0) => a.length === b.length
    && a.every((v, i) => (Array.isArray(v) ? sameNums(v, b[i], eps) : Math.abs(v - b[i]) <= eps));

for (const [label, log] of [['session #902', realLog()], ['synthetic', syntheticLog()], ['jittery rate', jitteryLog()]]) {
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

    // The seconds-based wait, over the same chunk sizes. A live run freezes nothing: every flush
    // re-measures the rate off a longer log, so this is where a converted window would drift.
    {
        const bSec = batch(log, CFG_SEC);
        for (const chunk of [1, 7, 250]) {
            const inc = incremental(log, chunk, CFG_SEC);
            check(`settle 2.0s, chunk ${chunk}: same valid count`, inc.validCount === bSec.validCount,
                `${inc.validCount} vs ${bSec.validCount}`);
            check(`settle 2.0s, chunk ${chunk}: same samples, in order`,
                inc.data.length === bSec.data.length
                && inc.data.every((p, i) => p.time === bSec.data[i].time));
        }
        // And that the seconds config is actually doing something different from the frames one —
        // a test that passes because both paths ignored the setting would prove nothing.
        check('seconds and frames select different sample sets',
            bSec.validCount !== batch(log, CFG).validCount,
            `both ${bSec.validCount} — the setting had no effect`);
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

    // Null-safe, and the fixture is built so this side is NOT null: two absent maps would compare
    // equal and prove nothing, so existence and equality are checked separately.
    check('the fixture earns a map at all', wantMap.newMap !== null,
        'no cell cleared the gate — this file would be comparing two nulls');
    check('VE map identical',
        (wantMap.newMap === null) === (gotMap.newMap === null)
        && (wantMap.newMap === null || sameNums(wantMap.newMap.data, gotMap.newMap.data)),
        'cell values differ');
    check('hit map identical', sameNums(wantMap.hitMap, gotMap.hitMap));
    check('weight map identical', sameNums(wantMap.weightMap, gotMap.weightMap));
    // The heatmap paints from this one, and a live run paints it while the car is still moving.
    check('accepted map identical',
        JSON.stringify(wantMap.acceptedMap) === JSON.stringify(gotMap.acceptedMap), 'cells differ');
    check('coverage identical', JSON.stringify(wantMap.coverage) === JSON.stringify(gotMap.coverage),
        `${JSON.stringify(gotMap.coverage)} vs ${JSON.stringify(wantMap.coverage)}`);
    // Finalising is called on every flush, so it had better be a read.
    check('repeated finalize is stable', gotMap.newMap !== null
        && sameNums(gotMap.newMap.data, calc.finalizeGrid(map, gridLive, {}).newMap.data));
    // The autocorrelation statistics accumulate per sample behind a `prevTime` cursor, which makes
    // them the part of the grid most likely to differ between a drip feed and a single pass.
    check('lag-pair counts identical', sameNums(
        gridBatch.map(r => r.map(c => c.lagPairs)),
        gridLive.map(r => r.map(c => c.lagPairs))), 'the autocorrelation cursor drifted');
    check('lag cross-products identical', sameNums(
        gridBatch.map(r => r.map(c => c.sumLagAB)),
        gridLive.map(r => r.map(c => c.sumLagAB))), 'the autocorrelation sums drifted');
}

/**
 * The seconds/samples display conversion. Display only — the filter never calls it — but it is what
 * the panel puts on screen beside the slider, and a wrong number there is a wrong instruction.
 */
console.log('\n[settle time, shown as samples]');
{
    const legacy = { transientWindow: 4 };
    check('a config from before the setting keeps its stored count',
        resolveTransientWindow(legacy, 2.95) === 4, String(resolveTransientWindow(legacy, 2.95)));
    check('2.0 s at 2.95 Hz is 6 samples',
        resolveTransientWindow({ transientWindow: 4, transientSettleSec: 2.0 }, 2.95) === 6,
        String(resolveTransientWindow({ transientWindow: 4, transientSettleSec: 2.0 }, 2.95)));
    // The same setting on the retired EGT profile's rate — the 2.5x that made a sample count the
    // wrong unit in the first place.
    check('2.0 s at 6.60 Hz is 13 samples',
        resolveTransientWindow({ transientWindow: 4, transientSettleSec: 2.0 }, 6.60) === 13,
        String(resolveTransientWindow({ transientWindow: 4, transientSettleSec: 2.0 }, 6.60)));
    check('no rate to convert at reports nothing rather than guessing',
        resolveTransientWindow({ transientWindow: 4, transientSettleSec: 2.0 }, undefined) === undefined,
        'a number was invented');
}

console.log('\n[a resume belongs to ONE log, and says which]');
{
    // The state a live flush hands back carries the identity of the log it was taken from. Without
    // it the only guard was `raw.length >= consumed`, which a SHORTER new log fails safely and a
    // LONGER new log passes — starting the loop past the end of the new drive and keeping the
    // previous one's filtered samples. A VE map built from two drives, with nothing to show for it.
    const LOG = realLog() ?? syntheticLog();
    const first = batch(LOG.slice(0, 200));
    check('a resume names its log', first.resume.logId === 'x', String(first.resume.logId));
    check('the count it stands for is the log it saw', first.resume.consumed === 200,
        String(first.resume.consumed));

    // What useLogFile now refuses, expressed as the check it performs.
    const usable = (resume, name, length) =>
        Boolean(resume && resume.logId === name && length >= resume.consumed);
    check('the same log, longer -> resume', usable(first.resume, 'x', 260));
    check('the same log, shorter -> full pass', !usable(first.resume, 'x', 100));
    check('a DIFFERENT log, longer -> full pass', !usable(first.resume, 'other.csv', 900));
    check('a different log, shorter -> full pass', !usable(first.resume, 'other.csv', 100));

    // And the thing the guard protects, on two genuinely different drives: the state from log A,
    // resumed onto log B, keeps A's filtered samples and never looks at B's first 200. Proven
    // rather than asserted — this is exactly what the length test alone allowed through.
    const otherLog = jitteryLog(260);
    const wrong = processLogData(otherLog, 'other.csv', CFG, TABLE, null, first.resume);
    const clean = batch(otherLog);
    check('resuming across logs really does corrupt the result',
        wrong.data.length !== clean.data.length || wrong.droppedCount !== clean.droppedCount,
        `${wrong.data.length}/${wrong.droppedCount} vs ${clean.data.length}/${clean.droppedCount}`);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
